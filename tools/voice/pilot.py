"""Pilot of her runtime voice (#73): the same 20 lines per talent from each vendor, scored side by side.

    npm run voice:pilot -- --provider fish --hant-check     # one vendor (FISH_TTS_MODEL=s2.1-pro-free: Fish's free tier)
    npm run voice:pilot -- --provider qwen,byteplus        # side by side, with a suggested vendor per talent
    npm run voice:pilot -- --provider qwen --dry-run       # lines, jobs, voices, keys and judges checked; nothing sent
    options: --stars mahiro,nana  --per-lang 5  --hant-check  --byteplus-usd-per-10k 0.3
    experiments: --langs zh-Hant  --split [--min-len 12]  --prep none|clean|leadin|hint|hint_en|hint_lex
                 --voices-tag zh-notext (an enrollment variant: npm run voice:enroll -- --tag zh-notext …)  --tag NAME
                 env FISH_TTS_MODEL / FISH_TTS_LATENCY / FISH_TTS_TEMPERATURE / FISH_TTS_TOP_P / FISH_ZH_HINT=off

Lines: 5 ja, 5 zh-Hant, 5 en, 5 ko per talent, from her own scripted lines (packages/shared/src/lines/<star>.json:
entries with all four languages and no {name}), chosen deterministically, so every run and every vendor reads the
same text. Voices: tools/voice/out/<provider>-voices.json (npm run voice:enroll). Synthesis: the Worker's own adapters
(tools/voice/tts_synth.ts → infra/cloudflare/src/tts.ts), one sentence at a time.

Scores, all local, the pipeline's judges (README.md):
- likeness: ECAPA cosine to her held-out real clips (never in any reference) and the margin over the other four;
- intelligibility: Whisper large-v3-turbo back-transcription → CER in that language (langs.py);
- latency: time to the vendor's first audio bytes and to the whole sentence, and the real-time factor;
- cost: what the vendor bills for the text sent (Fish s2.1-pro $15 per million UTF-8 bytes; Qwen3-TTS-VC intl
  $0.115 / 10,000 characters; BytePlus: pass the price
  from the console with --byteplus-usd-per-10k, else only characters are reported).
`--hant-check` also reads each zh-Hant line converted to Simplified, to see whether a vendor reads Traditional worse
(docs/tts.md › Traditional Chinese).

Writes tools/voice/out/pilot-<stamp>.json and .md (and the takes under pilot-<stamp>/; all gitignored: her voice).
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import statistics as st
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from common import REPO, STARS, TOOLS_DIR, VOICE_HOME, local_model
from enroll import load_env
from langs import WHISPER_LANG, cer, to_simplified

OUT = TOOLS_DIR / "out"
LANGS = ["ja", "zh-Hant", "en", "ko"]
PRICE_USD_PER_10K = {"qwen": 0.115, "byteplus": None, "fish": None}
# Fish bills input text by UTF-8 bytes: s2.1-pro $15 per million (s2.1-pro-free: $0, fair use, development).
FISH_USD_PER_MB = {"s2.1-pro": 15.0, "s2-pro": 15.0, "s1": 15.0, "s2.1-pro-free": 0.0}
KEYS = {"fish": ("fish", ["FISH_API_KEY", "FISH_TTS_MODEL", "FISH_TTS_LATENCY", "FISH_TTS_TEMPERATURE", "FISH_TTS_TOP_P"]),
        "qwen": ("dashscope", ["DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "QWEN_TTS_MODEL"]),
        "byteplus": ("byteplus-voice", ["BYTEPLUS_VOICE_API_KEY", "BYTEPLUS_TTS_RESOURCE", "BYTEPLUS_TTS_URL"])}
MAX_CER = 0.15


# ---------------------------------------------------------------- lines

def her_lines(star: str) -> list[dict]:
    """Every entry of her line file with all four languages and nothing to fill in."""
    data = json.loads((REPO / "packages" / "shared" / "src" / "lines" / f"{star}.json").read_text(encoding="utf-8"))
    found: list[dict] = []

    def walk(o):
        if isinstance(o, dict):
            if all(isinstance(o.get(k), str) for k in LANGS) and not any("{" in o[k] for k in LANGS) and 6 <= len(o["ja"]) <= 70:
                found.append({k: o[k] for k in LANGS})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    uniq = {e["ja"]: e for e in found}
    return sorted(uniq.values(), key=lambda e: hashlib.sha1(e["ja"].encode()).hexdigest())


def pilot_lines(star: str, per_lang: int) -> list[dict]:
    """per_lang distinct entries for each language (different sentences per language, the same for every vendor)."""
    entries = her_lines(star)
    need = per_lang * len(LANGS)
    if len(entries) < need:
        raise SystemExit(f"{star}: only {len(entries)} usable lines, {need} needed")
    out = []
    for li, lang in enumerate(LANGS):
        for k, e in enumerate(entries[li * per_lang:(li + 1) * per_lang]):
            out.append({"key": f"{star}-{lang}-{k}", "star": star, "lang": lang, "text": e[lang]})
    return out


# ---------------------------------------------------------------- text variants (experiments)

def _clean(t: str) -> str:
    """Drawn-out marks and ellipses as plain pauses: 早～安～！……起床了嗎？ → 早安！起床了嗎？"""
    import re
    t = re.sub(r"[～〜~]+", "", t)
    t = re.sub(r"^[…\.]+", "", t.strip())
    t = re.sub(r"[…]+", "，", t)
    t = re.sub(r"[，、]{2,}", "，", t)
    t = re.sub(r"，([。！？!?」』])", r"\1", t)
    t = re.sub(r"([。！？!?])[，、]+", r"\1", t)
    return t.strip("，") or t


def _prep_none(t: str, lang: str) -> tuple[str, str]:
    return t, t


def _prep_clean(t: str, lang: str) -> tuple[str, str]:
    c = _clean(t) if lang == "zh-Hant" else t
    return c, c


def _prep_leadin(t: str, lang: str) -> tuple[str, str]:
    c = _clean(t) if lang == "zh-Hant" else t
    return ("嗯，" + c, "嗯，" + c) if lang == "zh-Hant" else (c, c)


def _prep_hint(t: str, lang: str) -> tuple[str, str]:
    """S2's natural-language [bracket] control (docs: emotions / models overview): asks for standard Mandarin."""
    c = _clean(t) if lang == "zh-Hant" else t
    return ("[用標準的台灣國語自然地說] " + c, c) if lang == "zh-Hant" else (c, c)


