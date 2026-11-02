"""Self-review of generated takes (proxy "listen test").

    .voice/venv-prep/bin/python tools/voice/qa.py score [--index PATH]
    .voice/venv-prep/bin/python tools/voice/qa.py pick  [--index PATH] [--out PATH]

score: for every candidate in .voice/work/cands/index.jsonl not yet scored:
  - signal: duration after silence trim, peak / clipped-sample ratio, RMS
  - ASR back-transcription with local Whisper, compared to the target text as
    kana (pykakasi) -> character error rate (catches garbled/missing words)
  - likeness: cosine similarity of WavLM-SV x-vectors against the mean of
    held-out real clips of the same talent (clips never used as references)
  The two models are loaded one after the other, never together.
pick: choose the best passing take per id -> picks.jsonl; lists failures.
"""
from __future__ import annotations

import argparse
import gc
import json
import re
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from common import VOICE_HOME, WORK, local_model
from refs import heldout_clips

WHISPER = str(local_model("asr"))
WAVLM = str(VOICE_HOME / "models" / "microsoft" / "wavlm-base-plus-sv")
ECAPA = str(local_model("speaker"))


class Embedder:
    """Speaker embeddings. ECAPA-TDNN (SpeechBrain, VoxCeleb) separates these five
    voices far better than WavLM-SV (see REPORT.md), so it is the likeness judge."""

    def __init__(self, kind: str = "ecapa") -> None:
        import torch
        self.torch, self.kind = torch, kind
        if kind == "ecapa":
            from speechbrain.inference.speaker import EncoderClassifier
            self.m = EncoderClassifier.from_hparams(
                source=ECAPA, savedir=str(WORK / "sb_ecapa"), run_opts={"device": "cpu"})
        else:
            from transformers import AutoFeatureExtractor, WavLMForXVector
            self.fe = AutoFeatureExtractor.from_pretrained(WAVLM)
            self.m = WavLMForXVector.from_pretrained(WAVLM).eval()

    def __call__(self, x: np.ndarray) -> np.ndarray:
        torch = self.torch
        with torch.inference_mode():
            if self.kind == "ecapa":
                e = self.m.encode_batch(torch.from_numpy(x)[None])[0, 0]
            else:
                e = self.m(**self.fe(x, sampling_rate=16000, return_tensors="pt")).embeddings[0]
        e = torch.nn.functional.normalize(e, dim=-1)
        return e.numpy()

    def centroids(self) -> dict[str, np.ndarray]:
        from common import STARS
        out = {}
        for s in STARS:
            c = np.stack([self(load16(str(p))) for p in heldout_clips(s)]).mean(axis=0)
            out[s] = c / np.linalg.norm(c)
        return out


def likeness(r: dict, e: np.ndarray, cents: dict[str, np.ndarray]) -> None:
    sims = {s: float(e @ c) for s, c in cents.items()}
    r["sim"] = round(sims[r["star"]], 4)
    r["sim_other"] = round(max(v for s, v in sims.items() if s != r["star"]), 4)
    r["margin"] = round(r["sim"] - r["sim_other"], 4)

MAX_CER = 0.15
MAX_DUR = 12.0
MIN_SIM = 0.0  # likeness is ranked, not gated; see REPORT.md for per-talent levels

_kks = None


def kana(text: str) -> str:
    global _kks
    if _kks is None:
        import pykakasi
        _kks = pykakasi.kakasi()
    t = unicodedata.normalize("NFKC", text)
    t = t.translate(str.maketrans("0123456789", "〇一二三四五六七八九"))  # ASR writes digits
    # convert with punctuation still in place (it guides segmentation), strip after
    out = "".join(x["hira"] for x in _kks.convert(t))
    return re.sub(r"[\s、。，,.!！?？…・「」『』（）()\-ー〜~♪☆★]+", "", out)


def cer(ref: str, hyp: str) -> float:
    r, h = kana(ref), kana(hyp)
    if not r:
        return 0.0 if not h else 1.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / len(r)


