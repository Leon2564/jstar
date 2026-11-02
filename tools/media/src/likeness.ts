/**
 * Local likeness scoring (no network): does this image show the same woman as her references?
 *
 *   npx tsx src/likeness.ts score <star> <image>...     → 1–5 per image, with the raw signals
 *   npx tsx src/likeness.ts calibrate [extra.json]      → same-person vs other-person separation
 *
 * Signals (Apple Vision via tools/media/face/face.swift):
 *  - `print`: Vision image feature prints of tight, roll-aligned face crops. Generic (not a face-ID
 *    model), so it is used relatively: how much closer the face is to her references than to the
 *    other four talents' references (`margin`), plus whether she is the nearest talent at all (`rank`).
 *  - `geometry`: landmark ratios (eye size, face length, nose/mouth width, lower face) compared with
 *    her frontal references in standard deviations; catches the "eyes too small, face too long" drift.
 * The mapping to 1–5 is fitted by `calibrate` and stored in refs/calibration.json.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OUT } from './generate';
import { STARS, type Star } from './manifest';
import { REFS, detect, ensureFaceBin, faceCrop, type Geometry, type Ref } from './refs';

const exec = promisify(execFile);
const CROPS = join(OUT, 'likeness');

type Vec = Float32Array;
interface RefSet { star: Star; refs: Ref[]; prints: Vec[]; geoMean: Geometry; geoSd: Geometry }

const GEO_KEYS: (keyof Geometry)[] = ['eyeWidth', 'eyeOpen', 'faceLength', 'noseWidth', 'mouthWidth', 'eyeMouth', 'chin'];

export function l2(a: Vec, b: Vec): number { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

async function printsOf(files: string[]): Promise<Vec[]> {
  const bin = await ensureFaceBin();
  const out: Vec[] = [];
  for (let i = 0; i < files.length; i += 16) {
    const { stdout } = await exec(bin, ['print', ...files.slice(i, i + 16)], { maxBuffer: 64 << 20 });
    for (const line of stdout.trim().split('\n').filter(Boolean)) out.push(Float32Array.from((JSON.parse(line) as { print: number[] }).print));
  }
  return out;
}

function stats(gs: Geometry[]): { mean: Geometry; sd: Geometry } {
  const mean = {} as Geometry, sd = {} as Geometry;
  for (const k of GEO_KEYS) {
    const v = gs.map((g) => g[k]);
    const m = v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
    mean[k] = m;
    sd[k] = Math.max(Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(v.length - 1, 1)), 0.02);
  }
  return { mean, sd };
}

const cache = new Map<Star, RefSet>();
export async function refSet(star: Star): Promise<RefSet> {
  if (cache.has(star)) return cache.get(star)!;
  const dir = join(REFS, star);
  const { refs } = JSON.parse(await readFile(join(dir, 'refs.json'), 'utf8')) as { refs: Ref[] };
  const printFile = join(dir, 'prints.json');
  let prints: Vec[];
  if (existsSync(printFile)) prints = (JSON.parse(await readFile(printFile, 'utf8')) as number[][]).map((p) => Float32Array.from(p));
  else { prints = await printsOf(refs.map((r) => join(dir, r.face))); await writeFile(printFile, JSON.stringify(prints.map((p) => Array.from(p)))); }
  const front = refs.filter((r) => r.view === 'front' && r.geometry).map((r) => r.geometry!);
  const { mean, sd } = stats(front);
  const set = { star, refs, prints, geoMean: mean, geoSd: sd };
  cache.set(star, set);
  return set;
}

/** Mean of the k smallest distances (robust to one odd reference). */
function nearest(p: Vec, prints: Vec[], k = 5, skip?: number): number {
  const d = prints.map((q, i) => (i === skip ? Infinity : l2(p, q))).sort((a, b) => a - b).slice(0, k);
  return d.reduce((a, b) => a + b, 0) / d.length;
}

