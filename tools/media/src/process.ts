/**
 * npm run media:process -- [--only id,id] [--force]
 * npm run media:process -- --only id,id --retime-only   only speed slow blinks up (out/retimed/<id>.mp4): nothing
 *                                                      is published to the site (review packs of unapproved clips)
 *
 * Raw generations (out/raw) → web assets in apps/web/public/media/<id>/ and a typed index the site imports, in two
 * parts: apps/web/src/data/media.gen.ts (the first screens' clips, in the entry bundle) and
 * apps/web/src/data/media.scene.gen.ts (clips no first screen needs, a lazy chunk; see SCENE_MEDIA_ID). Loops are made
 * seamless, every video gets a poster so the first paint never waits for video, and turntables become multi-view
 * sheets.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SHOTS, type Shot } from './manifest';
import { OUT, ROOT, type State } from './generate';
import { measure, type Blink } from './motion';

const run = promisify(execFile);
export const WEB_MEDIA = join(ROOT, 'apps/web/public/media');
const INDEX = join(ROOT, 'apps/web/src/data/media.gen.ts');
const SCENE_INDEX = join(ROOT, 'apps/web/src/data/media.scene.gen.ts');
const SCENE_DATA = join(ROOT, 'apps/web/src/data/media.scene.gen.json');

/**
 * Clips no first screen needs: her scenes' shots, her seated talk / idle loops, the system scenes, her confession,
 * every variant clip (entrance, close-up, home loop), her morning room and morning hero loop. They go to the lazy
 * catalogue (media.scene.gen.ts), which the web loads when her room opens — at once when her room may show a morning
 * or variant look, in idle time otherwise — and which the scene player and the wake-up screen await. The entry bundle
 * carries only what the first screens need: the public home's hero / herohd / presence clips (breath, night, day,
 * entrance, reactions), her costume and prop stills, the gacha and loading screens' clips.
 */
export const SCENE_MEDIA_ID = /^[a-z]+-(?:scene|talk|talkclose|idle|sys|confession|variant|morning|hero-morning)-/;

/**
 * Seconds of tail crossfaded into the head. v1 used 1 s: long enough that a smile visibly "melted" and eyes
 * doubled on character loops, and a fluttering scarf ghosted. Now ≤ 0.3 s, applied at the best-matching cut
 * points (see bestLoop); character loops are also anchored to one keyframe at both ends (Shot.lock).
 */
export const XFADE = 0.3;
/** How far into the head and tail bestLoop may move the cut points, in seconds. */
export const LOOP_SEARCH = 1.5;

/**
 * `crf` overrides the codec default (AV1 38 for scenes; faces get 32 so skin and eyes keep their detail).
 * `suffix` ('-hq') names a high-quality re-encode written beside an earlier one instead of over it.
 */
export interface Variant { width: number; height: number; codec: 'h264' | 'av1'; crf?: number; suffix?: string; vq?: boolean }
export const AV1_CRF_CHARACTER = 32;
/**
 * Shot.encode 'hq' (#24 phase 4). Measured on these low-motion talent clips (Seedance HEVC masters ~5.9 Mbps):
 * AV1 CRF 23 gave only 1.4 Mbps and CRF 18 1.9 Mbps, so quality is set by CRF, not a bitrate target: AV1 CRF 20
 * with SVT-AV1's visual-quality tune (~1.9 Mbps, ~2.5× v1), H.264 CRF 17 (~3.2 Mbps), 720p H.264 CRF 20.
 */
export const HQ = { av1: 20, h264: 17, h264Small: 20, posterQ: 2, suffix: '-hq' } as const;

/** The variants a shot is encoded to: sizes from the source, quality and file suffix from the shot. */
export function variantsForShot(shot: Pick<Shot, 'category' | 'encode'>, src: { width: number; height: number }): Variant[] {
  const [big, bigH264, small] = variantsFor(src);
  if (shot.encode === 'hq') return [{ ...big, crf: HQ.av1, suffix: HQ.suffix, vq: true }, { ...bigH264, crf: HQ.h264, suffix: HQ.suffix }, { ...small, crf: HQ.h264Small, suffix: HQ.suffix }];
  return [big, bigH264, small].map((v) => (v.codec === 'av1' && shot.category === 'character' ? { ...v, crf: AV1_CRF_CHARACTER } : v));
}
export const variantName = (v: Variant) => `${v.codec}-${v.width}x${v.height}${v.suffix ?? ''}.mp4`;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Sizes come from the source itself (never upscale): the full size (AV1 first, then H.264) plus a
 * two-thirds H.264 copy, so phones never download the big file. Dimensions are even for yuv420p.
 */
