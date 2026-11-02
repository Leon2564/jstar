/**
 * v1.1 scene clips (#80): the stills they start and end on, and the continuity checks, for the shots in
 * shots/scenes-v11.ts. Everything else is the usual pipeline (media:talent, media:gen, media:check, media:process,
 * media:pack).
 *
 *   npx tsx src/scene-clips.ts stills [--only name,…]                 people-free stills (night poster edit or a frame of a published clip)
 *   npx tsx src/scene-clips.ts keyframes [--only name,…] [--n 2] [--rounds 2]   stills of her, edited from her v1 hero frame, continuity-judged
 *   npx tsx src/scene-clips.ts pick name=b,…                          choose another candidate
 *   npx tsx src/scene-clips.ts judge --only clip,… [--draft] [--retimed]      continuity of the clip vs the v1 frames + seams to its anchors
 *   npx tsx src/scene-clips.ts sheet --only clip,… [--draft] [--retimed] --out file.jpg   stills for eyeballing hair, outfit and room
 *
 * Why not media:keyframes -- --motion: its prompt spells out the v2 hair and outfit (manifest.TALENTS) and scores
 * against the 4K interview refs, so a still can pass with the wrong hair (#79's まひろ). Here the only description of
 * her look is her v1 hero frame itself, and the judge compares faces with the five v1 frames (continuity.ts).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { continuity } from './continuity';
import { OUT, ROOT, renderedLastFrame, stillFile } from './generate';
import { KEYFRAMES, bestCandidate, candidateName, loadRecord, type Candidate, type KeyframeRecord } from './keyframes';
import { SHOTS, anchorsOf, type Anchor, type Shot } from './manifest';
import { clipFile, largestFaces, mad, measure, thumbs, type MotionReport } from './motion';
import { OutOfCredit, images } from './openrouter';
import { HOME_V11_KEYFRAMES, HOME_V11_SHOTS } from './shots/home-v11';
import { SCENE_V11_KEYFRAMES, SCENE_V11_SHOTS, SCENE_V11_WIDE_SHOTS, v1, type SceneKeyframe } from './shots/scenes-v11';

/** Every still and clip this tool makes: the scenes' (9:16 and the 16:9 wide shots) and her everyday clips (home-v11.ts). */
const STILLS: SceneKeyframe[] = [...SCENE_V11_KEYFRAMES, ...HOME_V11_KEYFRAMES];
const CLIPS: Shot[] = [...SCENE_V11_SHOTS, ...SCENE_V11_WIDE_SHOTS, ...HOME_V11_SHOTS];
const frameWords = (k: SceneKeyframe) => (k.ratio === '16:9' ? 'Horizontal 16:9 frame.' : 'Vertical 9:16 frame.');