export interface Signals { own: number; others: Record<string, number>; margin: number; rank: number; geo?: number; yaw?: number; facePx?: number }
export interface Calibration { marginLo: number; marginHi: number; geoPenalty: number; fittedAt: string; notes?: string }
const CAL_FILE = join(REFS, 'calibration.json');
const DEFAULT_CAL: Calibration = { marginLo: 0, marginHi: 0.15, geoPenalty: 0.25, fittedAt: 'default' };

export async function signals(star: Star, print: Vec, geometry?: Geometry, skip?: number): Promise<Signals> {
  const own = await refSet(star);
  const ownD = nearest(print, own.prints, 5, skip);
  const others: Record<string, number> = {};
  for (const s of STARS) if (s !== star) others[s] = nearest(print, (await refSet(s)).prints);
  const otherMin = Math.min(...Object.values(others));
  const rank = 1 + Object.values(others).filter((d) => d < ownD).length;
  let geo: number | undefined;
  if (geometry) {
    const z = GEO_KEYS.map((k) => Math.abs(geometry[k] - own.geoMean[k]) / own.geoSd[k]);
    geo = Math.sqrt(z.reduce((a, b) => a + b * b, 0) / z.length);
  }
  return { own: ownD, others, margin: (otherMin - ownD) / otherMin, rank, geo };
}

/** 1–5: the relative print margin mapped linearly between the calibrated bounds, minus a geometry penalty. */
export function toScore(s: Signals, cal: Calibration): number {
  const t = Math.max(0, Math.min(1, (s.margin - cal.marginLo) / (cal.marginHi - cal.marginLo)));
  let score = 1 + 4 * t;
  if (s.geo !== undefined && s.geo > 2) score -= Math.min(1.5, (s.geo - 2) * cal.geoPenalty);
  if (s.rank > 1) score = Math.min(score, 2.5);
  return Math.round(Math.max(1, Math.min(5, score)) * 10) / 10;
}

export async function loadCalibration(): Promise<Calibration> {
  return existsSync(CAL_FILE) ? (JSON.parse(await readFile(CAL_FILE, 'utf8')) as Calibration) : DEFAULT_CAL;
}

export interface LocalScore { file: string; star: Star; score: number | null; signals?: Signals; error?: string }

export async function scoreImages(star: Star, files: string[]): Promise<LocalScore[]> {
  await mkdir(CROPS, { recursive: true });
  const cal = await loadCalibration();
  const dets = await detect(files);
  const out: LocalScore[] = [];
  for (const [i, file] of files.entries()) {
    const face = dets[i]?.faces[0];
    if (!face) { out.push({ file, star, score: null, error: 'no face found' }); continue; }
    const crop = join(CROPS, `${star}-${i}-${basename(file).replace(/\.\w+$/, '')}.png`);
    if (!(await faceCrop(file, crop))) { out.push({ file, star, score: null, error: 'crop failed' }); continue; }
    const [p] = await printsOf([crop]);
    const sig = { ...(await signals(star, p, face.geometry)), yaw: face.yaw, facePx: Math.round(face.w) };
    out.push({ file, star, score: toScore(sig, cal), signals: sig });
  }
  return out;
}

/**
 * Leave-one-out over the references (same person, other frames) plus optional held-out images with
 * known identity (e.g. the official key visual and the older character sheets: same person, other shoot),
 * checked against every talent. Fits margin bounds so that true matches land ≥ 3.5 and others ≤ 2.
 */
