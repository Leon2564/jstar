"""Enroll each talent's cloned voice with a runtime TTS vendor (#73, docs/tts.md).

    npm run voice:enroll -- --provider qwen [--dry-run] [--stars mahiro,nana] [--text on|off] [--force]
    npm run voice:enroll -- --provider byteplus [--dry-run] ...
    npm run voice:enroll -- --provider fish [--dry-run] [--refs 3] ...

For every talent: choose a 15–20 s reference from her own denoised speech (the local pipeline's clips: prep.py →
denoise.py → speakers.py; never a held-out clip, which the pilot's likeness judge compares against), prefer one
continuous stretch of the recording, otherwise join her best clips with short pauses; bring it to −20 LUFS with a
−1 dBFS peak, resample to 24 kHz mono 16-bit WAV, and check it against both vendors' rules (duration, rate, mono,
size, ≥ 3 s continuous speech, no pause > 2 s). `--dry-run` stops there, scores the reference (ECAPA likeness to
her held-out clips, SNR, loudness) and calls nothing.

Without --dry-run the reference is uploaded to that vendor's enrollment endpoint — the only place her audio is ever
sent — and the voice id is written to tools/voice/out/<provider>-voices.json (gitignored), and the TTS_VOICES value
for the Worker is printed. Keys come from the environment or the main checkout's `.env.dashscope.local`
(DASHSCOPE_API_KEY) / `.env.fish.local` (FISH_API_KEY) / `.env.byteplus-voice.local` (BYTEPLUS_VOICE_API_KEY, and BYTEPLUS_SPEAKERS='{"mahiro":"S_…"}'
for prepaid slots; without it postpaid ids `jstar-<star>-v1` are created). Keys are never printed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from common import MAIN, MODELS, STARS, TOOLS_DIR
from refs import load_manifest, split

OUT = TOOLS_DIR / "out"
REFS = OUT / "refs"
SR_IN, SR_OUT = 48000, 24000
TARGET_LUFS, PEAK_DB = -20.0, -1.0
MIN_S, GOAL_S, MAX_S = 15.0, 18.0, 19.5
JOIN_GAP_S = 0.45      # silence between clips that were not adjacent in the recording
MAX_KEEP_GAP_S = 0.8   # a real pause inside a continuous stretch, kept up to this long

QWEN_URL = os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope-intl.aliyuncs.com/api/v1").rstrip("/") + "/services/audio/tts/customization"
QWEN_TARGET = MODELS["runtimeQwen"]["model"]
BP_BASE = os.environ.get("BYTEPLUS_VOICE_BASE", "https://voice.ap-southeast-1.bytepluses.com/api/v3/tts").rstrip("/")
BP_LANG = {"zh": 0, "en": 1, "ja": 2, "ko": 8}

# Both vendors' documented reference rules (docs/tts.md): Qwen 10–20 s recommended, ≤ 60 s, ≥ 24 kHz, mono, ≤ 10 MB,
# ≥ 3 s continuous speech, other pauses ≤ 2 s; BytePlus ≤ 10 MB, 10–15 s suggested (VR 2.0: 14–30 s).
RULES = {"min_s": 10.0, "max_s": 20.0, "min_rate": 24000, "max_bytes": 10 * 1024 * 1024, "min_continuous_s": 3.0, "max_pause_s": 2.0}


# ---------------------------------------------------------------- choosing her reference

def quality(r: dict) -> float:
    """One clip: her own voice (speaker similarity), Whisper's confidence, no bumps."""
    return r.get("spk_sim", 0.0) + 0.3 * r["avg_logprob"] - 0.01 * max(0.0, r.get("crest_db", 0.0) - 18.0)


def runs(star: str, exclude: frozenset = frozenset()) -> list[list[dict]]:
    """Stretches of the recording where consecutive clips are all hers and clean (refs.split's reference pool),
    with at most 1.5 s between them: continuous speech of hers. Clips in `exclude` (already in a reference) are not."""
    pool, _ = split(star)
    ok = {r["path"] for r in pool} - exclude
    out: list[list[dict]] = []
    cur: list[dict] = []
    for r in load_manifest(star):
        if r["path"] in ok and cur and r["start"] - (cur[-1]["start"] + cur[-1]["dur"]) <= 1.5:
            cur.append(r)
            continue
        if cur:
            out.append(cur)
        cur = [r] if r["path"] in ok else []
    if cur:
        out.append(cur)
    return out