export function variantsFor(src: { width: number; height: number }): Variant[] {
  const big = { width: even(src.width), height: even(src.height) };
  const small = { width: even((src.width * 2) / 3), height: even((src.height * 2) / 3) };
  return [{ ...big, codec: 'av1' }, { ...big, codec: 'h264' }, { ...small, codec: 'h264' }];
}

export interface LoopCut { start: number; end: number }

/** Blinks are sped up to this length (the brief asks for 0.2–0.3 s). */
export const BLINK_TARGET_S = 0.25;
/** Blinks longer than this are retimed; below motion.MAX_BLINK_S so encoding and measurement jitter (±1–2 frames) stay in target. */
export const RETIME_ABOVE_S = 0.3;
/** Longer runs are not blinks (a glance down, a laughing squint): left alone rather than sped up 3×. Shot.retimeMax lowers it per shot. */
export const RETIME_MAX_S = 1.0;

/**
 * Seedance's blinks in 8 s loops last ~0.5 s even when asked for a quarter second. Each blink longer than
 * RETIME_ABOVE_S plays faster (to BLINK_TARGET_S, at most 3×) over its own window plus one frame either side;
 * everything else, including the first and last frame of a keyframe-locked loop, is untouched. Returns null
 * when nothing needs retiming.
 */