def _prep_hint_en(t: str, lang: str) -> tuple[str, str]:
    c = _clean(t) if lang == "zh-Hant" else t
    return ("[speaking natural Mandarin Chinese with a native Taiwanese accent] " + c, c) if lang == "zh-Hant" else (c, c)


# Short greetings and her names in tone-number pinyin (Fish's Chinese phoneme control): the words her clone most often
# reads with a Japanese accent. General-purpose, not fitted to the pilot lines.
ZH_LEXICON = {"早安": "zao3 an1", "午安": "wu3 an1", "晚安": "wan3 an1", "欸": "ei4", "呵呵": "he1 he1", "嗯": "en4",
              "真尋": "zhen1 xun2", "奈奈": "nai4 nai4", "愛麗絲": "ai4 li4 si1", "詠美": "yong3 mei3"}


def phonemes(t: str) -> str:
    for word, py in sorted(ZH_LEXICON.items(), key=lambda kv: -len(kv[0])):
        tagged = "".join(f"<|phoneme_start|>{syl}<|phoneme_end|>" for syl in py.split())
        t = t.replace(word, tagged)
    return t


def _prep_hint_lex(t: str, lang: str) -> tuple[str, str]:
    s, meant = _prep_hint(t, lang)
    return (phonemes(s) if lang == "zh-Hant" else s), meant


PREPS = {"hint_lex": _prep_hint_lex, "none": _prep_none, "clean": _prep_clean, "leadin": _prep_leadin, "hint": _prep_hint, "hint_en": _prep_hint_en}


# ---------------------------------------------------------------- run

VOICES_TAG = ""


def voices_of(provider: str) -> dict:
    """Her enrolled voices (npm run voice:enroll), or a variant's (`--voices-tag zh-notext` → fish-voices-zh-notext.json)."""
    f = OUT / f"{provider}-voices{'-' + VOICES_TAG if VOICES_TAG else ''}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def synthesize(jobs: list[dict], provider: str, run_dir: Path) -> dict[str, dict]:
    env = {**os.environ, **load_env(*KEYS[provider])}
    jf = run_dir / f"jobs-{provider}.jsonl"
    jf.write_text("".join(json.dumps(j, ensure_ascii=False) + "\n" for j in jobs), encoding="utf-8")
    tsx = REPO / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        tsx = Path(subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=TOOLS_DIR, text=True).strip()).parent / "node_modules" / ".bin" / "tsx"
    proc = subprocess.run([str(tsx), str(TOOLS_DIR / "tts_synth.ts"), str(jf), str(run_dir / provider)],
                          cwd=REPO, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"tts_synth failed: {proc.stderr.strip()[:400]}")
    return {r["id"]: r for r in map(json.loads, filter(None, proc.stdout.splitlines()))}


