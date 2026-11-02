"""Publishes the scene batch (docs/lipsync.md § 6): uploads the renders to R2 and writes the web app's manifest.

    set -a && . ./.env.cloudflare.local && set +a
    /tmp/modalvenv/bin/modal volume get jstar-lipsync out tools/lipsync/out/r2      # the batch's renders
    python3 tools/lipsync/publish.py [--dir tools/lipsync/out/r2/out] [--manifest-only]
        [--phases-dir tools/lipsync/out/r2/phase --phase-result tools/lipsync/out/phase-result.json]

- Upload: every `<clip>/<voice id>-<w>x<h>.mp4` to bucket `jstar-lipsync` as `v1/<clip>/<voice id>-<w>x<h>.mp4`
  (Cloudflare REST API, curl, 8 at a time; uploaded keys are remembered in `<dir>/../uploaded.txt`, so a rerun only
  sends what is new). The Worker serves them at `/lipsync/v1/...` (infra/cloudflare/src/lipsync.ts).
- Manifest: apps/web/src/data/lipsync.gen.json — `{ "<clip id>": ["<voice id>", ...] }`, a line listed only when
  both its sizes exist. The scene player (apps/web/src/scene/lipsync.ts) plays a line's render when it is listed.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MAIN = Path(subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=HERE,
                                    text=True).strip()).parent
BUCKET = "jstar-lipsync"
PREFIX = "v1"
NAME = re.compile(r"^([0-9a-f]{12})-(\d+)x(\d+)\.mp4$")
PHASE = re.compile(r"^([0-9a-f]{12})-p(\d+)-(\d+)x(\d+)\.mp4$")


def renders(root: Path) -> dict[str, dict[str, list[Path]]]:
    out: dict[str, dict[str, list[Path]]] = {}
    for clip in sorted(p for p in root.iterdir() if p.is_dir()):
        for f in sorted(clip.iterdir()):
            m = NAME.match(f.name)
            if m:
                out.setdefault(clip.name, {}).setdefault(m.group(1), []).append(f)
    return out


def put(key: str, path: Path) -> tuple[str, bool, str]:
    acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/{BUCKET}/objects/{key}"
    r = subprocess.run(["curl", "-sS", "-X", "PUT", url, "-H", f"Authorization: Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
                        "-H", "Content-Type: video/mp4", "--data-binary", f"@{path}", "-w", "\n%{http_code}"],
                       capture_output=True, text=True)
    code = r.stdout.strip().rsplit("\n", 1)[-1]
    return key, code == "200", (r.stdout + r.stderr)[-300:]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(MAIN / "tools" / "lipsync" / "out" / "r2" / "out"))
    ap.add_argument("--manifest-only", action="store_true")
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--phases-dir", default="", help="phase renders (modal volume get jstar-lipsync phase <dir>)")
    ap.add_argument("--phase-result", default="", help="modal_app.py::phases output (clip frame counts)")
    a = ap.parse_args()
    root = Path(a.dir)
    found = renders(root)
    complete = {clip: sorted(v for v, files in voices.items() if len(files) >= 2) for clip, voices in found.items()}
    complete = {c: v for c, v in complete.items() if v}
    if not a.manifest_only:
        ledger = root.parent / "uploaded.txt"
        done = set(ledger.read_text().split()) if ledger.exists() else set()
        todo = [(f"{PREFIX}/{clip}/{f.name}", f) for clip, voices in found.items() for files in voices.values() for f in files]
        todo = [t for t in todo if t[0] not in done]
        print(f"{len(todo)} to upload ({len(done)} already)")
        failed = 0
        with cf.ThreadPoolExecutor(a.jobs) as ex, open(ledger, "a") as led:
            for i, (key, ok, msg) in enumerate(ex.map(lambda t: put(*t), todo)):
                if ok:
                    led.write(key + "\n")
                else:
                    failed += 1
                    print("FAILED", key, msg)
                if i % 200 == 0:
                    print(i, flush=True)
        print(f"uploaded {len(todo) - failed}, failed {failed}")
        if failed:
            raise SystemExit(1)
    if a.phases_dir:
        publish_phases(Path(a.phases_dir), Path(a.phase_result), a.jobs, a.manifest_only)
    path = REPO / "apps" / "web" / "src" / "data" / "lipsync.gen.json"
    path.write_text(json.dumps(complete, separators=(",", ":"), sort_keys=True) + "\n")
    print(f"{path.relative_to(REPO)}: {len(complete)} clips, {sum(len(v) for v in complete.values())} lines")


def publish_phases(root: Path, result: Path, jobs: int, manifest_only: bool) -> None:
    """Phase renders (720p, every `step`-th frame of a scene clip; infra/lipsync modal_app.py::phases) to R2 under the
    same prefix, and apps/web/src/data/lipsync.phases.gen.json: {step, clips: {clip: {n, ids}}} — a line is listed for
    a clip only when every one of its phases is there (the player may ask for any of them)."""
    res = json.loads(result.read_text())["results"]
    step = next((r["step"] for r in res if r.get("step")), 7)
    frames = {r["clip"]: r["frames"] for r in res if r.get("frames")}
    have: dict[str, dict[str, set[int]]] = {}
    files: list[tuple[str, Path]] = []
    for clip in sorted(p for p in root.iterdir() if p.is_dir()):
        for f in sorted(clip.iterdir()):
            m = PHASE.match(f.name)
            if m:
                have.setdefault(clip.name, {}).setdefault(m.group(1), set()).add(int(m.group(2)))
                files.append((f"{PREFIX}/{clip.name}/{f.name}", f))
    if not manifest_only:
        ledger = root.parent / "uploaded-phases.txt"
        done = set(ledger.read_text().split()) if ledger.exists() else set()
        todo = [t for t in files if t[0] not in done]
        print(f"phases: {len(todo)} to upload ({len(done)} already)")
        failed = 0
        with cf.ThreadPoolExecutor(jobs) as ex, open(ledger, "a") as led:
            for i, (key, ok, msg) in enumerate(ex.map(lambda t: put(*t), todo)):
                if ok:
                    led.write(key + "\n")
                else:
                    failed += 1
                    print("FAILED", key, msg)
                if i % 500 == 0:
                    print(i, flush=True)
        print(f"phases uploaded {len(todo) - failed}, failed {failed}")
        if failed:
            raise SystemExit(1)
    clips = {}
    for clip, ids in have.items():
        n = frames.get(clip)
        if not n:
            continue
        want = set(range(step, n, step))
        ok = sorted(i for i, ps in ids.items() if want <= ps)
        if ok:
            clips[clip] = {"n": n, "ids": ok}
    path = REPO / "apps" / "web" / "src" / "data" / "lipsync.phases.gen.json"
    path.write_text(json.dumps({"step": step, "clips": clips}, separators=(",", ":"), sort_keys=True) + "\n")
    print(f"{path.relative_to(REPO)}: {len(clips)} clips, {sum(len(c['ids']) for c in clips.values())} lines")


if __name__ == "__main__":
    main()