export function retimeFilter(blinks: Blink[], duration: number, fps = 24, max = RETIME_MAX_S): { filter: string; windows: { start: number; end: number; factor: number }[] } | null {
  const pad = 1 / fps;
  const windows = blinks
    .filter((b) => b.duration > RETIME_ABOVE_S && b.duration <= max)
    .map((b) => ({ start: Math.max(0, b.at - pad), end: Math.min(duration, b.at + b.duration + pad), factor: Math.min(3, b.duration / BLINK_TARGET_S) }))
    .filter((w) => w.start > 0.05 && w.end < duration - 0.05)
    .sort((a, b) => a.start - b.start);
  if (!windows.length) return null;
  const segs: { start: number; end?: number; factor: number }[] = [];
  let t = 0;
  for (const w of windows) {
    if (w.start > t) segs.push({ start: t, end: w.start, factor: 1 });
    segs.push({ start: Math.max(t, w.start), end: w.end, factor: w.factor });
    t = w.end;
  }
  segs.push({ start: t, factor: 1 });
  const f3 = (n: number) => n.toFixed(3);
  const parts = segs.map((sg, i) => `[i${i}]trim=start=${f3(sg.start)}${sg.end !== undefined ? `:end=${f3(sg.end)}` : ''},setpts=${sg.factor === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${sg.factor.toFixed(3)}`}[s${i}]`);
  const filter = `[0:v]split=${segs.length}${segs.map((_, i) => `[i${i}]`).join('')};${parts.join(';')};${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=${fps},format=yuv420p[v]`;
  return { filter, windows };
}

/** Character loops and framed clips: a copy of the raw clip with its slow blinks sped up (out/retimed/<id>.mp4), or the raw clip. */
export async function withQuickBlinks(shot: Shot, raw: string, log: (m: string) => void): Promise<string> {
  if (shot.category !== 'character' || !(shot.loop || shot.frames)) return raw;
  const out = join(OUT, 'retimed', `${shot.id}.mp4`);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(raw).mtimeMs) return out;
  const before = await measure(raw);
  const { duration } = await probe(raw);
  const plan = retimeFilter(before.blinks, duration, 24, shot.retimeMax);
  if (!plan) { log(`  blinks ${before.blinks.map((b) => `${b.duration}s`).join(' ') || '—'}: no retiming needed`); return raw; }
  await mkdir(join(OUT, 'retimed'), { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-y', '-threads', '2', '-i', raw, '-filter_complex', plan.filter, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', out], { maxBuffer: 1 << 24 });
  let after = await measure(out);
  log(`  blinks ${before.blinks.map((b) => `${b.duration}s`).join(' ')} → ${after.blinks.map((b) => `${b.duration}s`).join(' ')} (sped up ${plan.windows.map((w) => `${w.factor.toFixed(1)}×`).join(', ')})`);
  // A blink measured just under the threshold can measure just over it after re-encoding (eimi-leave: 0.29 s →
  // 0.38 s): one more pass on the result, same rule.
  const again = retimeFilter(after.blinks, (await probe(out)).duration, 24, shot.retimeMax);
  if (again) {
    const tmp = `${out}.pass2.mp4`;
    await run('ffmpeg', ['-v', 'error', '-y', '-threads', '2', '-i', out, '-filter_complex', again.filter, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', tmp], { maxBuffer: 1 << 24 });
    await rename(tmp, out);
    const blinks = after.blinks;
    after = await measure(out);
    log(`  second pass: ${blinks.map((b) => `${b.duration}s`).join(' ')} → ${after.blinks.map((b) => `${b.duration}s`).join(' ')}`);
  }
  return out;
}

/**
 * Seamless loop over the window [cut.start, cut.end]: drop its first `xfade` seconds, then fade its tail into
 * those dropped seconds. The last frame of the result is the window's frame at `xfade`, also its first frame.
 * With xfade = 0 the window simply plays and wraps (for clips whose ends already match).
 */
export function loopFilter(duration: number, xfade = XFADE, cut: LoopCut = { start: 0, end: duration }): string {
  const len = cut.end - cut.start;
  if (len <= Math.max(xfade * 2, 1)) throw new Error(`clip too short to loop: ${len}s`);
  const window = cut.start > 0 || cut.end < duration ? `trim=start=${cut.start.toFixed(3)}:end=${cut.end.toFixed(3)},setpts=PTS-STARTPTS,` : '';
  if (xfade === 0) return `[0:v]${window}format=yuv420p[v]`;
  const offset = (len - xfade * 2).toFixed(3);
  return `[0:v]${window}split[a][b];[a]trim=start=${xfade},setpts=PTS-STARTPTS[main];[b]trim=0:${xfade},setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=${xfade}:offset=${offset},format=yuv420p[v]`;
}

/**
 * The cut points whose frames look most alike: a start frame in the first `search` seconds and an end frame
 * in the last `search` seconds (tiny grayscale thumbnails, mean absolute difference). Prefers the longest loop
 * among near-ties so a clip whose ends already match (a locked keyframe) keeps its full length.
 */
export function bestLoop(frames: Uint8Array[], fps: number, search = LOOP_SEARCH): LoopCut & { diff: number } {
  const n = frames.length;
  const reach = Math.min(Math.round(search * fps), Math.floor(n / 4));
  const diff = (a: Uint8Array, b: Uint8Array) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i <= reach; i++) for (let j = n - 1; j >= n - 1 - reach; j--) pairs.push({ i, j, d: diff(frames[i], frames[j]) });
  const min = Math.min(...pairs.map((p) => p.d));
  // Half a grey level of slack in favour of the longer window.
  const best = pairs.filter((p) => p.d <= min + 0.5).sort((a, b) => b.j - b.i - (a.j - a.i) || a.d - b.d)[0];
  // The frame at j is (nearly) the frame at i, so the window ends just before j.
  return { start: best.i / fps, end: best.j / fps, diff: Number(best.d.toFixed(2)) };
}

async function thumbnails(file: string): Promise<{ frames: Uint8Array[]; fps: number }> {
  const w = 48, h = 48;
  const { stdout: rate } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]);
  const [num, den] = rate.trim().split('/').map(Number);
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-threads', '2', '-i', file, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const buf = stdout as unknown as Buffer;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + w * h <= buf.length; o += w * h) frames.push(new Uint8Array(buf.subarray(o, o + w * h)));
  return { frames, fps: num / (den || 1) };
}

export function encodeArgs(input: string, output: string, v: Variant, filter?: string): string[] {
  const scale = `scale=${v.width}:${v.height}:flags=lanczos`;
  const graph = filter ? `${filter.replace(/\[v\]$/, '[l]')};[l]${scale}[v]` : `[0:v]${scale},format=yuv420p[v]`;
  const codec = v.codec === 'av1'
    ? ['-c:v', 'libsvtav1', '-preset', '6', '-crf', String(v.crf ?? 38), ...(v.vq ? ['-svtav1-params', 'tune=0'] : []), '-g', '48']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(v.crf ?? (v.width * v.height > 1e6 ? 24 : 26)), '-profile:v', 'high', '-g', '48'];
  return ['-v', 'error', '-y', '-threads', '2', '-i', input, '-filter_complex', graph, '-map', '[v]', '-an', ...codec, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output];
}

/** Evenly spaced stills over the whole orbit: view 0 is the front, view n/2 the back. */
export function viewTimes(duration: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => Number(((duration * i) / n + 0.05).toFixed(3)));
}

async function probe(file: string): Promise<{ duration: number; width: number; height: number }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout) as { streams: { width: number; height: number }[]; format: { duration: string } };
  return { duration: Number(j.format.duration), width: j.streams[0].width, height: j.streams[0].height };
}

export interface MediaEntry {
  id: string; category: Shot['category']; star?: string; ratio: string; use: string;
  poster: string;
  posters?: { src: string; width: number }[];
  sources: { src: string; type: string; width: number; height: number }[];
  views?: string[]; sheet?: string;
}

const typeFor = (c: Variant['codec']) => (c === 'av1' ? 'video/mp4; codecs="av01.0.08M.08"' : 'video/mp4; codecs="avc1.640028"');
const fresh = (out: string, src: string) => existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs;

async function processShot(shot: Shot, source: string, force: boolean, log: (m: string) => void): Promise<MediaEntry> {
  const dir = join(WEB_MEDIA, shot.id);
  await mkdir(dir, { recursive: true });
  const raw = await withQuickBlinks(shot, source, log);
  const { duration, ...size } = await probe(raw);
  const variants = variantsForShot(shot, size);
  const sfx = shot.encode === 'hq' ? HQ.suffix : '';
  const pq = shot.encode === 'hq' ? String(HQ.posterQ) : undefined;
  const xfade = shot.xfade ?? XFADE;
  let cut: LoopCut = { start: 0, end: duration };
  if (shot.loop) {
    const { frames, fps } = await thumbnails(raw);
    const best = bestLoop(frames, fps);
    cut = { start: best.start, end: best.end };
    log(`  loop ${best.start.toFixed(2)}–${best.end.toFixed(2)}s of ${duration.toFixed(2)}s (seam diff ${best.diff}), crossfade ${xfade}s`);
  }
  const filter = shot.loop ? loopFilter(duration, xfade, cut) : undefined;
  const entry: MediaEntry = { id: shot.id, category: shot.category, star: shot.star, ratio: shot.ratio, use: shot.use, poster: `/media/${shot.id}/poster.jpg`, sources: [] };
  // Turntables are shown as stills (SpinViewer), so they ship no video at all.
  for (const v of shot.multiview ? [] : variants) {
    const name = variantName(v);
    const out = join(dir, name);
    if (force || !fresh(out, raw)) { await run('ffmpeg', encodeArgs(raw, out, v, filter), { maxBuffer: 1 << 24 }); log(`  ${shot.id}/${name}`); }
    entry.sources.push({ src: `/media/${shot.id}/${name}`, type: typeFor(v.codec), width: v.width, height: v.height });
  }
  // Poster = the first frame of what plays (after loop trimming), so there is no jump when video starts.
  const poster = join(dir, `poster${sfx}.jpg`);
  const posterWidth = Math.min(1280, variants[1].width);
  const posterAt = shot.loop ? (cut.start + xfade).toFixed(3) : '0';
  if (force || !fresh(poster, raw)) await run('ffmpeg', ['-v', 'error', '-y', '-threads', '2', '-ss', posterAt, '-i', raw, '-frames:v', '1', '-vf', `scale=${posterWidth}:-2`, '-q:v', pq ?? '4', poster]);
  // Half-width poster for phones: the poster is usually the largest paint (LCP) on a slow connection.
  const small = join(dir, `poster-sm${sfx}.jpg`);
  const smallWidth = Math.round(posterWidth / 2 / 2) * 2;
  if (force || !fresh(small, raw)) await run('ffmpeg', ['-v', 'error', '-y', '-i', poster, '-vf', `scale=${smallWidth}:-2`, '-q:v', pq ?? '5', small]);
  entry.poster = `/media/${shot.id}/poster${sfx}.jpg`;
  entry.posters = [{ src: `/media/${shot.id}/poster-sm${sfx}.jpg`, width: smallWidth }, { src: entry.poster, width: posterWidth }];
  // Desktop heroes paint the poster full-screen: a 1920 w one keeps the face sharp on large displays.
  if (shot.ratio === '16:9' && size.width >= 1920) {
    const large = join(dir, `poster-1920${sfx}.jpg`);
    if (force || !fresh(large, raw)) await run('ffmpeg', ['-v', 'error', '-y', '-threads', '2', '-ss', posterAt, '-i', raw, '-frames:v', '1', '-vf', 'scale=1920:-2', '-q:v', pq ?? '4', large]);
    entry.posters.push({ src: `/media/${shot.id}/poster-1920${sfx}.jpg`, width: 1920 });
  }
  if (shot.multiview) {
    entry.views = [];
    for (const [i, t] of viewTimes(duration, shot.multiview).entries()) {
      const out = join(dir, `view-${i}.jpg`);
      if (force || !fresh(out, raw)) await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', raw, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', out]);
      entry.views.push(`/media/${shot.id}/view-${i}.jpg`);
    }
    const sheet = join(dir, 'sheet.jpg');
    const cols = Math.ceil(shot.multiview / 2);
    const step = duration / shot.multiview;
    if (force || !fresh(sheet, raw)) await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', `fps=1/${step.toFixed(4)},scale=360:-2,tile=${cols}x2:padding=4:color=0x24284D`, '-frames:v', '1', '-q:v', '3', sheet]);
    entry.sheet = `/media/${shot.id}/sheet.jpg`;
  }
  return entry;
}

/** The index entry for what is already published in apps/web/public/media/<id>/ (null if nothing is). */
export async function existingEntry(shot: Shot): Promise<MediaEntry | null> {
  const dir = join(WEB_MEDIA, shot.id);
  const hq = shot.encode === 'hq' && existsSync(join(dir, `poster${HQ.suffix}.jpg`));
  const sfx = hq ? HQ.suffix : '';
  if (!existsSync(join(dir, `poster${sfx}.jpg`))) return null;
  const files = await readdir(dir);
  const entry: MediaEntry = { id: shot.id, category: shot.category, star: shot.star, ratio: shot.ratio, use: shot.use, poster: `/media/${shot.id}/poster${sfx}.jpg`, sources: [] };
  const vids = files.map((f) => (hq ? /^(av1|h264)-(\d+)x(\d+)-hq\.mp4$/ : /^(av1|h264)-(\d+)x(\d+)\.mp4$/).exec(f)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ codec: m[1] as Variant['codec'], width: Number(m[2]), height: Number(m[3]), name: m[0] }))
    .sort((a, b) => (a.codec === b.codec ? b.width - a.width : a.codec === 'av1' ? -1 : 1));
  for (const v of vids) entry.sources.push({ src: `/media/${shot.id}/${v.name}`, type: typeFor(v.codec), width: v.width, height: v.height });
  const posterWidth = async (f: string) => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', join(dir, f)])).stdout.trim());
  if (files.includes(`poster-sm${sfx}.jpg`)) {
    entry.posters = [{ src: `/media/${shot.id}/poster-sm${sfx}.jpg`, width: await posterWidth(`poster-sm${sfx}.jpg`) }, { src: entry.poster, width: await posterWidth(`poster${sfx}.jpg`) }];
    if (files.includes(`poster-1920${sfx}.jpg`)) entry.posters.push({ src: `/media/${shot.id}/poster-1920${sfx}.jpg`, width: 1920 });
  }
  const views = files.filter((f) => /^view-\d+\.jpg$/.test(f)).sort((a, b) => Number(a.slice(5, -4)) - Number(b.slice(5, -4)));
  if (views.length) entry.views = views.map((f) => `/media/${shot.id}/${f}`);
  if (files.includes('sheet.jpg')) entry.sheet = `/media/${shot.id}/sheet.jpg`;
  return entry;
}

const HEADER = `// Generated by tools/media (npm run media:process). Do not edit by hand.\n`;
const catalogue = (entries: Omit<MediaEntry, 'use'>[]) => JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e])), null, 2);