def score(rows: list[dict]) -> None:
    """Whisper CER in the line's language, then ECAPA likeness — one model after the other, as qa.py does."""
    import mlx_whisper
    from qa import WHISPER, Embedder, likeness, load16
    done = [r for r in rows if r.get("ok")]
    for r in done:
        res = mlx_whisper.transcribe(load16(r["wav"]), path_or_hf_repo=WHISPER, language=WHISPER_LANG[r["lang"]],
                                     condition_on_previous_text=False, temperature=0.0)
        r["asr"] = res["text"].strip()
        r["cer"] = round(cer(r["ref_text"], r["asr"], r["lang"]), 4)
    del mlx_whisper
    gc.collect()
    emb = Embedder("ecapa")
    cents = emb.centroids()
    for r in done:
        likeness(r, emb(load16(r["wav"])), cents)


# ---------------------------------------------------------------- report

def pct(xs: list[float], q: float) -> float:
    return float(np.percentile(xs, q)) if xs else float("nan")


def summarise(rows: list[dict], providers: list[str], stars: list[str], prices: dict) -> dict:
    def agg(rs: list[dict]) -> dict:
        ok = [r for r in rs if r.get("ok") and "cer" in r]
        chars = sum(len(r["text"]) for r in rs)
        provider = rs[0]["provider"] if rs else None
        price = prices.get(provider) if rs else None
        if provider == "fish":
            usd = round(sum(len(r["text"].encode("utf-8")) for r in rs) / 1e6 * FISH_USD_PER_MB.get(prices.get("fish_model") or "s2.1-pro", 15.0), 4)
        return {
            "n": len(rs), "ok": len(ok),
            "sim": round(st.mean(r["sim"] for r in ok), 4) if ok else None,
            "margin": round(st.mean(r["margin"] for r in ok), 4) if ok else None,
            "top1": round(st.mean(r["margin"] > 0 for r in ok), 2) if ok else None,
            "cer": round(st.mean(r["cer"] for r in ok), 4) if ok else None,
            "pass": round(st.mean(r["cer"] <= MAX_CER for r in ok), 2) if ok else None,
            "ttfb_p50": round(pct([r["ttfbMs"] for r in ok], 50)) if ok else None,
            "ttfb_p90": round(pct([r["ttfbMs"] for r in ok], 90)) if ok else None,
            "total_p50": round(pct([r["totalMs"] for r in ok], 50)) if ok else None,
            "rtf": round(st.mean(r["totalMs"] / 1000 / r["seconds"] for r in ok), 3) if ok else None,
            "audio_s": round(sum(r["seconds"] for r in ok), 1),
            "chars": chars,
            "usd": usd if provider == "fish" else (round(chars / 10_000 * price, 4) if price is not None else None),
        }
    main = [r for r in rows if not r.get("variant")]
    out: dict = {"by_provider": {}, "by_star": {}, "by_lang": {}, "winner": {}}
    for p in providers:
        rp = [r for r in main if r["provider"] == p]
        if not rp:
            continue
        out["by_provider"][p] = agg(rp)
        out["by_star"][p] = {s: agg([r for r in rp if r["star"] == s]) for s in stars if any(r["star"] == s for r in rp)}
        out["by_lang"][p] = {lang: agg([r for r in rp if r["lang"] == lang]) for lang in LANGS}
        hant = [r for r in rows if r["provider"] == p and r.get("variant") == "hans" and r.get("ok") and "cer" in r]
        if hant:
            out.setdefault("hant_check", {})[p] = {"hant_cer": out["by_lang"][p]["zh-Hant"]["cer"], "hans_cer": round(st.mean(r["cer"] for r in hant), 4)}
    # per talent: likeness first, intelligibility counted twice (qa.py pick), a vendor failing CER in any language loses
    for s in stars:
        cands = []
        for p in providers:
            a = out["by_star"].get(p, {}).get(s)
            if not a or not a["ok"]:
                continue
            langs_cer = [st.mean(r["cer"] for r in main if r["provider"] == p and r["star"] == s and r["lang"] == lang and "cer" in r) for lang in LANGS
                         if any(r["provider"] == p and r["star"] == s and r["lang"] == lang and "cer" in r for r in main)]
            ok_all = all(c <= MAX_CER for c in langs_cer) and a["ok"] == a["n"]
            cands.append((ok_all, a["sim"] - 2 * a["cer"], -(a["ttfb_p50"] or 0), p))
        if cands:
            best = max(cands)
            out["winner"][s] = {"provider": best[3], "all_languages_pass": best[0], "score": round(best[1], 4)}
    return out


