"""Her voice for the v1.1 scene scripts and system lines (#83), incremental.

    python3 tools/voice/make_scene_jobs.py list                  every line she speaks, and the skipped ones
    python3 tools/voice/make_scene_jobs.py jobs [--all]          JSONL for lines without an MP3 yet (all: every line)
    python3 tools/voice/make_scene_jobs.py ids --from FILE       JSONL for the ids in FILE (the redo flow)
    $V/venv-prep/bin/python tools/voice/make_scene_jobs.py pick  best passing take per scene line -> picks
    $V/venv-prep/bin/python tools/voice/make_scene_jobs.py master     picks -> MP3, loudness checked to ±0.5 LU
    python3 tools/voice/make_scene_jobs.py link [--check]        write `voice` into the scene / line JSON
    python3 tools/voice/make_scene_jobs.py report                QA table of the shipped scene voice
    python3 tools/voice/make_scene_jobs.py orphans [--delete]    MP3s no line refers to any more

What she says: every `line` step of the scenes (scenes/index.ts SCENES: the demo, the five, her variant scenes;
variants included; a step already voiced outside /voice/scene/ keeps its recording), and in
lines/<star>.json and lines/system.json every text she speaks aloud — the confession (not the written inbox
message), wake-up, woken, goodnight, weather, promise proposals (not the promise as the home card shows it),
call-name asks and answers, refusals, variant invitations, 奈々's reading paragraphs, えいみ's ōgiri prompts,
うんぱい's danmaku reactions (`text`; the `quote` of his comment is runtime-only) and アリス's bargaining tree (not
his offers). The confession and system scenes are built from those files, so their lines are covered there. A line
with a runtime placeholder (`{name}`, `{danmaku}`) is her runtime voice's (#73); its `unnamed` version (the same
moment without his name) is recorded, and linked as `unnamed.voice` (scenes/speech.ts `lineToSay`).

Every line is keyed by a hash of (star, Japanese text): `scene/<star>/<sha256(star:ja)[:12]>`, shipped at
apps/web/public/voice/scene/<star>/<hash>.mp3. A native-review edit (#84) changes the hash, so `jobs` emits only
the changed lines, and `link` drops the stale `voice` until the new file exists. TTS-only reading fixes go in
readings.json under the same id; takes of the same text from an earlier run are reused by `pick`.

Synthesis, scoring and the thresholds are the card pipeline's (README.md): synth_qwen.py --cands 3, qa.py score,
then `pick` here, which also requires her to be identified as herself (ECAPA margin > 0).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from common import PUBLIC_VOICE, REPO, STARS, TOOLS_DIR, WORK

SHARED = REPO / "packages" / "shared" / "src"
SCENE_VOICE = PUBLIC_VOICE / "scene"
PLACEHOLDER = re.compile(r"\{(name|danmaku)\}")

# Texts in the line files that are not spoken: a written message, the promise as a card, titles, his words.
NOT_SPOKEN = [
    re.compile(p) for p in (
        r"^\.confession\.inbox", r"^\.promises\[\d+\]\.promise(\.unnamed)?$", r"^\.readings\[\d+\]\.title",
        r"^\.bargain\.ask", r"^\.bargain\.branches\[\d+\]\.offer", r"^\.danmaku\[\d+\]\.quote",
    )
]
SYSTEM_SPOKEN = re.compile(r"^\.talents\.(?P<star>[a-z]+)\.")

# Acceptance (README "Production result"; qa.py passes()) plus likeness: identified as herself.
MAX_CER, MAX_DUR, MAX_CLIP, MIN_RMS_DB, MIN_MARGIN = 0.15, 12.0, 5e-4, -40.0, 0.0
TARGET_LUFS, LUFS_TOL = -16.0, 0.5
# 奈々's read-aloud paragraphs are long by design: up to the scene player's 15 s wait for a line (player.tsx).
MAX_DUR_READING = 15.0


def max_dur(row: dict) -> float:
    return MAX_DUR_READING if any(".readings[" in w for w in row["where"]) else MAX_DUR


def line_id(star: str, ja: str) -> str:
    return f"scene/{star}/{hashlib.sha256(f'{star}:{ja}'.encode()).hexdigest()[:12]}"


def voice_url(id_: str) -> str:
    return f"/voice/{id_}.mp3"


def mp3_path(id_: str) -> Path:
    return PUBLIC_VOICE / f"{id_}.mp3"


def is_text(node) -> bool:
    return isinstance(node, dict) and "ja" in node and "en" in node


def texts(node, at: str = ""):
    """Every three-language text in a JSON tree, in document order, as (path, node)."""
    if is_text(node):
        yield at, node
        if is_text(node.get("unnamed")):
            yield f"{at}.unnamed", node["unnamed"]
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from texts(v, f"{at}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from texts(v, f"{at}[{i}]")


def draft_scene_files() -> list[Path]:
    """The scripts: the demo and the five scenes (index.ts) and the variant cards' four layers (variantScenes.ts, #76)."""
    out: list[Path] = []
    for index in ("index.ts", "variantScenes.ts"):
        f = SHARED / "scenes" / index
        if f.exists():
            src = f.read_text(encoding="utf-8")
            out += [SHARED / "scenes" / m for m in re.findall(r"from '\./([a-z0-9-]+/[a-z0-9-]+\.json)'", src)]
    return list(dict.fromkeys(out))


