/**
 * npm run media:check -- <video>…   (or --only id,id [--draft] [--judge] [--retimed] to check generations by shot id;
 *                                    --retimed checks out/retimed/<id>.mp4 from media:process where it exists)
 *
 * Motion QA for character clips, measured rather than eyeballed: Apple Vision landmarks (face.swift) on every
 * frame at 24 fps give eye openness; a blink is a run of frames below 60% of the clip's median openness.
 * v1 blinks lasted ~0.8 s and read as sleepy; the target is 0.2–0.3 s. One ffmpeg at a time, 2 threads.
 *
 * Seams (#79): a keyframe-locked loop must end on the frame it started on, and a chained clip
 * (Shot.frames.first = { after }) must start on the frame the previous clip ended on. Both are measured as
 * the mean absolute difference of 64×64 grayscale thumbnails (0–255): locked loops and clips anchored to the
 * same still measure about 1, a cut to another take of the same room 6+ (a 480p draft next to its own 1080p
 * final: 6.4), another room 40+. Drafts are compared with drafts, finals with finals.
 *
 * Clips where she leaves, enters or turns away lose her face on purpose: for shots with frames, the face is
 * required only on the ends that show her keyframe, and eyes are measured only where the face is near-frontal
 * and large enough for the landmarks to mean something.
 *
 * Cuts: two stills rendered separately (e.g. a seated keyframe and an empty-room still) rarely share the exact
 * camera, and Seedance may then join them with a hard cut inside the clip. A cut is a frame-to-frame thumbnail
 * step of at least CUT_STEP that is also CUT_RATIO× the largest step around it; fast hand motion (mahiro's
 * rock-paper-scissors: 13.6 next to 12.4) is sustained, a cut (eimi-leave v1: 21.5 next to ≤ 7) is a spike.
 *
 * Anchors (#24): a clip that starts or ends on one of her keyframes (an entrance ending on the v1 hero frame, so
 * the site cuts straight into the hero loop) is also compared with that keyframe image: the same thumbnail
 * difference, at most MAX_ANCHOR_DIFF.
 *
 * --judge: the likeness judge (judge.ts, 1–5, pass 4) on up to three frames where her face is largest.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT } from './generate';
import { KEYFRAMES, loadRecord } from './keyframes';
import { SHOTS, anchorsOf, hasPerson, type Shot, type Star } from './manifest';
import { detect, type Face } from './refs';

const exec = promisify(execFile);
export const FPS = 24;
/** Longest acceptable blink (the brief asks for 0.2–0.3 s; one frame of measurement slack). */
export const MAX_BLINK_S = 0.34;
/** Largest thumbnail difference at a loop or chain seam that still reads as the same frame (0–255). */
export const MAX_SEAM = 3;
/** Eyes are measured only on faces at least this wide (px, frames scaled to 1280 on the long side) … */
export const MIN_EYE_FACE_PX = 56;
/** … and no more than this far turned from the lens (degrees): a head turning away is not a blink. */
export const MAX_EYE_YAW = 30;
/** A hard cut inside a clip: a thumbnail step at least this big … */
export const CUT_STEP = 15;
/** … and this many times the largest step within two frames either side. */
export const CUT_RATIO = 2.5;
/** Largest acceptable thumbnail difference between a clip's first/last frame and its anchor keyframe (0–255). */
export const MAX_ANCHOR_DIFF = 12;

export interface Blink { at: number; duration: number }
export interface MotionReport {
  file: string; frames: number; faceless: number; blinks: Blink[]; longest: number;
  /** Eye-openness difference between the first and last frame (people loops). */
  seam: number;
  /** Thumbnail difference between the first and last frame (loops). */
  loopSeam?: number;
  /** Thumbnail difference between the previous clip's last frame and this clip's first (chains). */
  chainSeam?: { after: string; diff: number };
  likeness?: { scores: number[]; median: number; frames: number[] };
  /** Seconds at which the clip hard-cuts (should be none). */
  cuts?: number[];
  /** Thumbnail difference between the clip's first / last frame and the keyframe of her it is anchored to. */
  anchors?: { first?: number; last?: number };
  ok: boolean; problems?: string[];
}

