/**
 * npm run media:refs -- [--only mahiro,nana] [--step 0.6] [--count 20]
 * npm run media:refs -- --photos [--only mahiro] [--count 12]   (retouched card photos, see photoRefsFor)
 *
 * Likeness references from the agency's 4K interview clips (assets/agency/<star>/DSC_*.MOV, private,
 * never committed). Each clip is a locked-off seated front view with head turns, so it holds frontal,
 * three-quarter and profile views of the same face under the same light.
 *
 * 1. Seek-extract one frame every `step` seconds (one ffmpeg at a time, 2 threads: the machine is shared).
 * 2. Apple Vision (tools/media/face/face.swift) finds the face, its yaw and capture quality.
 * 3. Pick ~20 per talent with quotas per view (front, left/right three-quarter, profile), best quality
 *    first, at least 1.5 s apart so expressions vary.
 * 4. Write a head-and-hair crop (no body: nothing below the neck goes to an image API) and a tight
 *    roll-aligned face crop for scoring, plus refs.json with pose, quality and landmark geometry.
 *
 * Output: assets/agency/refs/<star>/{head,face}/<view>-<nn>.jpg|png and refs.json (gitignored with assets/agency/).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT } from './generate';
import { STARS, type Star } from './manifest';

const exec = promisify(execFile);

/** Private material lives in the main checkout even when this runs from a worktree. */
export const MAIN_ROOT = process.env.JSTAR_MAIN_ROOT ?? resolve(import.meta.dirname, '../../..').replace(/\/\.claude\/worktrees\/[^/]+$/, '');
export const AGENCY = join(MAIN_ROOT, 'assets/agency');
export const REFS = join(AGENCY, 'refs');
export const FACE_BIN = join(OUT, 'bin/face');
const FACE_SRC = resolve(import.meta.dirname, '../face/face.swift');

export interface Geometry { eyeWidth: number; eyeOpen: number; faceLength: number; noseWidth: number; mouthWidth: number; eyeMouth: number; chin: number }
export interface Face { x: number; y: number; w: number; h: number; yaw?: number; pitch?: number; roll?: number; quality?: number; geometry?: Geometry }
export interface Detection { file: string; width: number; height: number; faces: Face[] }
export type View = 'front' | 'left34' | 'right34' | 'profile';
export interface Ref { file: string; face: string; view: View; t: number; source: string; yaw: number; quality: number; facePx: number; geometry?: Geometry }

/** Build the Vision helper once (swiftc ships with the Xcode command line tools). */
export async function ensureFaceBin(): Promise<string> {
  if (!existsSync(FACE_BIN)) {
    await mkdir(join(OUT, 'bin'), { recursive: true });
    await exec('swiftc', ['-O', '-o', FACE_BIN, FACE_SRC]);
  }
  return FACE_BIN;
}

export async function detect(files: string[]): Promise<Detection[]> {
  const bin = await ensureFaceBin();
  const out: Detection[] = [];
  for (let i = 0; i < files.length; i += 12) {
    const { stdout } = await exec(bin, ['detect', ...files.slice(i, i + 12)], { maxBuffer: 16 << 20 });
    out.push(...stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Detection));
  }
  return out;
}

export async function faceCrop(image: string, out: string, px = 256, scale = 1.15): Promise<boolean> {
  try { await exec(await ensureFaceBin(), ['crop', image, out, String(px), String(scale)]); return true; } catch { return false; }
}

export const viewOf = (yaw: number): View => (Math.abs(yaw) < 9 ? 'front' : Math.abs(yaw) > 38 ? 'profile' : yaw > 0 ? 'left34' : 'right34');

const QUOTA: Record<View, number> = { front: 9, left34: 4, right34: 4, profile: 3 };

interface Frame { file: string; t: number; source: string; face: Face }

/** Greedy by quality within each view's quota, keeping frames of the same clip ≥ minGap seconds apart. */
export function pick(frames: Frame[], count: number, minGap = 1.5): Frame[] {
  const chosen: Frame[] = [];
  const far = (f: Frame) => chosen.every((c) => c.source !== f.source || Math.abs(c.t - f.t) >= minGap);
  const byQ = [...frames].sort((a, b) => (b.face.quality ?? 0) - (a.face.quality ?? 0));
  const scale = count / Object.values(QUOTA).reduce((a, b) => a + b, 0);
  for (const view of Object.keys(QUOTA) as View[]) {
    let n = Math.round(QUOTA[view] * scale);
    for (const f of byQ) { if (n <= 0) break; if (viewOf(f.face.yaw ?? 0) === view && far(f)) { chosen.push(f); n--; } }
  }
  for (const f of byQ) { if (chosen.length >= count) break; if (!chosen.includes(f) && far(f)) chosen.push(f); }
  return chosen;
}