def line_files() -> list[Path]:
    return [SHARED / "lines" / f"{s}.json" for s in STARS] + [SHARED / "lines" / "system.json"]


def spoken_in_lines(path: Path, at: str) -> str | None:
    """The talent speaking the text at `at` of a line file, or None when it is not spoken."""
    if path.stem == "system":
        m = SYSTEM_SPOKEN.match(at)
        return m["star"] if m and m["star"] in STARS else None
    return None if any(p.match(at) for p in NOT_SPOKEN) else path.stem


def spoken_step(s: dict) -> bool:
    """A line step she says in a recording: not her free-talk reply (agent) nor a runtime-voice (tts) line."""
    return s["type"] == "line" and not s.get("agent") and not s.get("tts")


def own_voice(s: dict) -> bool:
    """The step's voice is ours to set: none yet, or one of ours (the demo's greetings keep theirs)."""
    return not s.get("voice") or s["voice"].startswith("/voice/scene/")


def spoken_in_scene(step_texts: dict[int, str], at: str) -> bool:
    """A scene's text is spoken when it is a line step's text or one of its variants (or their `unnamed`)."""
    m = re.match(r"^\.steps\[(\d+)\]\.(text|variants\[\d+\]\.text)(\.unnamed)?$", at)
    return bool(m) and int(m[1]) in step_texts


def collect() -> tuple[dict[str, dict], list[dict]]:
    """(lines by id, skipped placeholder lines)."""
    lines: dict[str, dict] = {}
    skipped: list[dict] = []

    def add(star: str, ja: str, where: str) -> None:
        if PLACEHOLDER.search(ja):
            skipped.append({"star": star, "where": where, "text": ja})
            return
        i = line_id(star, ja)
        row = lines.setdefault(i, {"id": i, "star": star, "text": ja, "where": []})
        row["where"].append(where)

    for f in draft_scene_files():
        d = json.loads(f.read_text(encoding="utf-8"))
        star = d["meta"]["star"]
        steps = {i: s["id"] for i, s in enumerate(d["steps"]) if spoken_step(s)}
        for at, t in texts(d):
            own = re.match(r"^\.steps\[(\d+)\]\.text$", at)  # the step's own text: skip one voiced elsewhere
            if spoken_in_scene(steps, at) and not (own and not own_voice(d["steps"][int(own[1])])):
                add(star, t["ja"], f"scenes/{f.parent.name}/{f.name}{at}")
    for f in line_files():
        d = json.loads(f.read_text(encoding="utf-8"))
        for at, t in texts(d):
            star = spoken_in_lines(f, at)
            if star:
                add(star, t["ja"], f"lines/{f.name}{at}")
    return lines, skipped