/** Runs of "closed" frames (openness below `ratio` × median); NaN (no face) never counts as closed. */
export function findBlinks(openness: number[], fps = FPS, ratio = 0.6): Blink[] {
  const valid = openness.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!valid.length) return [];
  const limit = valid[Math.floor(valid.length / 2)] * ratio;
  const out: Blink[] = [];
  for (let i = 0; i < openness.length; i++) {
    if (!(openness[i] < limit)) continue;
    let j = i;
    while (j + 1 < openness.length && openness[j + 1] < limit) j++;
    out.push({ at: Number((i / fps).toFixed(2)), duration: Number(((j - i + 1) / fps).toFixed(2)) });
    i = j;
  }
  return out;
}

export function judgeMotion(file: string, openness: number[], fps = FPS): MotionReport {
  const blinks = findBlinks(openness, fps);
  const longest = Math.max(0, ...blinks.map((b) => b.duration));
  const seam = Math.abs((openness[0] ?? 0) - (openness[openness.length - 1] ?? 0));
  const faceless = openness.filter((x) => Number.isNaN(x)).length;
  return { file, frames: openness.length, faceless, blinks, longest, seam: Number(seam.toFixed(3)), ok: longest <= MAX_BLINK_S && faceless === 0 && seam < 0.05 };
}

/** Eye openness of a detected face, or NaN when the face is missing, small or turned away. */
export function eyeOpenness(face: Face | undefined): number {
  if (!face?.geometry || face.w < MIN_EYE_FACE_PX || Math.abs(face.yaw ?? 0) > MAX_EYE_YAW) return NaN;
  return face.geometry.eyeOpen;
}

/** Mean absolute difference of two equal-length grayscale thumbnails. */
export function mad(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return Number((d / a.length).toFixed(2));
}

/** Hard cuts inside a clip, as frame indices of the first frame after the cut. */
export function findCuts(frames: Uint8Array[]): number[] {
  const steps = frames.slice(1).map((f, i) => mad(frames[i], f));
  const cuts: number[] = [];
  steps.forEach((d, i) => {
    const around = [...steps.slice(Math.max(0, i - 2), i), ...steps.slice(i + 1, i + 3)];
    if (d >= CUT_STEP && d >= CUT_RATIO * Math.max(0.5, ...around)) cuts.push(i + 1);
  });
  return cuts;
}

/**
 * Pass/fail for a shot with first/last frames: blinks, face on the ends that show her, and the seams.
 * `faces[i]` is whether frame i has a face at all (any size or angle).
 */
export function judgeFramed(shot: Shot, r: Pick<MotionReport, 'longest' | 'loopSeam' | 'chainSeam' | 'cuts'>, faces: boolean[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const { first, last } = anchorsOf(shot);
  if (r.longest > MAX_BLINK_S) problems.push(`blink ${r.longest}s > ${MAX_BLINK_S}s`);
  if (hasPerson(first) && !faces[0]) problems.push('no face on the first frame');
  if (hasPerson(last) && !faces[faces.length - 1]) problems.push('no face on the last frame');
  if (shot.frames?.end === 'empty' && faces[faces.length - 1]) problems.push('she is still in the last frame');
  if (r.cuts?.length) problems.push(`hard cut at ${r.cuts.map((c) => `${c}s`).join(', ')}`);
  if (shot.loop && (r.loopSeam ?? Infinity) > MAX_SEAM) problems.push(`loop seam ${r.loopSeam} > ${MAX_SEAM}`);
  if (r.chainSeam && r.chainSeam.diff > MAX_SEAM) problems.push(`chain seam after ${r.chainSeam.after} ${r.chainSeam.diff} > ${MAX_SEAM}`);
  return { ok: !problems.length, problems };
}

const THUMB = ['-vf', 'scale=64:64:flags=area,format=gray', '-f', 'rawvideo', '-'];
export async function thumbs(file: string): Promise<Uint8Array[]> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', file, ...THUMB], { encoding: 'buffer', maxBuffer: 1 << 27 });
  const buf = stdout as unknown as Buffer;
  const out: Uint8Array[] = [];
  for (let o = 0; o + 4096 <= buf.length; o += 4096) out.push(new Uint8Array(buf.subarray(o, o + 4096)));
  return out;
}