/** Both index files: the core catalogue (entry bundle) and the scene catalogue (lazy chunk), each sorted by id. */
export function renderIndexes(entries: MediaEntry[]): { core: string; scene: string; sceneData: string } {
  // `use` documents the shot for people (docs/asset-bible.md); the site does not need it in its bundle.
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(({ use: _use, ...rest }) => rest);
  const core = sorted.filter((e) => !SCENE_MEDIA_ID.test(e.id));
  const scene = sorted.filter((e) => SCENE_MEDIA_ID.test(e.id));
  return {
    core: HEADER +
      `export interface MediaSource { src: string; type: string; width: number; height: number }\n` +
      `export interface MediaEntry { id: string; category: 'scene' | 'costume' | 'prop' | 'ambient' | 'character'; star?: string; ratio: string; poster: string; posters?: { src: string; width: number }[]; sources: MediaSource[]; views?: string[]; sheet?: string }\n` +
      `export const MEDIA: Record<string, MediaEntry> = ${catalogue(core)};\n`,
    // N-61: the scene catalogue's data is a JSON asset the web fetches (a fetch can be retried; a failed module import
    // cannot); the .ts beside it reads the same JSON for tests and tools.
    scene: HEADER +
      `// The scene catalogue's data is media.scene.gen.json (clips no first screen needs, tools/media/src/process.ts\n` +
      `// SCENE_MEDIA_ID). The web fetches that JSON as a hashed asset (apps/web/src/data/media.ts, N-61: a fetch can be\n` +
      `// retried, a failed module import cannot); this module is for tests and tools that read it synchronously.\n` +
      `import type { MediaEntry } from './media.gen';\n` +
      `import data from './media.scene.gen.json';\n` +
      `export const SCENE_MEDIA: Record<string, MediaEntry> = data as Record<string, MediaEntry>;\n`,
    sceneData: `${catalogue(scene)}\n`
  };
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--only');
  const only = i >= 0 ? args[i + 1].split(',') : undefined;
  const force = args.includes('--force');
  const state: State = JSON.parse(await readFile(join(OUT, 'state.json'), 'utf8'));
  const log = (m: string) => console.log(m);
  if (args.includes('--retime-only')) {
    if (!only) throw new Error('--retime-only needs --only');
    for (const id of only) {
      const shot = SHOTS.find((s) => s.id === id);
      const st = state[id];
      if (!shot || st?.status !== 'downloaded' || !st.file) { log(`- ${id}: no downloaded final`); continue; }
      log(`▸ ${id}`);
      const out = await withQuickBlinks(shot, join(OUT, st.file), log);
      log(`  → ${out.replace(`${OUT}/`, 'out/')}`);
    }
    return;
  }
  const entries: MediaEntry[] = [];
  for (const shot of SHOTS) {
    const st = state[shot.id];
    if (st?.status !== 'downloaded' || !st.file || (only && !only.includes(shot.id))) {
      // Keep already-published entries in the index as they are on disk (no re-encode, no new posters) — also
      // when this checkout's out/state.json has never seen the shot (a worktree, or clips processed elsewhere):
      // the published files, not the local state, say what the site has.
      const e = await existingEntry(shot);
      if (e) entries.push(e);
      continue;
    }
    log(`▸ ${shot.id}`);
    entries.push(await processShot(shot, join(OUT, st.file), force, log));
  }
  const { core, scene, sceneData } = renderIndexes(entries);
  await writeFile(INDEX, core);
  await writeFile(SCENE_INDEX, scene);
  await writeFile(SCENE_DATA, sceneData);
  const n = entries.filter((e) => SCENE_MEDIA_ID.test(e.id)).length;
  log(`index: ${entries.length - n} entries → ${INDEX.replace(ROOT + '/', '')}, ${n} → ${SCENE_INDEX.replace(ROOT + '/', '')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) void main();