def with_readings(rows: list[dict]) -> list[dict]:
    rd = json.load(open(TOOLS_DIR / "readings.json", encoding="utf-8"))
    out = []
    for r in rows:
        job = {"id": r["id"], "star": r["star"], "text": r["text"]}
        if r["id"] in rd:
            job["script"], job["text"] = r["text"], rd[r["id"]]
        out.append(job)
    return out


def emit(rows: list[dict]) -> None:
    order = {s: i for i, s in enumerate(STARS)}
    for r in with_readings(sorted(rows, key=lambda r: (order[r["star"]], r["where"][0]))):
        sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- QA

def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if p.exists() else []


def failures(r: dict, accepted: bool = False, dur: float = MAX_DUR) -> list[str]:
    out = []
    if r["cer"] > MAX_CER + (0.15 if accepted else 0):
        out.append(f"cer {r['cer']:.2f}")
    if r["dur_trim"] > dur:
        out.append(f"dur {r['dur_trim']:.1f}s")
    if r["clip_ratio"] >= MAX_CLIP:
        out.append("clipping")
    if r["rms_db"] <= MIN_RMS_DB:
        out.append("silent")
    if r["margin"] <= MIN_MARGIN:
        out.append(f"margin {r['margin']:.2f}")
    return out


def pick(out: Path) -> None:
    lines, _ = collect()
    rd = json.load(open(TOOLS_DIR / "readings.json", encoding="utf-8"))
    accept = json.load(open(TOOLS_DIR / "qa_accept.json", encoding="utf-8"))
    by_id: dict[str, list[dict]] = {}
    for r in read_jsonl(WORK / "cands" / "scores.jsonl"):
        if r["id"] in lines:
            by_id.setdefault(r["id"], []).append(r)
    picks, fails = [], []
    for i, rs in sorted(by_id.items()):
        want = rd.get(i, lines[i]["text"])  # only takes of the current reading count
        rs = [r for r in rs if r["text"] == want]
        if isinstance(accept.get(i), dict):  # a scene line accepted on one checked take: that take, CER gate aside
            ok = [r for r in rs if Path(r["wav"]).name == accept[i]["take"]
                  and not [f for f in failures(r, dur=max_dur(lines[i])) if not f.startswith("cer")]]
        else:
            ok = [r for r in rs if not failures(r, i in accept, max_dur(lines[i]))]
        if ok:
            picks.append(max(ok, key=lambda r: r["sim"] - 2.0 * r["cer"]))  # intelligibility first, then likeness
        elif rs:
            fails.append(min(rs, key=lambda r: (len(failures(r, dur=max_dur(lines[i]))), r["cer"])))
    with open(out, "w", encoding="utf-8") as f:
        for r in picks:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"picked {len(picks)}, failed {len(fails)}, not yet synthesised "
          f"{len([i for i in lines if i not in by_id and not mp3_path(i).exists()])} -> {out}")
    for r in fails:
        print(f"  FAIL {r['id']} {', '.join(failures(r, dur=max_dur(lines[r['id']])))} asr={r['asr']!r} text={r['text']!r}")