/** Frame indices of the largest faces, at least `gap` frames apart (the likeness judge's candidates). */
export function largestFaces(widths: number[], n = 3, gap = FPS): number[] {
  const order = widths.map((w, i) => ({ w, i })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
  const out: number[] = [];
  for (const { i } of order) if (out.length < n && out.every((j) => Math.abs(j - i) >= gap)) out.push(i);
  return out.sort((a, b) => a - b);
}

export async function measure(video: string, opts: { keep?: (files: string[], faces: (Face | undefined)[]) => Promise<void> } = {}): Promise<MotionReport & { faceWidths: number[]; faceFrames: boolean[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'motion-'));
  try {
    await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', video, '-vf', `fps=${FPS},scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'`, '-q:v', '3', join(dir, '%04d.jpg')]);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort().map((f) => join(dir, f));
    const dets = await detect(files);
    const faces = dets.map((d) => [...d.faces].sort((a, b) => b.w - a.w)[0]);
    const report = judgeMotion(basename(video), faces.map(eyeOpenness));
    // "No face" means no face at all; a small or turned face only leaves the eye measurement out.
    report.faceless = faces.filter((f) => !f).length;
    report.ok = report.longest <= MAX_BLINK_S && report.faceless === 0 && report.seam < 0.05;
    if (opts.keep) await opts.keep(files, faces);
    return { ...report, faceWidths: faces.map((f) => f?.w ?? 0), faceFrames: faces.map((f) => !!f) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const rawFile = (id: string, draft: boolean) => join(OUT, 'raw', `${id}${draft ? '.draft' : ''}.mp4`);
/** The clip as media:process leaves it (slow blinks sped up) when asked for and present, else the raw clip. */
export const clipFile = (id: string, draft: boolean, retimed = false) => {
  const r = join(OUT, 'retimed', `${id}.mp4`);
  return retimed && !draft && existsSync(r) ? r : rawFile(id, draft);
};

/** Everything media:check measures for one shot's clip; the report also goes to out/check/<id>[.draft].json. */
/** The picked keyframe image of a shot (out/keyframes/v2/<shot>.json), when it is on this machine. */
async function keyframeImage(shotId: string): Promise<string | undefined> {
  const pick = (await loadRecord(shotId))?.pick;
  return pick && existsSync(join(KEYFRAMES, pick)) ? join(KEYFRAMES, pick) : undefined;
}

export async function checkShot(shot: Shot, draft: boolean, withJudge: boolean, log: (m: string) => void = () => {}, retimed = false): Promise<MotionReport> {
  const file = clipFile(shot.id, draft, retimed);
  let judged: { scores: number[]; frames: number[] } | undefined;
  const m = await measure(file, {
    keep: withJudge && shot.talent ? async (files, faces) => {
      const { judge } = await import('./judge');
      const picks = largestFaces(faces.map((f) => f?.w ?? 0));
      const scores: number[] = [];
      for (const i of picks) scores.push((await judge(shot.talent as Star, files[i], { id: `${shot.id} frame ${i}` })).score);
      judged = { scores, frames: picks };
    } : undefined
  });
  const r: MotionReport = { file: m.file, frames: m.frames, faceless: m.faceless, blinks: m.blinks, longest: m.longest, seam: m.seam, ok: m.ok };
  const t = await thumbs(file);
  const fps = t.length / (m.frames / FPS || 1);
  r.cuts = findCuts(t).map((i) => Number((i / fps).toFixed(2)));
  if (r.cuts.length) r.ok = false;
  if (shot.loop) r.loopSeam = mad(t[0], t[t.length - 1]);
  const after = shot.frames?.first && typeof shot.frames.first === 'object' && 'after' in shot.frames.first ? shot.frames.first.after : undefined;
  if (after && existsSync(rawFile(after, draft))) {
    const prev = await thumbs(clipFile(after, draft, retimed));
    r.chainSeam = { after, diff: mad(prev[prev.length - 1], t[0]) };
  }
  if (judged) {
    const s = [...judged.scores].sort((a, b) => a - b);
    r.likeness = { ...judged, median: s[Math.floor(s.length / 2)] ?? 0 };
  }
  if (shot.frames) {
    Object.assign(r, judgeFramed(shot, r, m.faceFrames));
    const { first, last } = anchorsOf(shot);
    const image = async (a: typeof first) => (a && 'keyframe' in a ? keyframeImage(a.keyframe) : undefined);
    const [fi, li] = [await image(first), await image(last)];
    if (fi || li) {
      r.anchors = { ...(fi ? { first: mad(t[0], (await thumbs(fi))[0]) } : {}), ...(li ? { last: mad(t[t.length - 1], (await thumbs(li))[0]) } : {}) };
      for (const end of ['first', 'last'] as const) {
        const d = r.anchors[end];
        if (d !== undefined && d > MAX_ANCHOR_DIFF) { r.ok = false; (r.problems ??= []).push(`${end} frame ${d} from its keyframe > ${MAX_ANCHOR_DIFF}`); }
      }
    }
  }
  await mkdir(join(OUT, 'check'), { recursive: true });
  await writeFile(join(OUT, 'check', `${shot.id}${draft ? '.draft' : file.includes('/retimed/') ? '.retimed' : ''}.json`), `${JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2)}\n`);
  log(line(shot.id, r));
  return r;
}

const line = (id: string, r: MotionReport) => `${r.ok ? '✓' : '✗'} ${id.padEnd(24)} blinks ${r.blinks.map((b) => `${b.at}s/${b.duration}s`).join(' ') || '—'}` +
  `${r.loopSeam !== undefined ? `  loop seam ${r.loopSeam}` : ''}${r.chainSeam ? `  seam after ${r.chainSeam.after} ${r.chainSeam.diff}` : ''}${r.anchors ? `  anchor ${r.anchors.first ?? '—'}/${r.anchors.last ?? '—'}` : ''}` +
  `${r.cuts?.length ? `  CUT at ${r.cuts.join(', ')}s` : ''}${r.faceless ? `  no face in ${r.faceless} frames` : ''}${r.likeness ? `  likeness ${r.likeness.scores.join('/')}` : ''}${r.problems?.length ? `  — ${r.problems.join('; ')}` : ''}`;

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--only');
  const draft = args.includes('--draft');
  let bad = 0;
  if (i >= 0) {
    for (const id of args[i + 1].split(',')) {
      const shot = SHOTS.find((s) => s.id === id);
      if (!shot) throw new Error(`unknown shot ${id}`);
      const r = await checkShot(shot, draft, args.includes('--judge'), console.log, args.includes('--retimed'));
      if (!r.ok) bad++;
    }
  } else {
    for (const f of args.filter((a) => !a.startsWith('--'))) {
      const r = await measure(f);
      if (!r.ok) bad++;
      console.log(`${r.ok ? '✓' : '✗'} ${r.file.padEnd(36)} blinks ${r.blinks.map((b) => `${b.at}s/${b.duration}s`).join(' ') || '—'}  seam ${r.seam}${r.faceless ? `  no face in ${r.faceless} frames` : ''}`);
    }
  }
  if (bad) { console.log(`${bad} clip(s) outside the motion targets (blink ≤ ${MAX_BLINK_S}s, seams ≤ ${MAX_SEAM}, anchors ≤ ${MAX_ANCHOR_DIFF})`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