def kept_gap(prev: dict, r: dict) -> float:
    """The pause kept between two clips that follow each other in the recording."""
    return min(max(r["start"] - (prev["start"] + prev["dur"]), 0.15), MAX_KEEP_GAP_S)


def choose(star: str, exclude: frozenset = frozenset()) -> dict:
    """The reference plan: a continuous stretch of 15–20 s if she has one (best quality first), else her best clips
    in recording order, joined, until about 18 s. `exclude`: clips already used by another reference of hers."""
    stretches = []
    for run in runs(star, exclude):
        # every window of consecutive clips inside the run whose length, pauses included, is 15–20 s
        for i in range(len(run)):
            tot = 0.0
            for j in range(i, len(run)):
                tot += run[j]["dur"] + (kept_gap(run[j - 1], run[j]) if j > i else 0.0)
                if tot > MAX_S:
                    break
                if tot >= MIN_S:
                    w = run[i:j + 1]
                    stretches.append((float(np.mean([quality(r) for r in w])), w))
    if stretches:
        q, w = max(stretches, key=lambda x: x[0])
        return {"mode": "continuous", "clips": w, "quality": q}
    pool, _ = split(star)
    chosen, tot = [], 0.0
    for r in sorted((r for r in pool if r["path"] not in exclude), key=quality, reverse=True):
        if tot >= GOAL_S:
            break
        add = r["dur"] + (JOIN_GAP_S if chosen else 0.0)
        if tot + add <= MAX_S:
            chosen.append(r)
            tot += add
    chosen.sort(key=lambda r: r["start"])
    return {"mode": "joined", "clips": chosen, "quality": float(np.mean([quality(r) for r in chosen]))}


def loudness(x: np.ndarray, sr: int) -> float:
    import pyloudnorm as pyln
    return float(pyln.Meter(sr).integrated_loudness(x.astype(np.float64)))