async function calibrate(extraFile?: string) {
  const rows: { star: Star; truth: Star; margin: number; rank: number; geo?: number; kind: string }[] = [];
  for (const truth of STARS) {
    const set = await refSet(truth);
    for (const [i, r] of set.refs.entries()) {
      for (const star of STARS) {
        const sig = await signals(star, set.prints[i], r.view === 'front' ? r.geometry : undefined, star === truth ? i : undefined);
        rows.push({ star, truth, margin: sig.margin, rank: sig.rank, geo: sig.geo, kind: 'ref-loo' });
      }
    }
  }
  if (extraFile) {
    await mkdir(CROPS, { recursive: true });
    const extra = JSON.parse(await readFile(extraFile, 'utf8')) as { star: Star; file: string; kind?: string }[];
    for (const e of extra) {
      const [d] = await detect([e.file]);
      const face = d?.faces[0];
      if (!face) { console.log(`  no face: ${e.file}`); continue; }
      const crop = join(CROPS, `cal-${e.star}-${basename(e.file).replace(/\.\w+$/, '')}.png`);
      if (!(await faceCrop(e.file, crop))) { console.log(`  crop failed: ${e.file}`); continue; }
      const [p] = await printsOf([crop]);
      for (const star of STARS) {
        const sig = await signals(star, p, face.geometry);
        rows.push({ star, truth: e.star, margin: sig.margin, rank: sig.rank, geo: sig.geo, kind: e.kind ?? 'held-out' });
      }
    }
  }
  const summary = (kind: string, same: boolean) => {
    const r = rows.filter((x) => x.kind === kind && (x.star === x.truth) === same);
    const m = r.map((x) => x.margin).sort((a, b) => a - b);
    const q = (p: number) => m[Math.min(m.length - 1, Math.floor(p * m.length))];
    return r.length ? `${kind} ${same ? 'same ' : 'other'} n=${r.length} margin p10=${q(0.1)?.toFixed(3)} p50=${q(0.5)?.toFixed(3)} p90=${q(0.9)?.toFixed(3)} rank1=${(r.filter((x) => x.rank === 1).length / r.length * 100).toFixed(0)}% geo p50=${(r.map((x) => x.geo ?? 0).sort((a, b) => a - b)[Math.floor(r.length / 2)] ?? 0).toFixed(2)}` : '';
  };
  const kinds = [...new Set(rows.map((r) => r.kind))];
  for (const k of kinds) { console.log(summary(k, true)); console.log(summary(k, false)); }
  // Bounds come from held-out images when present (they look like generations: other light, other day).
  const real = (r: (typeof rows)[number]) => r.kind !== 'ref-loo' && !r.kind.startsWith('gen');
  const basis = rows.some(real) ? rows.filter(real) : rows;
  const other = basis.filter((r) => r.star !== r.truth).map((r) => r.margin).sort((a, b) => a - b);
  const same = basis.filter((r) => r.star === r.truth).map((r) => r.margin).sort((a, b) => a - b);
  const cal: Calibration = {
    marginLo: other[Math.floor(other.length * 0.9)] ?? 0,
    marginHi: same[Math.floor(same.length * 0.5)] ?? 0.15,
    geoPenalty: DEFAULT_CAL.geoPenalty,
    fittedAt: new Date().toISOString(),
    notes: `n=${basis.length}; lo = p90 of other-person margins, hi = median same-person margin`
  };
  if (cal.marginHi <= cal.marginLo) cal.marginHi = cal.marginLo + 0.05;
  await writeFile(CAL_FILE, `${JSON.stringify(cal, null, 2)}\n`);
  console.log('calibration', cal);
  for (const kind of kinds) for (const truth of STARS) {
    const line = STARS.map((star) => {
      const r = rows.filter((x) => x.truth === truth && x.star === star && x.kind === kind);
      if (!r.length) return `${star}:-`;
      return `${star}:${(r.reduce((a, x) => a + toScore({ own: 0, others: {}, margin: x.margin, rank: x.rank, geo: x.geo }, cal), 0) / r.length).toFixed(1)}`;
    }).join(' ');
    console.log(`  ${kind.padEnd(8)} ${truth.padEnd(6)} → ${line}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'calibrate') return calibrate(rest[0]);
  if (cmd === 'score') {
    const [star, ...files] = rest as [Star, ...string[]];
    for (const r of await scoreImages(star, files)) console.log(JSON.stringify({ file: r.file.replace(/^.*\//, ''), score: r.score, error: r.error, margin: r.signals?.margin.toFixed(3), rank: r.signals?.rank, geo: r.signals?.geo?.toFixed(2), yaw: r.signals?.yaw?.toFixed(0) }));
    return;
  }
  console.error('usage: likeness.ts score <star> <image>… | calibrate [extra.json]');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