async function duration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

/** Head and hair only: a square from above the hairline to just under the chin (`k` × face width, `top` of it above the face box). */
export function headBox(f: Face, width: number, height: number, k = 1.9, top = 0.62) {
  const side = Math.round(Math.min(f.w * k, width, height));
  const x = Math.round(Math.max(0, Math.min(width - side, f.x + f.w / 2 - side / 2)));
  const y = Math.round(Math.max(0, Math.min(height - side, f.y - f.w * top)));
  return { side, x, y };
}

async function refsFor(star: Star, step: number, count: number, log: (m: string) => void) {
  const dir = join(AGENCY, star);
  const clips = (await readdir(dir)).filter((f) => /^DSC_.*\.mov$/i.test(f)).sort();
  if (!clips.length) { log(`! ${star}: no clips`); return; }
  const tmp = join(OUT, 'refs-frames', star);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const frames: Frame[] = [];
  for (const clip of clips) {
    const src = join(dir, clip);
    const dur = await duration(src);
    const files: { file: string; t: number }[] = [];
    for (let t = 0.3; t < dur - 0.2; t += step) {
      const file = join(tmp, `${clip}-${t.toFixed(1)}.jpg`);
      await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-ss', t.toFixed(2), '-i', src, '-frames:v', '1', '-q:v', '2', '-y', file]);
      files.push({ file, t });
    }
    for (const d of await detect(files.map((f) => f.file))) {
      const face = d.faces[0];
      if (!face || d.faces.length > 1 || face.w < 200) continue;
      frames.push({ file: d.file, t: files.find((f) => f.file === d.file)!.t, source: clip, face });
    }
    log(`  ${star}/${clip}: ${files.length} frames, ${frames.length} usable so far`);
  }
  const chosen = pick(frames, count);
  const outDir = join(REFS, star);
  // Only the clip set (and likeness.ts's prints cache of it): photo/ and photos.json beside it come from --photos.
  await rm(join(outDir, 'prints.json'), { force: true });
  for (const sub of ['head', 'face']) {
    await rm(join(outDir, sub), { recursive: true, force: true });
    await mkdir(join(outDir, sub), { recursive: true });
  }
  const refs: Ref[] = [];
  const counters: Record<string, number> = {};
  const size = (await detect([chosen[0]?.file].filter(Boolean)))[0];
  for (const f of chosen.sort((a, b) => (b.face.quality ?? 0) - (a.face.quality ?? 0))) {
    const view = viewOf(f.face.yaw ?? 0);
    const n = (counters[view] = (counters[view] ?? 0) + 1);
    const name = `${view}-${String(n).padStart(2, '0')}`;
    const { side, x, y } = headBox(f.face, size?.width ?? 3840, size?.height ?? 2160);
    const head = join(outDir, 'head', `${name}.jpg`);
    await exec('ffmpeg', ['-v', 'error', '-i', f.file, '-vf', `crop=${side}:${side}:${x}:${y}`, '-q:v', '2', '-y', head]);
    const face = join(outDir, 'face', `${name}.png`);
    if (!(await faceCrop(f.file, face))) continue;
    refs.push({ file: `head/${name}.jpg`, face: `face/${name}.png`, view, t: Number(f.t.toFixed(1)), source: f.source, yaw: Number((f.face.yaw ?? 0).toFixed(1)), quality: Number((f.face.quality ?? 0).toFixed(3)), facePx: Math.round(f.face.w), geometry: f.face.geometry });
  }
  await writeFile(join(outDir, 'refs.json'), `${JSON.stringify({ star, extractedAt: new Date().toISOString(), refs }, null, 2)}\n`);
  await rm(tmp, { recursive: true, force: true });
  const views = refs.reduce<Record<string, number>>((a, r) => ({ ...a, [r.view]: (a[r.view] ?? 0) + 1 }), {});
  log(`✓ ${star}: ${refs.length} refs ${JSON.stringify(views)}, face ${Math.min(...refs.map((r) => r.facePx))}–${Math.max(...refs.map((r) => r.facePx))} px`);
}

/**
 * Still-photo references from the agency's retouched physical-card shoot (assets/agency/cards/manifest.json).
 * Kept apart from the clip set (refs.json): published cards were generated and judged against the clips, and
 * retouched photos carry smoothing, make-up and face stickers. The photos are semi-nude, so only a tighter
 * head crop (to the chin) and the aligned face crop are written.
 *
 * Output: assets/agency/refs/<star>/photo/{head,face}/<view>-<nn>.jpg|png and photos.json.
 */