def load16(path: str) -> np.ndarray:
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != 16000:
        from math import gcd
        g = gcd(sr, 16000)
        x = resample_poly(x, 16000 // g, sr // g).astype(np.float32)
    return x


def signal_stats(path: str) -> dict:
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    thr = 10 ** (-45 / 20) * max(np.abs(x).max(), 1e-6)
    idx = np.where(np.abs(x) > thr)[0]
    voiced = x[idx[0]:idx[-1] + 1] if len(idx) else x
    return {
        "dur": len(x) / sr, "dur_trim": len(voiced) / sr,
        "peak": float(np.abs(x).max()),
        "clip_ratio": float(np.mean(np.abs(x) > 0.99)),
        "rms_db": float(20 * np.log10(np.sqrt(np.mean(voiced ** 2)) + 1e-9)),
    }


def read_jsonl(p: Path) -> list[dict]:
    if not p.exists():
        return []
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def score(index_path: Path) -> None:
    scores_path = index_path.with_name("scores.jsonl")
    done = {r["wav"] for r in read_jsonl(scores_path)}
    todo = [r for r in read_jsonl(index_path) if r["wav"] not in done and Path(r["wav"]).exists()]
    if not todo:
        print("nothing to score")
        return
    print(f"scoring {len(todo)} takes", flush=True)

    # 1) ASR (Whisper, MLX) -------------------------------------------------
    import mlx_whisper
    for r in todo:
        res = mlx_whisper.transcribe(load16(r["wav"]), path_or_hf_repo=WHISPER, language="ja",
                                     condition_on_previous_text=False, temperature=0.0)
        r["asr"] = res["text"].strip()
        r["cer"] = round(cer(r["text"], r["asr"]), 4)
        # ASR confidence: a proxy for native-sounding delivery (accent, rhythm)
        r["asr_lp"] = round(float(np.mean([g["avg_logprob"] for g in res["segments"]])), 4) \
            if res.get("segments") else -9.0
        r.update(signal_stats(r["wav"]))
    del mlx_whisper
    gc.collect()

    # 2) Likeness (speaker embeddings) --------------------------------------
    emb = Embedder()
    cents = emb.centroids()
    for r in todo:
        likeness(r, emb(load16(r["wav"])), cents)
    del emb
    gc.collect()

    with open(scores_path, "a", encoding="utf-8") as f:
        for r in todo:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"scored {len(todo)} -> {scores_path}", flush=True)


def baseline(kind: str = "ecapa") -> None:
    """Reference points for `sim`: real clips of each talent (reference pool, not
    held out) against her own held-out centroid (ceiling) and the others (floor)."""
    from common import STARS
    from refs import reference_clips
    emb = Embedder(kind)
    cents = emb.centroids()
    out = {}
    for s in STARS:
        rs = []
        for p in reference_clips(s, 40):
            r = {"star": s}
            likeness(r, emb(load16(str(p))), cents)
            rs.append(r)
        out[s] = {k: round(float(np.mean([r[k] for r in rs])), 3) for k in ("sim", "sim_other", "margin")}
        out[s]["top1"] = round(float(np.mean([r["margin"] > 0 for r in rs])), 2)
        print(f"{kind} {s}: real clips {out[s]}")
    json.dump(out, open(WORK / f"baseline_{kind}.json", "w"), indent=1)


def backfill_asr_lp() -> None:
    import mlx_whisper
    p = WORK / "cands" / "scores.jsonl"
    rows = read_jsonl(p)
    for r in rows:
        if "asr_lp" in r:
            continue
        res = mlx_whisper.transcribe(load16(r["wav"]), path_or_hf_repo=WHISPER, language="ja",
                                     condition_on_previous_text=False, temperature=0.0)
        r["asr_lp"] = round(float(np.mean([g["avg_logprob"] for g in res["segments"]])), 4) \
            if res.get("segments") else -9.0
    with open(p, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"backfilled {len(rows)}")


def recer() -> None:
    """Recompute CER for all scored takes (after changing kana())."""
    p = WORK / "cands" / "scores.jsonl"
    rows = read_jsonl(p)
    for r in rows:
        r["cer"] = round(cer(r["text"], r["asr"]), 4)
    with open(p, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"re-CER {len(rows)}")


def rescore_sim() -> None:
    """Recompute likeness for every scored take (after changing the embedder)."""
    p = WORK / "cands" / "scores.jsonl"
    rows = read_jsonl(p)
    emb = Embedder()
    cents = emb.centroids()
    for r in rows:
        likeness(r, emb(load16(r["wav"])), cents)
    with open(p, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"rescored {len(rows)}")