const exec = promisify(execFile);
const PASS = 4;
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const saveRecord = (r: KeyframeRecord) => writeFile(join(KEYFRAMES, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
const pickFile = async (name: string) => { const p = (await loadRecord(name))?.pick; return p ? join(KEYFRAMES, p) : undefined; };

/** Base pictures that are not generated: `<media>-poster` is the published poster of a people-free clip. */
async function ensureBase(name: string): Promise<string> {
  const have = await pickFile(name);
  if (have && existsSync(have)) return have;
  const m = /^(.+)-poster$/.exec(name);
  if (!m) throw new Error(`${name}: no picked still (make it first)`);
  const src = join(ROOT, 'apps/web/public/media', m[1], 'poster.jpg');
  const file = `${name}-a.png`;
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', src, join(KEYFRAMES, file)]);
  await saveRecord({ id: name, prompt: `published poster of ${m[1]}`, references: [src.replace(`${ROOT}/`, '')], candidates: [{ file, round: 0 }], pick: file, cost: 0, at: new Date().toISOString() });
  return join(KEYFRAMES, file);
}

const CONSTRAINTS = 'Constraints: nothing in the frame but the location (no photography equipment); no text, no logo, no watermark.';

/** A people-free still made from her night scene: the same room, no one in it. */
export function stillPrompt(k: SceneKeyframe): string {
  return [
    `A photorealistic photograph of a location, like a still from a professional Japanese photobook shoot, with real-world materials, light and scale. ${frameWords(k)}`,
    `Reference image 1 shows the location. ${k.brief}`,
    'No people at all: no woman, no figure, no hands, no silhouette, no reflection of a person. Keep the location\'s furniture, colours and night mood: deep navy shadows, warm rose-pink light.',
    'Camera: full-frame, 50mm lens at f/2, eye level, shallow depth of field.',
    CONSTRAINTS
  ].join('\n');
}

/**
 * A still of her: reference 1 is a face crop of her v1 hero frame, reference 2 the picture this still is edited
 * from (her v1 frame, or a still already made from it), reference 3 (optional) the camera to keep. Her hair and
 * outfit are named only by pointing at reference 2, never in words.
 */
export function personPrompt(k: SceneKeyframe, corrections: string[] = []): string {
  return [
    `A photorealistic still frame from the same video as reference image 2, like a professional Japanese photobook shoot. ${frameWords(k)}`,
    k.setting
      ? 'Reference image 2 shows her approved look and reference image 1 is a close-up of her face: the same woman, face, hair colour and haircut, outfit and accessories. Not its room or light: she is now in a different place, at a different time of day.'
      : 'Reference image 2 shows her approved look and reference image 1 is a close-up of her face: the same woman, face, hair colour and haircut, outfit, accessories, room, light and colour grade.',
    ...(k.camera ? [`Reference image 3 is the ${k.setting ? 'place' : 'camera'}: keep its exact location, furniture, objects, camera position, framing of the background, lens and light.`] : []),
    k.brief,
    ...(k.noFace ? [] : ['Her face must be an exact likeness of reference image 1: same eyes, eyelids, nose, lips, face shape and jawline. Do not idealize, beautify or change any of her features.']),
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    k.wearing
      ? `She now wears ${k.wearing}, instead of the outfit in reference image 2. Keep her hair exactly as in reference image 2: the same colour, length, cut and bangs (not longer, shorter, wavier or darker).`
      : 'Keep her hair exactly as in reference image 2: the same colour, length, cut and bangs (not longer, shorter, wavier or darker). Keep her outfit and accessories exactly as in reference image 2.',
    k.noFace
      ? 'She is fully clothed, an adult woman in her twenties; only her hands and wrists (and the cuffs of her sleeves) are in the frame.'
      : 'She is fully clothed, shoulders covered, an adult woman in her twenties, looking into the lens with a soft closed-mouth smile (teeth not showing).',
    k.setting
      ? `Light: ${k.setting}; clear catchlights in her eyes.`
      : 'Light: the location keeps its night mood, while a soft key light from the front lights her face evenly with clear catchlights in her eyes.',
    `Constraints: exactly one person, anatomically natural hands with five fingers; ${CONSTRAINTS.slice('Constraints: '.length)}`
  ].join('\n');
}

async function references(k: SceneKeyframe): Promise<string[]> {
  if (!k.person) return [await ensureBase(k.from)];
  const head = join(KEYFRAMES, `${v1(k.star)}-head.jpg`);
  if (!existsSync(head)) throw new Error(`${head} missing: copy the v1 anchors (media:keyframes -- --extract-v1 on main) into out/keyframes/v2`);
  return [head, await ensureBase(k.from), ...(k.camera ? [await ensureBase(k.camera)] : [])];
}

async function score(k: SceneKeyframe, c: Candidate) {
  const v = await continuity(k.star, join(KEYFRAMES, c.file), { id: c.file });
  c.verdict = { score: v.score, top: v.top, issues: [], lineup: v.lineup, ...(v.error ? { error: v.error } : {}) };
  log(`  ${c.file}: continuity ${v.score}${v.top ? '' : ' (not top match)'} ${JSON.stringify(v.lineup)}`);
}

async function make(k: SceneKeyframe, opts: { n: number; rounds: number }) {
  if (k.extract) {
    const file = `${k.name}-a.png`;
    const dir = join(ROOT, 'apps/web/public/media', k.extract.media);
    // The biggest H.264 of the published clip (the -hq encode when there is one).
    const px = (f: string) => { const m = /-(\d+)x(\d+)/.exec(f)!; return Number(m[1]) * Number(m[2]) + (f.includes('-hq') ? 1 : 0); };
    const h264 = (await readdir(dir)).filter((f) => /^h264-\d+x\d+(-hq)?\.mp4$/.test(f)).sort((a, b) => px(b) - px(a));
    const src = join(dir, h264[0]);
    await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(k.extract.at), '-i', src, '-frames:v', '1', join(KEYFRAMES, file)]);
    await saveRecord({ id: k.name, prompt: `frame at ${k.extract.at}s of ${k.extract.media}`, references: [src.replace(`${ROOT}/`, '')], candidates: [{ file, round: 0 }], pick: file, cost: 0, at: new Date().toISOString() });
    log(`✓ ${k.name} ← ${k.extract.media} @ ${k.extract.at}s`);
    return;
  }
  const refs = await references(k);
  const rec: KeyframeRecord = (await loadRecord(k.name)) ?? { id: k.name, prompt: '', references: [], candidates: [], cost: 0, at: '' };
  rec.references = refs.map((f) => f.replace(`${ROOT}/`, ''));
  let round = Math.max(0, ...rec.candidates.map((c) => c.round));
  const judged = k.person && !k.noFace;
  const done = () => (judged ? (bestCandidate(rec.candidates)?.verdict?.score ?? 0) >= PASS : rec.candidates.length > 0);
  while (!done() && round < opts.rounds) {
    round++;
    const prompt = k.person ? personPrompt(k, round > 1 ? ['her face drifted from reference image 1; match its eyes, nose, lips and jaw exactly'] : []) : stillPrompt(k);
    try {
      const r = await images({ model: process.env.OPENROUTER_IMAGE_MODEL ?? 'openai/gpt-image-2', prompt, refs: await Promise.all(refs.map((f) => readFile(f))), aspect: k.ratio, n: opts.n, purpose: `scene keyframe ${k.name} r${round} (#80)`, id: k.name });
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
    if (judged) for (const c of rec.candidates) if (!c.verdict) await score(k, c);
    rec.at = new Date().toISOString();
    await saveRecord(rec);
  }
  rec.pick = judged ? bestCandidate(rec.candidates)?.file : rec.pick ?? rec.candidates[0]?.file;
  await saveRecord(rec);
  const v = rec.candidates.find((c) => c.file === rec.pick)?.verdict;
  log(`→ ${k.name}: ${rec.pick ?? 'no candidate'}${v ? ` continuity ${v.score}${v.score < PASS ? ' (below pass)' : ''}` : ''}`);
}

/** The picture a resolved anchor stands for (keyframe pick, people-free still, or a rendered last frame). */
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
 * Continuity of a clip: the line-up judge on the three frames where her face is largest (vs the five v1 frames),
 * and how far the clip's first/last frames are from the stills they were asked to start and end on (same 64×64
 * grayscale measure as media:check; a still of her anchored as first frame measures ~1–3). Merged into the
 * media:check report (as `likeness`, which media:pack shows) — run media:check first.
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
  log(`${scores.length && Math.min(...scores) < PASS ? '✗' : '✓'} ${shot.id.padEnd(44)} continuity ${scores.join('/') || '—'}  anchor seams ${Object.entries(seams).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
}

/** One row per clip: [start still] first · 25% · 50% · 75% · last [end still] — for checking hair, outfit and room by eye. */
async function sheet(ids: string[], draft: boolean, retimed: boolean, out: string) {
  const tmp = join(OUT, 'sheets');
  await mkdir(tmp, { recursive: true });
  const rows: string[] = [];
  for (const id of ids) {
    const shot = SHOTS.find((s) => s.id === id)!;
    const file = clipFile(id, draft, retimed);
    if (!existsSync(file)) continue;
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
    await exec('ffmpeg', ['-v', 'error', '-y', ...parts.flatMap((p) => ['-i', p]), '-filter_complex', `${parts.map((_, i) => `[${i}]scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2[v${i}]`).join(';')};${parts.map((_, i) => `[v${i}]`).join('')}hstack=${parts.length},pad=270*7:480:0:0`, '-frames:v', '1', '-q:v', '3', row]);
    rows.push(row);
  }
  if (!rows.length) return;
  await exec('ffmpeg', ['-v', 'error', '-y', ...rows.flatMap((p) => ['-i', p]), '-filter_complex', rows.length > 1 ? `${rows.map((_, i) => `[${i}]`).join('')}vstack=${rows.length}` : 'null', '-frames:v', '1', '-q:v', '3', out]);
  log(`sheet → ${out}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const only = arg('--only')?.split(',');
  await mkdir(KEYFRAMES, { recursive: true });
  if (cmd === 'stills' || cmd === 'keyframes') {
    const person = cmd === 'keyframes';
    const ks = STILLS.filter((k) => k.person === person && (!only || only.includes(k.name)));
    for (const k of ks) {
      try { await make(k, { n: Number(arg('--n') ?? 2), rounds: Number(arg('--rounds') ?? 2) }); } catch (e) {
        if (e instanceof OutOfCredit) throw e;
        log(`! ${k.name}: ${(e as Error).message}`);
      }
    }
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
  } else if (cmd === 'judge' || cmd === 'sheet') {
    const ids = only ?? CLIPS.map((s) => s.id);
    for (const id of ids) if (!SHOTS.some((s) => s.id === id)) throw new Error(`unknown shot ${id}`);
    const draft = args.includes('--draft'), retimed = args.includes('--retimed');
    if (cmd === 'judge') for (const id of ids) await judgeClip(SHOTS.find((s) => s.id === id)!, draft, retimed);
    else await sheet(ids, draft, retimed, resolve(arg('--out') ?? join(OUT, 'sheets', `scenes${draft ? '-draft' : ''}.jpg`)));
  } else {
    console.error('usage: scene-clips.ts stills|keyframes|pick|judge|sheet …');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}

