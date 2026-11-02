/**
 * v1.1 system scenes and confession (#55, #71): the stills their clips start and end on, and the checks, for the
 * shots in shots/system-v11.ts. Everything else is the usual pipeline (media:talent, media:gen, media:check,
 * media:process, media:pack).
 *
 *   npx tsx src/system-clips.ts sets [--only name,…|--star s] [--n 2] [--jobs 4]        people-free sets (gpt-image-2)
 *   npx tsx src/system-clips.ts stills [--only name,…|--star s] [--n 2] [--rounds 3] [--jobs 4]   her in the sets, continuity-judged
 *   npx tsx src/system-clips.ts pick name=b,…                                           choose another candidate
 *   npx tsx src/system-clips.ts board --only name,… --out file.jpg                     every candidate, for picking by eye
 *   npx tsx src/system-clips.ts judge --only clip,… [--draft] [--retimed]             continuity vs the v1 frames + seams
 *   npx tsx src/system-clips.ts sheet --only clip,… [--draft] [--retimed] --out file.jpg   stills of each clip in a row
 *
 * Stills are made in dependency order (a set before the dark room made from it, her wide still before the close one
 * that moves in from it), several at a time: the work is remote, the machine only waits. Her stills are edits of her
 * v1 hero frame (continuity.ts judges them against the five v1 frames, pass 4); the sets are edits of her published
 * rooms. `judge` and `sheet` do what scene-clips.ts does for #80 (media/scene-clips); fold the two together once both
 * are merged.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { continuity } from './continuity';
import { OUT, ROOT, renderedLastFrame, stillFile } from './generate';
import { KEYFRAMES, bestCandidate, candidateName, loadRecord, type Candidate, type KeyframeRecord } from './keyframes';
import { SHOTS, anchorsOf, type Anchor, type Shot } from './manifest';
import { clipFile, largestFaces, mad, measure, thumbs, type MotionReport } from './motion';
import { OutOfCredit, images } from './openrouter';
import { SYSTEM_V11_KEYFRAMES, SYSTEM_V11_SHOTS, type SystemKeyframe } from './shots/system-v11';
import { AGENCY } from './refs';

const exec = promisify(execFile);
const PASS = 4;
const MODEL = process.env.OPENROUTER_IMAGE_MODEL ?? 'openai/gpt-image-2';
if (!/gpt-image/.test(MODEL)) throw new Error(`owner 2026-09-27: stills are gpt-image-2 only, not ${MODEL}`);
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const saveRecord = (r: KeyframeRecord) => writeFile(join(KEYFRAMES, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
const pickFile = async (name: string) => { const p = (await loadRecord(name))?.pick; return p && existsSync(join(KEYFRAMES, p)) ? join(KEYFRAMES, p) : undefined; };
const BY_NAME = new Map(SYSTEM_V11_KEYFRAMES.map((k) => [k.name, k]));

/** A published poster as a base picture (`<media>-poster`): the 1920 one for 16:9 when it exists. */
async function ensureBase(name: string): Promise<string> {
  const have = await pickFile(name);
  if (have) return have;
  const m = /^(.+)-poster$/.exec(name);
  if (!m) throw new Error(`${name}: no picked still (make it first)`);
  const dir = join(ROOT, 'apps/web/public/media', m[1]);
  const src = ['poster-1920-hq.jpg', 'poster-1920.jpg', 'poster-hq.jpg', 'poster.jpg'].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!src) throw new Error(`${name}: no published poster in ${dir}`);
  const file = `${name}-a.png`;
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', src, join(KEYFRAMES, file)]);
  await saveRecord({ id: name, prompt: `published poster of ${m[1]}`, references: [src.replace(`${ROOT}/`, '')], candidates: [{ file, round: 0 }], pick: file, cost: 0, at: new Date().toISOString() });
  return join(KEYFRAMES, file);
}

const frameWords = (k: SystemKeyframe) => (k.ratio === '9:16' ? 'Vertical 9:16 frame.' : 'Horizontal 16:9 frame.');
const CONSTRAINTS = 'no text, no lettering, no logo, no watermark, no photography equipment';