export const CARDS = join(AGENCY, 'cards');
export interface CardPhoto { file: string; tier: string; code: string | null; star: string | string[] | null; starSource: string | null; shot: number }
export interface PhotoRef extends Ref { tier: string; code: string | null; confirmed: boolean }
/** Single-talent card photos of a star; two-shots and replaced files (star null) are skipped. */
export const photosOf = (images: CardPhoto[], star: Star) => images.filter((p) => p.star === star && p.tier !== 'TR');
export const photoHeadBox = (f: Face, width: number, height: number) => headBox(f, width, height, 1.7, 0.6);
const PHOTO_DETECT_PX = 2400;

async function photoRefsFor(star: Star, count: number, log: (m: string) => void) {
  const { images } = JSON.parse(await readFile(join(CARDS, 'manifest.json'), 'utf8')) as { images: CardPhoto[] };
  const photos = photosOf(images, star);
  if (!photos.length) { log(`! ${star}: no card photos`); return; }
  const tmp = join(OUT, 'refs-photos', star);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  // Vision on a 2400 px copy (the originals are 5504×8256); crops come from the original.
  const small = new Map<string, CardPhoto>();
  for (const [i, p] of photos.entries()) {
    const file = join(tmp, `${String(i).padStart(2, '0')}.jpg`);
    await exec('sips', ['-Z', String(PHOTO_DETECT_PX), join(CARDS, p.file), '--out', file]);
    small.set(file, p);
  }
  const frames: Frame[] = [];
  const sizes = new Map<string, { width: number; height: number }>();
  for (const d of await detect([...small.keys()])) {
    const face = d.faces[0];
    if (!face || d.faces.length > 1 || face.w < 160) continue;
    frames.push({ file: d.file, t: 0, source: small.get(d.file)!.file, face });
    sizes.set(d.file, d);
  }
  const chosen = pick(frames, count, 0);
  const outDir = join(REFS, star, 'photo');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'head'), { recursive: true });
  await mkdir(join(outDir, 'face'), { recursive: true });
  const refs: PhotoRef[] = [];
  const counters: Record<string, number> = {};
  for (const f of chosen.sort((a, b) => (b.face.quality ?? 0) - (a.face.quality ?? 0))) {
    const p = small.get(f.file)!;
    const view = viewOf(f.face.yaw ?? 0);
    const n = (counters[view] = (counters[view] ?? 0) + 1);
    const name = `${view}-${String(n).padStart(2, '0')}`;
    const { width, height } = sizes.get(f.file)!;
    const { side, x, y } = photoHeadBox(f.face, width, height);
    const s = (await exec('sips', ['-g', 'pixelWidth', join(CARDS, p.file)])).stdout.match(/pixelWidth: (\d+)/)![1];
    const k = Number(s) / width;
    const head = join(outDir, 'head', `${name}.jpg`);
    await exec('ffmpeg', ['-v', 'error', '-i', join(CARDS, p.file), '-vf', `crop=${Math.round(side * k)}:${Math.round(side * k)}:${Math.round(x * k)}:${Math.round(y * k)},scale='min(1024,iw)':-2`, '-q:v', '2', '-y', head]);
    const face = join(outDir, 'face', `${name}.png`);
    if (!(await faceCrop(f.file, face))) continue;
    refs.push({ file: `photo/head/${name}.jpg`, face: `photo/face/${name}.png`, view, t: 0, source: p.file, yaw: Number((f.face.yaw ?? 0).toFixed(1)), quality: Number((f.face.quality ?? 0).toFixed(3)), facePx: Math.round(f.face.w * k), geometry: f.face.geometry, tier: p.tier, code: p.code, confirmed: p.starSource === 'filename' });
  }
  await writeFile(join(REFS, star, 'photos.json'), `${JSON.stringify({ star, extractedAt: new Date().toISOString(), from: 'assets/agency/cards/manifest.json', refs }, null, 2)}\n`);
  await rm(tmp, { recursive: true, force: true });
  const views = refs.reduce<Record<string, number>>((a, r) => ({ ...a, [r.view]: (a[r.view] ?? 0) + 1 }), {});
  log(`✓ ${star}: ${refs.length} photo refs from ${frames.length}/${photos.length} usable photos ${JSON.stringify(views)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const stars = (arg('--only')?.split(',') ?? [...STARS]) as Star[];
  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  if (args.includes('--photos')) { for (const star of stars) await photoRefsFor(star, Number(arg('--count') ?? 12), log); return; }
  for (const star of stars) await refsFor(star, Number(arg('--step') ?? 0.6), Number(arg('--count') ?? 20), log);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