def summary(index_path: Path) -> None:
    """Mean likeness / CER / pass rate per (tag, star) — the model comparison table."""
    rows = read_jsonl(index_path.with_name("scores.jsonl"))
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        groups.setdefault((r.get("tag", ""), r["star"]), []).append(r)
    print(f"{'tag':16} {'star':7} {'n':>3} {'sim':>6} {'margin':>6} {'top1':>5} {'cer':>6} {'asrlp':>6} {'pass':>5} {'dur':>5}")
    for (tag, star), rs in sorted(groups.items()):
        print(f"{tag:16} {star:7} {len(rs):3d} {np.mean([r['sim'] for r in rs]):6.3f} "
              f"{np.mean([r['margin'] for r in rs]):6.3f} {np.mean([r['margin'] > 0 for r in rs]):5.2f} "
              f"{np.mean([r['cer'] for r in rs]):6.3f} {np.mean([r.get('asr_lp', np.nan) for r in rs]):6.3f} "
              f"{np.mean([passes(r) for r in rs]):5.2f} {np.mean([r['dur_trim'] for r in rs]):5.1f}")
    for tag in sorted({k[0] for k in groups}):
        rs = [r for (t, _), v in groups.items() if t == tag for r in v]
        print(f"{tag:16} {'ALL':7} {len(rs):3d} {np.mean([r['sim'] for r in rs]):6.3f} "
              f"{np.mean([r['margin'] for r in rs]):6.3f} {np.mean([r['margin'] > 0 for r in rs]):5.2f} "
              f"{np.mean([r['cer'] for r in rs]):6.3f} {np.mean([r.get('asr_lp', np.nan) for r in rs]):6.3f} "
              f"{np.mean([passes(r) for r in rs]):5.2f}")


def passes(r: dict) -> bool:
    return r["cer"] <= MAX_CER and r["dur_trim"] <= MAX_DUR and r["clip_ratio"] < 5e-4 \
        and r["sim"] >= MIN_SIM and r["rms_db"] > -40


def pick(index_path: Path, out: Path, tag: str | None) -> None:
    scores = read_jsonl(index_path.with_name("scores.jsonl"))
    if tag is not None:
        scores = [r for r in scores if r.get("tag", "") == tag]
    by_id: dict[str, list[dict]] = {}
    for r in scores:
        by_id.setdefault(r["id"], []).append(r)
    from common import TOOLS_DIR
    accept = json.load(open(TOOLS_DIR / "qa_accept.json", encoding="utf-8"))
    readings = json.load(open(TOOLS_DIR / "readings.json", encoding="utf-8"))
    picks, fails = [], []
    for i, rs in sorted(by_id.items()):
        if i in readings:  # only takes synthesised from the current reading count
            rs = [r for r in rs if r["text"] == readings[i]]
        ok = [r for r in rs if passes(r) or (i in accept and passes({**r, "cer": r["cer"] - 0.15}))]
        if ok:
            # intelligibility first (2x), then likeness
            best = max(ok, key=lambda r: r["sim"] - 2.0 * r["cer"])
            picks.append(best)
        elif rs:
            fails.append(min(rs, key=lambda r: r["cer"]))
    with open(out, "w", encoding="utf-8") as f:
        for r in picks:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"picked {len(picks)}, failed {len(fails)} -> {out}")
    for r in fails:
        print(f"  FAIL {r['id']} cer={r['cer']:.2f} dur={r['dur_trim']:.1f} sim={r['sim']:.2f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["score", "pick", "baseline", "summary", "rescore-sim", "asr-lp", "recer"])
    ap.add_argument("--index", default=str(WORK / "cands" / "index.jsonl"))
    ap.add_argument("--out", default=str(WORK / "picks.jsonl"))
    ap.add_argument("--tag", default=None)
    a = ap.parse_args()
    if a.cmd == "score":
        score(Path(a.index))
    elif a.cmd == "baseline":
        baseline("ecapa")
        baseline("wavlm")
    elif a.cmd == "recer":
        recer()
    elif a.cmd == "asr-lp":
        backfill_asr_lp()
    elif a.cmd == "rescore-sim":
        rescore_sim()
    elif a.cmd == "summary":
        summary(Path(a.index))
    else:
        pick(Path(a.index), Path(a.out), a.tag)