/** A people-free set, edited from its base picture (her published room, or another set). */
export function setPrompt(k: SystemKeyframe): string {
  return [
    `A photorealistic photograph of a real location, like a still from a professional Japanese photobook shoot. ${frameWords(k)}`,
    'Reference image 1 shows the location (keep its style, materials, colour palette and mood unless the description changes them).',
    k.brief,
    'No people at all: no woman, no figure, no hands, no silhouette, no reflection of a person.',
    'Camera: full-frame, 35mm lens at f/2.8, eye level, natural perspective with vertical lines straight, gentle depth of field.',
    `Constraints: ${CONSTRAINTS}.`
  ].join('\n');
}

/**
 * Her, put into a set: ref 1 a face crop of her v1 hero frame, ref 2 the v1 frame (her hair, outfit, accessories —
 * never named in words), ref 3 the set or the wider still the camera moves in from.
 */
export function personPrompt(k: SystemKeyframe, corrections: string[] = []): string {
  const wait = k.camera === k.from;
  const eimiWrap = k.star === 'eimi' && !wait ? ' Her navy satin wrap is worn over both shoulders, so her shoulders are covered.' : '';
  return [
    `A photorealistic still frame from a live-action video, like a professional Japanese photobook shoot. ${frameWords(k)}`,
    'Reference image 1 is a close-up of her face. Reference image 2 shows her approved look: the same woman, the same face, hair colour and haircut, outfit and accessories.',
    wait ? 'Reference image 3 is the scene: keep its exact location, camera position, framing, lens and light.'
      : k.closer ? 'Reference image 3 is a wider shot of the same scene with her in it: keep its place, light and colour grade; the camera now moves closer as described.'
        : 'Reference image 3 is the place: keep its exact location, furniture and props, camera position, framing of the background, lens and light. Put her into this place; the place of reference image 2 does not matter.',
    k.brief,
    'Her face must be an exact likeness of reference image 1: same eyes, eyelids, nose, lips, face shape and jawline. Do not idealize, beautify or change any of her features.',
    ...(k.photo ? ['Reference image 4 is another photo of the same woman, for her face only (eyes, nose, lips, face shape): ignore its hair, hairstyle, make-up, face stickers, accessories, clothing and background.'] : []),
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    `Keep her hair exactly as in reference image 2: the same colour, length, cut and bangs (not longer, shorter, wavier or darker). Keep her outfit and accessories exactly as in reference image 2.${eimiWrap}`,
    'She is fully clothed, an adult woman in her twenties.',
    'Light: the place keeps its own light and mood, while a soft key light from the front lights her face with clear catchlights in her eyes.',
    `Constraints: exactly one person, anatomically natural hands with five fingers; ${CONSTRAINTS}.`
  ].join('\n');
}

async function references(k: SystemKeyframe): Promise<string[]> {
  if (!k.person) return [await ensureBase(k.from)];
  const r = k.ratio === '9:16' ? '9x16' : '16x9';
  const head = join(KEYFRAMES, `${k.star}-hero-${r}-v1-head.jpg`);
  if (!existsSync(head)) throw new Error(`${head} missing: copy the v1 anchors (media:keyframes -- --extract-v1 on main) into out/keyframes/v2`);
  const refs = [head, await ensureBase(k.from), await ensureBase(k.camera!)];
  if (k.photo) {
    const photo = join(AGENCY, 'refs', k.photo);
    if (!existsSync(photo)) throw new Error(`${photo} missing: npm run media:refs -- --photos (on the machine with the agency files)`);
    refs.push(photo);
  }
  return refs;
}

/** What must be picked before this still can be made. */
function deps(k: SystemKeyframe): string[] {
  const out = [k.from, ...(k.camera ? [k.camera] : [])].filter((n) => BY_NAME.has(n));
  return [...new Set(out)];
}

async function score(k: SystemKeyframe, c: Candidate) {
  const v = await continuity(k.star, join(KEYFRAMES, c.file), { id: c.file });
  c.verdict = { score: v.score, top: v.top, issues: [], lineup: v.lineup, ...(v.error ? { error: v.error } : {}) };
  log(`  ${c.file}: continuity ${v.score}${v.top ? '' : ' (not top match)'} ${JSON.stringify(v.lineup)}`);
}