def markdown(meta: dict, summary: dict, rows: list[dict]) -> str:
    L = [f"# Runtime voice pilot — {meta['stamp']}", "",
         f"Vendors: {', '.join(meta['providers'])} · talents: {', '.join(meta['stars'])} · {meta['per_lang']} lines per language "
         f"(ja / zh-Hant / en / ko) · likeness = ECAPA cosine to her held-out real clips (real clips score 0.79–0.88, tools/voice/README.md) · "
         f"CER pass ≤ {MAX_CER:.0%}.", ""]
    head = "| | n ok | sim | margin | top1 | CER | pass | first audio p50 / p90 | sentence p50 | RTF | audio s | chars | USD |"
    sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    fmt = lambda a: f"{a['ok']}/{a['n']} | {a['sim']} | {a['margin']} | {a['top1']} | {a['cer']} | {a['pass']} | {a['ttfb_p50']} / {a['ttfb_p90']} ms | {a['total_p50']} ms | {a['rtf']} | {a['audio_s']} | {a['chars']} | {a['usd'] if a['usd'] is not None else '—'} |"  # noqa: E731
    L += ["## By vendor", "", head, sep] + [f"| {p} | " + fmt(a) for p, a in summary["by_provider"].items()] + [""]
    L += ["## By talent", "", head.replace("| |", "| talent · vendor |"), sep]
    for s in meta["stars"]:
        for p, by in summary["by_star"].items():
            if s in by:
                L.append(f"| {s} · {p} | " + fmt(by[s]))
    L += ["", "## By language", "", head.replace("| |", "| language · vendor |"), sep]
    for lang in LANGS:
        for p, by in summary["by_lang"].items():
            L.append(f"| {lang} · {p} | " + fmt(by[lang]))
    if summary.get("hant_check"):
        L += ["", "## Traditional vs Simplified (zh-Hant lines)", "", "| vendor | CER as written (Traditional) | CER read as Simplified |", "|---|---|---|"]
        L += [f"| {p} | {v['hant_cer']} | {v['hans_cer']} |" for p, v in summary["hant_check"].items()]
    L += ["", "## Suggested vendor per talent", "", "Rule: highest mean likeness − 2 × CER (as qa.py picks takes); a vendor with a language over the CER limit or a failed take loses to one without.", ""]
    L += [f"- {s}: **{w['provider']}** (score {w['score']}{'' if w['all_languages_pass'] else ', NOT every language passes — listen first'})" for s, w in summary["winner"].items()]
    voices = {p: voices_of(p) for p in meta["providers"]}
    tts = {s: ({"provider": w["provider"], "voice": voices[w["provider"]][s]["voice"]}) for s, w in summary["winner"].items() if s in voices.get(w["provider"], {})}
    L += ["", "TTS_VOICES for the Worker (per-talent vendors):", "", "```", json.dumps(tts, ensure_ascii=False, separators=(",", ":")), "```"]
    fails = [r for r in rows if not r.get("ok")]
    worst = sorted([r for r in rows if r.get("ok") and "cer" in r], key=lambda r: -r["cer"])[:8]
    if fails:
        L += ["", "## Failed requests", ""] + [f"- {r['provider']} {r['id']}: {r.get('error')}" for r in fails]
    L += ["", "## Worst CER takes (listen to these)", "", "| take | lang | CER | sim | heard |", "|---|---|---|---|---|"]
    L += [f"| {r['provider']}/{r['id']}.wav | {r['lang']} | {r['cer']} | {r.get('sim')} | {r['asr'][:40]} |" for r in worst]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", required=True, help="qwen, byteplus, or qwen,byteplus")
    ap.add_argument("--stars", default=",".join(STARS))
    ap.add_argument("--per-lang", type=int, default=5)
    ap.add_argument("--hant-check", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--byteplus-usd-per-10k", type=float, default=None)
    # Experiments (#73 zh-Hant): a subset of languages, another set of voices, how the text is sent.
    ap.add_argument("--langs", default=",".join(LANGS), help="only these languages, e.g. zh-Hant")
    ap.add_argument("--voices-tag", default="", help="use <provider>-voices-<tag>.json (an enrollment variant)")
    ap.add_argument("--tag", default="", help="a name for this run (in the report's file name)")
    ap.add_argument("--split", action="store_true", help="as production: one request per sentence, audio joined")
    ap.add_argument("--min-len", type=int, default=6, help="with --split: sentences shorter than this join the next")
    ap.add_argument("--prep", choices=list(PREPS), default="none", help="how her text is sent (CER is against what was meant to be said)")
    a = ap.parse_args()
    global VOICES_TAG
    VOICES_TAG = a.voices_tag
    providers = [p for p in a.provider.split(",") if p]
    if set(providers) - set(KEYS):
        sys.exit(f"unknown vendor: {', '.join(sorted(set(providers) - set(KEYS)))}")
    stars = [s for s in a.stars.split(",") if s]
    fish_model = os.environ.get("FISH_TTS_MODEL") or load_env("fish", ["FISH_TTS_MODEL"]).get("FISH_TTS_MODEL") or "s2.1-pro"
    prices = {**PRICE_USD_PER_10K, "byteplus": a.byteplus_usd_per_10k, "fish_model": fish_model}
    stamp = time.strftime("%Y%m%d-%H%M") + (f"-{a.tag}" if a.tag else "")
    want = set(a.langs.split(","))
    lines = {s: [x for x in pilot_lines(s, a.per_lang) if x["lang"] in want] for s in stars}

    # what is missing, before anything is sent
    problems = []
    for p in providers:
        v = voices_of(p)
        missing = [s for s in stars if s not in v]
        if missing:
            problems.append(f"{p}: no enrolled voice for {', '.join(missing)} (npm run voice:enroll -- --provider {p})")
        name, keys = KEYS[p]
        if not load_env(name, keys[:1]):
            problems.append(f"{p}: {keys[0]} not set (.env.{name}.local)")
    for path in (local_model("asr"), local_model("speaker")):
        if not Path(path).exists():
            problems.append(f"judge model missing: {path} (tools/voice/fetch_hf.sh)")
    n = sum(len(v) for v in lines.values())
    print(f"pilot {stamp}: {', '.join(providers)} × {len(stars)} talents × {n // max(1, len(stars))} lines"
          f"{' (+ Simplified zh-Hant)' if a.hant_check else ''}; voices home {VOICE_HOME}")
    for s in stars:
        by = {lang: sum(1 for x in lines[s] if x["lang"] == lang) for lang in LANGS}
        chars = sum(len(x["text"]) for x in lines[s])
        print(f"  {s:7} {by}  {chars} characters")
    for p in problems:
        print(f"  NOT READY  {p}")
    if a.dry_run:
        print("dry run: nothing sent" + ("" if problems else "; ready to run"))
        return
    if problems:
        sys.exit("not ready (see above)")

    run_dir = OUT / f"pilot-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    for p in providers:
        voices = voices_of(p)
        jobs = []
        for s in stars:
            for x in lines[s]:
                sent, meant = PREPS[a.prep](x["text"], x["lang"])
                jobs.append({"id": x["key"], "provider": p, "voiceId": voices[s]["voice"], "text": sent, "lang": x["lang"], "star": s, "ref_text": meant,
                             "split": a.split, "minLen": a.min_len})
                if a.hant_check and x["lang"] == "zh-Hant":
                    jobs.append({**jobs[-1], "id": x["key"] + "-hans", "text": to_simplified(x["text"]), "variant": "hans"})
        print(f"[{p}] synthesizing {len(jobs)} sentences …", flush=True)
        got = synthesize([{k: j[k] for k in ("id", "provider", "voiceId", "text", "lang", "split", "minLen")} for j in jobs], p, run_dir)
        for j in jobs:
            r = {**j, **got.get(j["id"], {"ok": False, "error": "no result"})}
            r["wav"] = str(run_dir / p / f"{j['id']}.wav")
            rows.append(r)
        print(f"[{p}] {sum(1 for r in rows if r['provider'] == p and r.get('ok'))}/{len(jobs)} ok", flush=True)
    score(rows)
    meta = {"stamp": stamp, "providers": providers, "stars": stars, "per_lang": a.per_lang, "hant_check": a.hant_check, "prices_usd_per_10k": prices,
            "langs": sorted(want), "voices_tag": a.voices_tag, "split": a.split, "min_len": a.min_len, "prep": a.prep,
            "fish_model": fish_model, "fish_latency": os.environ.get("FISH_TTS_LATENCY") or "balanced",
            "fish_temperature": os.environ.get("FISH_TTS_TEMPERATURE"), "fish_top_p": os.environ.get("FISH_TTS_TOP_P")}
    summary = summarise(rows, providers, stars, prices)
    (OUT / f"pilot-{stamp}.json").write_text(json.dumps({"meta": meta, "summary": summary, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    md = markdown(meta, summary, rows)
    (OUT / f"pilot-{stamp}.md").write_text(md, encoding="utf-8")
    print(md)
    print(f"-> {OUT / f'pilot-{stamp}.md'}")


if __name__ == "__main__":
    main()