def master(picks: Path) -> None:
    """post.py's mastering, plus one gain correction measured on the MP3 when it lands outside ±0.5 LU."""
    import post
    lines, _ = collect()
    rows = read_jsonl(picks)
    done = {r["id"]: r for r in read_jsonl(WORK / "scene_mastered.jsonl")}
    log = open(WORK / "scene_mastered.jsonl", "a", encoding="utf-8")
    bad = 0
    for r in rows:
        out = mp3_path(r["id"])
        if out.exists() and done.get(r["id"], {}).get("wav") == r["wav"]:
            continue
        x, sr = post.master(r["wav"])
        post.encode(x, sr, out)
        m = post.measure(out)
        if abs(m["lufs"] - TARGET_LUFS) > LUFS_TOL / 2:
            x = post.soft_limit(x * 10 ** ((TARGET_LUFS - m["lufs"]) / 20))
            post.encode(x, sr, out)
            m = post.measure(out)
        ok = abs(m["lufs"] - TARGET_LUFS) <= LUFS_TOL and m["dur"] <= max_dur(lines[r["id"]])
        bad += not ok
        rec = {k: r.get(k) for k in ("id", "star", "text", "wav", "seed", "cer", "asr", "sim", "margin", "sim_other")}
        log.write(json.dumps({**rec, **m, "bytes": out.stat().st_size, "ok": ok}, ensure_ascii=False) + "\n")
        log.flush()
        print(f"{'ok ' if ok else 'BAD'} {r['id']} {m}", flush=True)
    log.close()
    print(f"mastered {len(rows)} picks ({bad} out of spec)")


def report() -> None:
    lines, skipped = collect()
    m = {r["id"]: r for r in read_jsonl(WORK / "scene_mastered.jsonl")}
    print(f"{'star':7} {'lines':>5} {'mp3':>4} {'sim':>6} {'margin':>6} {'self':>5} {'cer':>6} {'>5%':>4} "
          f"{'lufs':>13} {'dur':>11} {'KB':>6}")
    rows_all = []
    for s in STARS + ["ALL"]:
        ids = [i for i, r in lines.items() if s in ("ALL", r["star"])]
        rs = [m[i] for i in ids if i in m and mp3_path(i).exists()]
        if s != "ALL":
            rows_all += rs
        if not rs:
            print(f"{s:7} {len(ids):5d} {0:4d}")
            continue
        mean = lambda k: sum(r[k] for r in rs) / len(rs)
        print(f"{s:7} {len(ids):5d} {len(rs):4d} {mean('sim'):6.3f} {mean('margin'):6.3f} "
              f"{sum(r['margin'] > 0 for r in rs) / len(rs):5.0%} {mean('cer'):6.1%} "
              f"{sum(r['cer'] > 0.05 for r in rs):4d} "
              f"{min(r['lufs'] for r in rs):6.1f}…{max(r['lufs'] for r in rs):6.1f} "
              f"{min(r['dur'] for r in rs):4.1f}…{max(r['dur'] for r in rs):4.1f}s "
              f"{sum(r['bytes'] for r in rs) / 1024:6.0f}")
    print(f"skipped (placeholders): {len(skipped)}")


# ---------------------------------------------------------------- JSON

S = r'"(?:[^"\\]|\\.)*"'
TEXT_RE = re.compile(rf'(\{{\s*"ja"\s*:\s*({S})\s*,\s*"zh-Hant"\s*:\s*{S}\s*,\s*"en"\s*:\s*{S}'
                     rf'(?:\s*,\s*"ko"\s*:\s*{S})?)(\s*,\s*"voice"\s*:\s*"[^"]*")?((?=\s*(?:\}}|,\s*"unnamed")))')


def _set_text_voices(src: str, want: list[str | None]) -> str:
    """Set (or drop) `voice` on every three-language text object, in document order."""
    matches = list(TEXT_RE.finditer(src))
    if len(matches) != len(want):
        raise SystemExit(f"text objects: {len(matches)} in the file, {len(want)} parsed")
    out, pos = [], 0
    for mt, url in zip(matches, want):
        out.append(src[pos:mt.start()])
        body, close = mt[1], mt[4]
        compact = '":"' in body[:8]
        voice = "" if not url else (f',"voice":"{url}"' if compact else f', "voice": "{url}"')
        out.append(body + voice + close)
        pos = mt.end()
    return "".join(out) + src[pos:]