async function make(k: SystemKeyframe, opts: { n: number; rounds: number }) {
  const refs = await references(k);
  const rec: KeyframeRecord = (await loadRecord(k.name)) ?? { id: k.name, prompt: '', references: [], candidates: [], cost: 0, at: '' };
  rec.references = refs.map((f) => f.replace(`${ROOT}/`, ''));
  let round = Math.max(0, ...rec.candidates.map((c) => c.round));
  const done = () => (k.person ? (bestCandidate(rec.candidates)?.verdict?.score ?? 0) >= PASS : rec.candidates.length > 0);
  while (!done() && round < opts.rounds) {
    round++;
    const prompt = k.person ? personPrompt(k, round > 1 ? ['her face drifted from reference image 1; match its eyes, nose, lips and jaw exactly'] : []) : setPrompt(k);
    try {
      const r = await images({ model: MODEL, prompt, refs: await Promise.all(refs.map((f) => readFile(f))), aspect: k.ratio, n: opts.n, purpose: `system still ${k.name} r${round} (#71)`, id: k.name });
      rec.cost += r.cost;
      rec.prompt = prompt;
      for (const img of r.images) {
        const file = candidateName(k.name, rec.candidates.length);
        await writeFile(join(KEYFRAMES, file), img);
        rec.candidates.push({ file, round });
      }
      log(`✓ ${k.name} round ${round}: ${r.images.length} candidate(s) ($${r.cost.toFixed(3)})`);
    } catch (e) {
      if (e instanceof OutOfCredit) throw e;
      log(`! ${k.name} round ${round}: ${(e as Error).message.slice(0, 200)}`);
    }
    if (k.person) for (const c of rec.candidates) if (!c.verdict) await score(k, c);
    rec.at = new Date().toISOString();
    await saveRecord(rec);
  }
  rec.pick = k.person ? bestCandidate(rec.candidates)?.file ?? rec.pick : rec.pick ?? rec.candidates[0]?.file;
  await saveRecord(rec);
  const v = rec.candidates.find((c) => c.file === rec.pick)?.verdict;
  log(`→ ${k.name}: ${rec.pick ?? 'no candidate'}${v ? ` continuity ${v.score}${v.score < PASS ? ' (below pass)' : ''}` : ''}`);
}

/** Runs `todo` in dependency order, `jobs` at a time; a still whose inputs failed is reported, not made. */
async function schedule(todo: SystemKeyframe[], jobs: number, opts: { n: number; rounds: number }) {
  const pending = new Map(todo.map((k) => [k.name, k]));
  const running = new Map<string, Promise<void>>();
  const failed = new Set<string>();
  const ready = async (k: SystemKeyframe) => {
    for (const d of deps(k)) {
      if (pending.has(d) || running.has(d)) return 'wait';
      if (failed.has(d) || !(await pickFile(d))) return 'blocked';
    }
    return 'go';
  };
  while (pending.size || running.size) {
    for (const k of [...pending.values()]) {
      if (running.size >= jobs) break;
      const r = await ready(k);
      if (r === 'wait') continue;
      pending.delete(k.name);
      if (r === 'blocked') { failed.add(k.name); log(`- ${k.name}: an input still is missing`); continue; }
      running.set(k.name, make(k, opts).catch((e) => {
        if (e instanceof OutOfCredit) throw e;
        failed.add(k.name);
        log(`! ${k.name}: ${(e as Error).message}`);
      }).finally(() => running.delete(k.name)));
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.size) { for (const k of pending.values()) { failed.add(k.name); log(`- ${k.name}: waits on a still outside this run`); } pending.clear(); }
  }
  const low = [];
  for (const k of todo) {
    const rec = await loadRecord(k.name);
    const v = rec?.candidates.find((c) => c.file === rec.pick)?.verdict;
    if (!rec?.pick || (k.person && (v?.score ?? 0) < PASS)) low.push(`${k.name}${v ? ` (${v.score})` : ''}`);
  }
  log(`done: ${todo.length - low.length}/${todo.length} picked${low.length ? `; not passing: ${low.join(', ')}` : ''}`);
}

/** The picture a resolved anchor stands for (her still, a set, or a rendered last frame). */
async function anchorFile(a: Anchor, draft: boolean): Promise<string | undefined> {
  if ('keyframe' in a) return pickFile(a.keyframe);
  if ('still' in a) return stillFile(a.still);
  return renderedLastFrame(a.rendered, draft);
}

async function thumbOf(image: string): Promise<Uint8Array> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', image, '-vf', 'scale=64:64:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 22 });
  return new Uint8Array(stdout as unknown as Buffer);
}

const reportPath = (id: string, draft: boolean, file: string) => join(OUT, 'check', `${id}${draft ? '.draft' : file.includes('/retimed/') ? '.retimed' : ''}.json`);