def build(plan: dict) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """The reference at 24 kHz, and where her speech is in it (seconds), for the checks."""
    parts, spans, t = [], [], 0.0
    prev = None
    for r in plan["clips"]:
        x, sr = sf.read(r.get("path_df") or r["path"], dtype="float32", always_2d=True)
        x = x.mean(axis=1)
        if sr != SR_IN:
            x = resample_poly(x, SR_IN, sr).astype(np.float32)
        if prev is not None:
            gap = kept_gap(prev, r) if plan["mode"] == "continuous" else JOIN_GAP_S
            parts.append(np.zeros(int(gap * SR_IN), np.float32))
            t += gap
        parts.append(x)
        spans.append((t, t + len(x) / SR_IN))
        t += len(x) / SR_IN
        prev = r
    y = np.concatenate(parts)
    # 10 ms fades at the joins' edges are inside the clips already (VAD padding); level the whole, then the peak
    y = y * 10 ** ((TARGET_LUFS - loudness(y, SR_IN)) / 20)
    peak = np.abs(y).max()
    if peak > 10 ** (PEAK_DB / 20):
        y = y * (10 ** (PEAK_DB / 20) / peak)
    y24 = resample_poly(y, 1, SR_IN // SR_OUT).astype(np.float32)
    return np.clip(y24, -1.0, 1.0), spans


def snr_db(y: np.ndarray, spans: list[tuple[float, float]], sr: int = SR_OUT) -> float:
    """Speech level (90th percentile of 20 ms frames inside her speech) over the noise floor (10th percentile)."""
    w = int(0.02 * sr)
    rms = []
    for a, b in spans:
        seg = y[int(a * sr):int(b * sr)]
        n = len(seg) // w
        if n:
            rms.extend(np.sqrt((seg[: n * w].reshape(n, w) ** 2).mean(axis=1)) + 1e-9)
    db = 20 * np.log10(np.array(rms))
    return float(np.percentile(db, 90) - np.percentile(db, 10))


def check(wav: bytes, y: np.ndarray, spans: list[tuple[float, float]]) -> dict:
    dur = len(y) / SR_OUT
    longest = max(b - a for a, b in spans)
    pauses = [spans[i + 1][0] - spans[i][1] for i in range(len(spans) - 1)]
    info = sf.info(io.BytesIO(wav))
    problems = []
    if not RULES["min_s"] <= dur <= RULES["max_s"]:
        problems.append(f"duration {dur:.1f}s outside {RULES['min_s']:.0f}-{RULES['max_s']:.0f}s")
    if info.samplerate < RULES["min_rate"] or info.channels != 1 or info.subtype != "PCM_16":
        problems.append(f"format {info.samplerate} Hz {info.channels} ch {info.subtype}")
    if len(wav) > RULES["max_bytes"]:
        problems.append(f"{len(wav)} bytes > 10 MB")
    if longest < RULES["min_continuous_s"]:
        problems.append(f"longest continuous speech {longest:.1f}s < 3 s")
    if pauses and max(pauses) > RULES["max_pause_s"]:
        problems.append(f"pause {max(pauses):.1f}s > 2 s")
    return {"seconds": round(dur, 2), "rate": info.samplerate, "channels": info.channels, "subtype": info.subtype,
            "bytes": len(wav), "longest_speech_s": round(longest, 2), "longest_pause_s": round(max(pauses or [0.0]), 2),
            "problems": problems}


def prepare(star: str, n: int = 0, exclude: frozenset = frozenset()) -> dict | None:
    """Her reference number `n` (0: the main one, refs/<star>.wav; more for vendors that take several samples,
    refs/<star>-<n>.wav), from clips not in `exclude`. None when too little of her speech is left for another."""
    plan = choose(star, exclude)
    if not plan["clips"] or sum(r["dur"] for r in plan["clips"]) < RULES["min_s"] - 1:
        return None
    y, spans = build(plan)
    buf = io.BytesIO()
    sf.write(buf, y, SR_OUT, subtype="PCM_16", format="WAV")
    wav = buf.getvalue()
    REFS.mkdir(parents=True, exist_ok=True)
    path = REFS / (f"{star}.wav" if n == 0 else f"{star}-{n}.wav")
    path.write_bytes(wav)
    clips = plan["clips"]
    meta = {
        "star": star, "n": n, "path": str(path), "sha256": hashlib.sha256(wav).hexdigest()[:16], "mode": plan["mode"],
        "clip_paths": [r["path"] for r in clips],
        "clips": [Path(r["path"]).stem for r in clips],
        "recording_span": [round(clips[0]["start"], 2), round(clips[-1]["start"] + clips[-1]["dur"], 2)],
        "text": "".join(r["text"] for r in clips),
        "spk_sim": round(float(np.mean([r.get("spk_sim", 0) for r in clips])), 3),
        "asr_logprob": round(float(np.mean([r["avg_logprob"] for r in clips])), 3),
        "lufs": round(loudness(y, SR_OUT), 1), "peak_dbfs": round(float(20 * np.log10(np.abs(y).max() + 1e-9)), 1),
        "snr_db": round(snr_db(y, spans), 1),
        **check(wav, y, spans),
    }
    (REFS / (f"{star}.json" if n == 0 else f"{star}-{n}.json")).write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def extra_refs(main: dict, count: int) -> list[dict]:
    """Further references of hers from clips the main one does not use (Fish takes up to 20 samples and advises
    "2-3 clips of 15-20 seconds"); only those that pass the same rules."""
    used = frozenset(main["clip_paths"])
    out = []
    for n in range(1, count):
        m = prepare(main["star"], n, used)
        if not m or m["problems"]:
            break
        out.append(m)
        used = used | frozenset(m["clip_paths"])
    return out


def likeness(metas: list[dict]) -> None:
    """ECAPA (the pipeline's judge, qa.py): the reference against her held-out clips, and the margin over the others."""
    from qa import Embedder, likeness as like, load16
    emb = Embedder("ecapa")
    cents = emb.centroids()
    for m in metas:
        r = {"star": m["star"]}
        like(r, emb(load16(m["path"])), cents)
        m.update({"ecapa_sim": r["sim"], "ecapa_margin": r["margin"]})
        (REFS / f"{m['star']}.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- the vendors

def load_env(name: str, keys: list[str]) -> dict[str, str]:
    """Values from the environment, else from the main checkout's `.env.<name>.local` (never printed)."""
    out = {k: os.environ[k] for k in keys if os.environ.get(k)}
    f = MAIN / f".env.{name}.local"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            k, _, v = line.strip().removeprefix("export ").partition("=")
            if k in keys and k not in out and v:
                out[k] = v.strip().strip("'\"")
    return out


def post(url: str, headers: dict, body: dict, timeout: int = 120) -> tuple[int, dict, dict]:
    import requests
    r = requests.post(url, headers=headers, json=body, timeout=timeout)
    try:
        data = r.json()
    except ValueError:
        data = {"raw": r.text[:300]}
    return r.status_code, data, dict(r.headers)


def enroll_qwen(meta: dict, key: str, with_text: bool) -> dict:
    wav = Path(meta["path"]).read_bytes()
    body = {"model": "qwen-voice-enrollment", "input": {
        "action": "create", "target_model": QWEN_TARGET, "preferred_name": f"jstar_{meta['star']}"[:16],
        "audio": {"data": "data:audio/wav;base64," + base64.b64encode(wav).decode()}, "language": "ja"}}
    if with_text:
        body["input"]["text"] = meta["text"]
    status, data, _ = post(QWEN_URL, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, body)
    out = data.get("output") or {}
    if status != 200 or not out.get("voice"):
        raise RuntimeError(f"qwen enrollment failed: HTTP {status} {data.get('code', '')} {data.get('message', '')}".strip())
    return {"voice": out["voice"], "target_model": out.get("target_model", QWEN_TARGET), "fallback_mode": bool(out.get("fallback_mode")),
            "fallback_reason": out.get("fallback_reason"), "request_id": data.get("request_id")}


FISH_BASE = os.environ.get("FISH_API_BASE", "https://api.fish.audio").rstrip("/")


def enroll_fish(meta: dict, extras: list[dict], key: str, with_text: bool, tag: str = "") -> dict:
    """Fish Audio `POST /model` (multipart): a private TTS voice model from her references (`voices`, with their
    transcripts as `texts` when asked), `train_mode=fast`; then `GET /model/{id}` until `state` is `trained`."""
    import requests
    refs = [meta, *extras]
    files = [("voices", (Path(m["path"]).name, Path(m["path"]).read_bytes(), "audio/wav")) for m in refs]
    data: list[tuple[str, str]] = [("type", "tts"), ("title", f"JSTAR {meta['star']}{' ' + tag if tag else ''}"), ("visibility", "private"),
                                   ("train_mode", "fast"), ("enhance_audio_quality", "false"),
                                   ("description", "JSTAR licensed talent voice (#73); private")]
    if with_text:
        data += [("texts", m["text"]) for m in refs]
    head = {"Authorization": f"Bearer {key}"}
    r = requests.post(f"{FISH_BASE}/model", headers=head, data=data, files=files, timeout=180)
    try:
        body = r.json()
    except ValueError:
        body = {"message": r.text[:200]}
    if r.status_code not in (200, 201) or not body.get("_id"):
        raise RuntimeError(f"fish model creation failed: HTTP {r.status_code} {body.get('message', '')} {body.get('reason') or ''}".strip())
    mid = body["_id"]
    for _ in range(90):
        if body.get("state") == "trained":
            break
        if body.get("state") == "failed":
            raise RuntimeError(f"fish model {mid} failed to train")
        time.sleep(2)
        body = requests.get(f"{FISH_BASE}/model/{mid}", headers=head, timeout=30).json()
    if body.get("state") != "trained":
        raise RuntimeError(f"fish model {mid} not trained yet (state {body.get('state')})")
    q = (body.get("quality") or {}).get("audios") or []
    return {"voice": mid, "state": body["state"], "refs": len(refs), "ref_seconds_total": round(sum(m["seconds"] for m in refs), 1),
            "languages": body.get("languages"), "quality": [{k: a.get(k) for k in ("duration_ms", "language", "quality_passed", "quality_reason")} for a in q]}


def enroll_byteplus(meta: dict, key: str, speaker: str | None, with_text: bool) -> dict:
    wav = Path(meta["path"]).read_bytes()
    body: dict = {"audio": {"data": base64.b64encode(wav).decode(), "format": "wav"}, "language": BP_LANG["ja"],
                  "extra_params": {"demo_text": "今日もおつかれさま。ちゃんと休んでね。"}}
    custom = None
    if speaker:
        body["speaker_id"] = speaker
    else:
        custom = f"jstar-{meta['star']}-v1"
        body.update({"speaker_id": "custom_speaker_id", "custom_speaker_id": custom})
    if with_text:
        body["text"] = meta["text"]
    head = lambda: {"Content-Type": "application/json", "X-Api-Key": key, "X-Api-Request-Id": str(uuid.uuid4())}  # noqa: E731
    status, data, h = post(f"{BP_BASE}/voice_clone", head(), body)
    # "On failure, the HTTP status will be non-200"; the codes of failures are 45001xxx / 55001xxx
    if status != 200 or (isinstance(data.get("code"), int) and data["code"] >= 40000000):
        raise RuntimeError(f"byteplus enrollment failed: HTTP {status} code {data.get('code')} {data.get('message', '')} logid {h.get('X-Tt-Logid', '')}")
    sid = data.get("speaker_id") or speaker or custom
    query = {"speaker_id": "custom_speaker_id", "custom_speaker_id": custom} if custom else {"speaker_id": sid}
    for _ in range(60):  # training is usually seconds; give it two minutes
        if data.get("status") in (2, 4):
            break
        if data.get("status") == 3:
            raise RuntimeError(f"byteplus training failed for {meta['star']}: {data.get('message', '')}")
        time.sleep(2)
        status, data, h = post(f"{BP_BASE}/get_voice", head(), query)
    if data.get("status") not in (2, 4):
        raise RuntimeError(f"byteplus voice for {meta['star']} not ready (status {data.get('status')})")
    # TTS addresses a postpaid voice by its custom id, a prepaid slot by its SpeakerID
    return {"voice": custom or sid, "speaker_id": sid, "status": data.get("status"),
            "model_type": (data.get("speaker_status") or [{}])[0].get("model_type"), "postpaid": bool(custom),
            "available_training_times": data.get("available_training_times")}


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", required=True, choices=["fish", "qwen", "byteplus"])
    ap.add_argument("--refs", type=int, default=3, help="fish: up to this many references per talent (the main one + more)")
    ap.add_argument("--stars", default=",".join(STARS))
    ap.add_argument("--dry-run", action="store_true", help="prepare and check the references; call nothing")
    ap.add_argument("--text", choices=["auto", "on", "off"], default="auto",
                    help="send the reference's transcript (auto: qwen yes — it improves cloning; byteplus no — a"
                         " transcript that differs from the audio fails its WER check)")
    ap.add_argument("--force", action="store_true", help="enroll again a talent who already has a voice in the out file")
    ap.add_argument("--no-likeness", action="store_true", help="skip the ECAPA scoring of the references")
    ap.add_argument("--tag", default="", help="a variant (e.g. zh-notext): voices go to <provider>-voices-<tag>.json")
    a = ap.parse_args()
    stars = [s for s in a.stars.split(",") if s]
    unknown = set(stars) - set(STARS)
    if unknown:
        sys.exit(f"unknown talent(s): {', '.join(sorted(unknown))}")

    metas = [prepare(s) for s in stars]
    extras = {m["star"]: extra_refs(m, a.refs) if a.provider == "fish" else [] for m in metas}
    if not a.no_likeness:
        likeness(metas)
    print(f"\nreferences ({'dry run, nothing sent' if a.dry_run else a.provider}) -> {REFS}")
    print(f"{'star':7} {'mode':10} {'sec':>5} {'clips':>5} {'cont':>5} {'pause':>5} {'spk':>5} {'asrlp':>6} {'snr':>5} {'lufs':>6} {'ecapa':>6} {'margin':>6}  check")
    for m in metas:
        print(f"{m['star']:7} {m['mode']:10} {m['seconds']:5.1f} {len(m['clips']):5d} {m['longest_speech_s']:5.1f} {m['longest_pause_s']:5.2f} "
              f"{m['spk_sim']:5.3f} {m['asr_logprob']:6.3f} {m['snr_db']:5.1f} {m['lufs']:6.1f} {m.get('ecapa_sim', float('nan')):6.3f} "
              f"{m.get('ecapa_margin', float('nan')):6.3f}  {'ok' if not m['problems'] else '; '.join(m['problems'])}")
    for m in metas:
        for x in extras[m["star"]]:
            print(f"  + {x['star']}-{x['n']}  {x['mode']:10} {x['seconds']:5.1f}s {len(x['clips'])} clips  snr {x['snr_db']} dB  ok")
    bad = [m["star"] for m in metas if m["problems"]]
    if bad:
        sys.exit(f"references failing the vendor rules: {', '.join(bad)}")
    if a.dry_run:
        return

    if a.provider == "fish":
        env = load_env("fish", ["FISH_API_KEY"])
        key = env.get("FISH_API_KEY")
        if not key:
            sys.exit("FISH_API_KEY is not set (environment or .env.fish.local)")
    elif a.provider == "qwen":
        env = load_env("dashscope", ["DASHSCOPE_API_KEY"])
        key = env.get("DASHSCOPE_API_KEY")
        if not key:
            sys.exit("DASHSCOPE_API_KEY is not set (environment or .env.dashscope.local)")
    else:
        env = load_env("byteplus-voice", ["BYTEPLUS_VOICE_API_KEY", "BYTEPLUS_SPEAKERS"])
        key = env.get("BYTEPLUS_VOICE_API_KEY")
        if not key:
            sys.exit("BYTEPLUS_VOICE_API_KEY is not set (environment or .env.byteplus-voice.local)")
    speakers = json.loads(env.get("BYTEPLUS_SPEAKERS", "{}") or "{}")

    # Transcripts help Qwen and Fish ("texts … sharpen pronunciation"); BytePlus fails its WER check on a mismatch.
    with_text = a.text == "on" or (a.text == "auto" and a.provider in ("qwen", "fish"))
    out_file = OUT / f"{a.provider}-voices{'-' + a.tag if a.tag else ''}.json"
    have = json.loads(out_file.read_text(encoding="utf-8")) if out_file.exists() else {}
    for m in metas:
        s = m["star"]
        if s in have and not a.force:
            print(f"[{s}] already enrolled ({have[s]['voice']}); --force to enroll again")
            continue
        t = time.time()
        try:
            got = (enroll_fish(m, extras[s], key, with_text, a.tag) if a.provider == "fish"
                   else enroll_qwen(m, key, with_text) if a.provider == "qwen" else enroll_byteplus(m, key, speakers.get(s), with_text))
        except Exception as e:  # noqa: BLE001 — one talent's failure must not lose the others' voices
            print(f"[{s}] FAILED: {e}")
            continue
        have[s] = {**got, "provider": a.provider, "ref_sha256": m["sha256"], "ref_seconds": m["seconds"], "with_text": with_text,
                   "enrolled_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "took_s": round(time.time() - t, 1)}
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(have, ensure_ascii=False, indent=1), encoding="utf-8")
        warn = "  (fallback_mode: the vendor found the reference poor — listen before using it)" if got.get("fallback_mode") else ""
        print(f"[{s}] {got['voice']}{warn}")

    voices = {s: v["voice"] for s, v in have.items()}
    print(f"\nvoice ids -> {out_file}")
    print(f"Worker vars:\n  TTS_PROVIDER={a.provider}\n  TTS_VOICES='{json.dumps(voices, ensure_ascii=False, separators=(',', ':'))}'")


if __name__ == "__main__":
    main()