def _set_step_voice(src: str, step_id: str, url: str | None) -> str:
    rx = re.compile(rf'(\{{\s*"id"\s*:\s*"{re.escape(step_id)}"\s*,\s*"type"\s*:\s*"line"\s*,)(\s*"voice"\s*:\s*"[^"]*"\s*,)?')
    mt = rx.search(src)
    if not mt:
        raise SystemExit(f"line step {step_id} not found")
    compact = '":"' in mt[1]
    voice = "" if not url else (f'"voice":"{url}",' if compact else f' "voice": "{url}",')
    return src[:mt.start()] + mt[1] + voice + src[mt.end():]


def _strip_voice(node):
    if isinstance(node, dict):
        return {k: _strip_voice(v) for k, v in node.items() if k != "voice"}
    if isinstance(node, list):
        return [_strip_voice(v) for v in node]
    return node


def _voice_for(star: str, ja: str) -> str | None:
    if PLACEHOLDER.search(ja):
        return None
    i = line_id(star, ja)
    return voice_url(i) if mp3_path(i).exists() else None


def link(check: bool) -> None:
    changed = []
    for f in draft_scene_files() + line_files():
        src = f.read_text(encoding="utf-8")
        d = json.loads(src)
        new = src
        if f.parent.name == "lines":
            want = []
            for at, t in texts(d):
                star = spoken_in_lines(f, at)
                want.append(_voice_for(star, t["ja"]) if star else None)
            new = _set_text_voices(new, want)
        else:
            star = d["meta"]["star"]
            steps = {i: s for i, s in enumerate(d["steps"]) if spoken_step(s)}
            # Variants and `unnamed` versions carry their own voice in their text; a line step's voice is the step's.
            want = [_voice_for(star, t["ja"]) if spoken_in_scene(steps, at) and not re.match(r"^\.steps\[\d+\]\.text$", at)
                    else None for at, t in texts(d)]
            new = _set_text_voices(new, want)
            for s in steps.values():
                if own_voice(s):
                    new = _set_step_voice(new, s["id"], _voice_for(star, s["text"]["ja"]))
        if _strip_voice(json.loads(new)) != _strip_voice(d):
            raise SystemExit(f"{f}: content changed while linking")
        if new != src:
            changed.append(f)
            if not check:
                f.write_text(new, encoding="utf-8")
    for f in changed:
        print(f"{'would change' if check else 'linked'} {f.relative_to(REPO)}")
    if check and changed:
        sys.exit(1)


def orphans(delete: bool) -> None:
    lines, _ = collect()
    for p in sorted(SCENE_VOICE.glob("*/*.mp3")):
        i = f"scene/{p.parent.name}/{p.stem}"
        if i not in lines:
            print(p.relative_to(REPO))
            if delete:
                p.unlink()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["list", "jobs", "ids", "pick", "master", "link", "report", "orphans"])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--stars", default=",".join(STARS))
    ap.add_argument("--from", dest="from_")
    ap.add_argument("--out", default=str(WORK / "scene_picks.jsonl"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--delete", action="store_true")
    a = ap.parse_args()
    lines, skipped = collect()
    stars = set(a.stars.split(","))
    if a.cmd == "list":
        for r in lines.values():
            print(f"{r['id']}\t{mp3_path(r['id']).exists():d}\t{r['text']}\t{' '.join(r['where'])}")
        for r in skipped:
            print(f"SKIP\t{r['star']}\t{r['text']}\t{r['where']}")
        per = {s: sum(r["star"] == s for r in lines.values()) for s in STARS}
        print(f"# {len(lines)} lines {per}; {len(skipped)} skipped (placeholders)", file=sys.stderr)
    elif a.cmd == "jobs":
        emit([r for r in lines.values() if r["star"] in stars and (a.all or not mp3_path(r["id"]).exists())])
    elif a.cmd == "ids":
        want = {l.strip() for l in open(a.from_) if l.strip()}
        emit([r for r in lines.values() if r["id"] in want])
    elif a.cmd == "pick":
        pick(Path(a.out))
    elif a.cmd == "master":
        master(Path(a.out))
    elif a.cmd == "link":
        link(a.check)
    elif a.cmd == "report":
        report()
    else:
        orphans(a.delete)


if __name__ == "__main__":
    main()