/**
 * Continuity of a clip: the line-up judge on the three frames where her face is largest (vs the five v1 frames), and
 * the seams between the clip's ends and the stills it was asked to start and end on. Merged into the media:check
 * report (as `likeness`, which media:pack shows) — run media:check first.
 */
async function judgeClip(shot: Shot, draft: boolean, retimed: boolean) {
  const file = clipFile(shot.id, draft, retimed);
  if (!existsSync(file)) { log(`- ${shot.id}: no ${draft ? 'draft' : 'final'}`); return; }
  const scores: number[] = [];
  let frames: number[] = [];
  if (shot.talent) {
    await measure(file, {
      keep: async (files, faces) => {
        frames = largestFaces(faces.map((f) => f?.w ?? 0));
        for (const i of frames) scores.push((await continuity(shot.talent!, files[i], { id: `${shot.id} frame ${i}` })).score);
      }
    });
  }
  const t = await thumbs(file);
  const { first, last } = anchorsOf(shot);
  const seams: Record<string, number> = {};
  for (const [role, a, frame] of [['first', first, t[0]], ['last', last, t[t.length - 1]]] as const) {
    const img = a && (await anchorFile(a, draft));
    if (img) seams[role] = mad(await thumbOf(img), frame);
  }
  const path = reportPath(shot.id, draft, file);
  const report = (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {}) as MotionReport & Record<string, unknown>;
  const sorted = [...scores].sort((a, b) => a - b);
  if (scores.length) report.likeness = { scores, median: sorted[Math.floor(sorted.length / 2)], frames };
  report.continuity = { judge: 'v1 hero frames (continuity.ts)', min: scores.length ? Math.min(...scores) : null };
  report.anchorSeams = seams;
  await mkdir(join(OUT, 'check'), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  log(`${scores.length && Math.min(...scores) < PASS ? '✗' : '✓'} ${shot.id.padEnd(40)} continuity ${scores.join('/') || '—'}  anchor seams ${Object.entries(seams).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
}

const cell = (landscape: boolean) => (landscape ? [480, 270] : [270, 480]) as [number, number];

/** One row per clip: [start still] first · 25% · 50% · 75% · last [end still]. */
async function sheet(ids: string[], draft: boolean, retimed: boolean, out: string) {
  const tmp = join(OUT, 'sheets');
  await mkdir(tmp, { recursive: true });
  const rows: string[] = [];
  for (const id of ids) {
    const shot = SHOTS.find((s) => s.id === id)!;
    const file = clipFile(id, draft, retimed);
    if (!existsSync(file)) continue;
    const [w, h] = cell(shot.ratio === '16:9');
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const d = Number(stdout.trim());
    const { first, last } = anchorsOf(shot);
    const parts: string[] = [];
    const fa = first && (await anchorFile(first, draft)), la = last && (await anchorFile(last, draft));
    if (fa) parts.push(fa);
    for (const [i, at] of [0, d * 0.25, d * 0.5, d * 0.75, Math.max(0, d - 0.05)].entries()) {
      const f = join(tmp, `${id}${draft ? '.draft' : ''}-${i}.jpg`);
      await exec('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-q:v', '3', f]);
      parts.push(f);
    }
    if (la) parts.push(la);
    const row = join(tmp, `${id}${draft ? '.draft' : ''}-row.jpg`);
    await exec('nice', ['-n', '19', 'ffmpeg', '-v', 'error', '-y', ...parts.flatMap((p) => ['-i', p]), '-filter_complex', `${parts.map((_, i) => `[${i}]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2[v${i}]`).join(';')};${parts.map((_, i) => `[v${i}]`).join('')}hstack=${parts.length},pad=${w}*7:${h}:0:0,scale=1890:-2`, '-frames:v', '1', '-q:v', '3', row]);
    rows.push(row);
  }
  if (!rows.length) return;
  await exec('nice', ['-n', '19', 'ffmpeg', '-v', 'error', '-y', ...rows.flatMap((p) => ['-i', p]), '-filter_complex', rows.length > 1 ? `${rows.map((_, i) => `[${i}]`).join('')}vstack=${rows.length}` : 'null', '-frames:v', '1', '-q:v', '3', out]);
  log(`sheet → ${out}`);
}

/** Every candidate of each still in a row (a, b, … left to right), the pick framed in red — for picking by eye; scores go to the log. */
async function board(names: string[], out: string) {
  const tmp = join(OUT, 'sheets');
  await mkdir(tmp, { recursive: true });
  const rows: string[] = [];
  for (const name of names) {
    const rec = await loadRecord(name);
    if (!rec?.candidates.length) continue;
    const landscape = BY_NAME.get(name)?.ratio === '16:9';
    const [w, h] = landscape ? [512, 288] : [288, 512];
    const cands = rec.candidates.filter((c) => existsSync(join(KEYFRAMES, c.file))).slice(-4);
    const label = (c: Candidate) => `${c.file.slice(-5, -4)}${c.verdict ? ` ${c.verdict.score}` : ''}${c.file === rec.pick ? ' PICK' : ''}`;
    const filters = cands.map((c, i) => `[${i}]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,drawbox=x=0:y=0:w=${w}:h=${h}:color=${c.file === rec.pick ? 'red' : 'black'}:t=6[v${i}]`);
    log(`  ${name}: ${cands.map(label).join(' | ')}`);
    const row = join(tmp, `${name}-board.jpg`);
    await exec('nice', ['-n', '19', 'ffmpeg', '-v', 'error', '-y', ...cands.flatMap((c) => ['-i', join(KEYFRAMES, c.file)]), '-filter_complex', `${filters.join(';')};${cands.map((_, i) => `[v${i}]`).join('')}hstack=${cands.length},pad=${w * Math.max(2, cands.length)}:${h}:0:0`, '-frames:v', '1', '-q:v', '3', row]);
    rows.push(row);
  }
  if (!rows.length) return;
  await exec('nice', ['-n', '19', 'ffmpeg', '-v', 'error', '-y', ...rows.flatMap((p) => ['-i', p]), '-filter_complex', rows.length > 1 ? `${rows.map((_, i) => `[${i}]scale=2048:-2[r${i}]`).join(';')};${rows.map((_, i) => `[r${i}]`).join('')}vstack=${rows.length}` : 'scale=2048:-2', '-frames:v', '1', '-q:v', '4', out]);
  log(`board → ${out}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const only = arg('--only')?.split(',');
  const star = arg('--star');
  await mkdir(KEYFRAMES, { recursive: true });
  if (cmd === 'sets' || cmd === 'stills') {
    const person = cmd === 'stills';
    const ks = SYSTEM_V11_KEYFRAMES.filter((k) => k.person === person && (!only || only.includes(k.name)) && (!star || k.star === star) && (!arg('--ratio') || k.ratio === arg('--ratio')));
    for (const n of only ?? []) if (!BY_NAME.has(n)) throw new Error(`unknown still ${n}`);
    await schedule(ks, Number(arg('--jobs') ?? 4), { n: Number(arg('--n') ?? 2), rounds: Number(arg('--rounds') ?? (person ? 3 : 1)) });
  } else if (cmd === 'pick') {
    for (const part of args[0]?.split(',') ?? []) {
      const [name, letter] = part.split('=');
      const rec = await loadRecord(name);
      const file = candidateName(name, letter.charCodeAt(0) - 97);
      if (!rec?.candidates.some((c) => c.file === file)) throw new Error(`${name} has no candidate ${file}`);
      rec.pick = file;
      await saveRecord(rec);
      log(`${name}: pick ${file}`);
    }
  } else if (cmd === 'board') {
    await board(only ?? SYSTEM_V11_KEYFRAMES.filter((k) => !star || k.star === star).map((k) => k.name), resolve(arg('--out') ?? join(OUT, 'sheets', 'system-board.jpg')));
  } else if (cmd === 'judge' || cmd === 'sheet') {
    const ids = only ?? SYSTEM_V11_SHOTS.filter((s) => !star || s.star === star).map((s) => s.id);
    for (const id of ids) if (!SHOTS.some((s) => s.id === id)) throw new Error(`unknown shot ${id}`);
    const draft = args.includes('--draft'), retimed = args.includes('--retimed');
    if (cmd === 'judge') for (const id of ids) await judgeClip(SHOTS.find((s) => s.id === id)!, draft, retimed);
    else await sheet(ids, draft, retimed, resolve(arg('--out') ?? join(OUT, 'sheets', `system${draft ? '-draft' : ''}.jpg`)));
  } else {
    console.error('usage: system-clips.ts sets|stills|pick|board|judge|sheet …');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
