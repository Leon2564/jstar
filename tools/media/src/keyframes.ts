/**
 * npm run media:keyframes -- [--only mahiro,nana] [--shot hero-16x9] [--n 2] [--rounds 2] [--concurrency 2] [--rescore] [--dry]
 * npm run media:keyframes -- --motion eimi-room-9x16,eimi-seated-9x16 [--n 2] [--rounds 2]   motion-pilot stills (#79)
 * npm run media:keyframes -- --motion eimi-room-9x16 --pick b                                 choose another candidate
 *
 * Stage 1 of every character loop: a likeness-checked still ("keyframe") per clip, made with gpt-image-2
 * (OpenRouter) before any Seedance credit is spent. The keyframe later opens and closes the clip.
 *
 * - Identity: head-and-hair frames from the agency's 4K footage (assets/agency/refs/<star>, private; see refs.ts):
 *   a frontal, a smiling frontal and a three-quarter view. v1 used ~300 px crops of a character sheet and
 *   averaged 2.9/5 in review.
 * - Location: the scene poster the site already shows for that time of day, so her clip and the empty scene match.
 * - Look: bright soft key light on the face, natural photobook retouching (v1's "no retouching, visible pores,
 *   dim light" aged the faces), closed-mouth smile into the lens, the same outfit and accessories in every ratio.
 * - Every candidate is scored by the likeness judge (judge.ts, 1–5 vs three references). Below PASS another
 *   round is generated with the judge's feature notes as corrections; the best candidate is picked.
 *
 * Output (local, gitignored): out/keyframes/v2/<id>-<a…>.png, <id>.json (prompt, references, scores, pick),
 * review-<star>.jpg.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT, ROOT } from './generate';
import { PASS, judge, type Verdict } from './judge';
import { COMPANION_SHOTS, MOTION_KEYFRAMES, STARS, TALENTS, WARDROBE_RULE, type CompanionKind, type MotionKeyframe, type Star, type Talent } from './manifest';
import { IMAGE } from './models';
import { OutOfCredit, images } from './openrouter';
import { REFS, detect, headBox, type Ref } from './refs';
import { continuity } from './continuity';

const exec = promisify(execFile);
/** v1 keyframes stay in out/keyframes/ (the card stream calibrates its judge on them). */
export const KEYFRAMES = join(OUT, 'keyframes', 'v2');

/**
 * v1 anchors (#24 phase 3): the owner approved the v1 hero loops (restored in #46), so presence clips join
 * those, not v2. Each anchor is frame 0 of the published v1 hero mp4 at full resolution, extracted rather than
 * generated (`--extract-v1`), then registered as a keyframe asset like any other.
 */
export const V1_ANCHORS = ['hero-16x9-v1', 'hero-9x16-v1'] as const;
export type V1Anchor = (typeof V1_ANCHORS)[number];
/** Wide first frames of the entrance dollies; each ends on the v1 hero anchor of the same ratio. */
export const ENTER_KINDS = ['enter-16x9', 'enter-9x16'] as const;
export type EnterKind = (typeof ENTER_KINDS)[number];
export type KeyframeKind = CompanionKind | EnterKind;
export const KINDS: KeyframeKind[] = [...COMPANION_SHOTS.map((c) => c.kind), ...ENTER_KINDS];
const isEnter = (k: KeyframeKind | 'motion'): k is EnterKind => (ENTER_KINDS as readonly string[]).includes(k);
/** Ratio and time of day of a kind; an entrance frame shares both with the hero it pushes in to. */
export function kindInfo(kind: KeyframeKind): { ratio: '16:9' | '9:16'; time: 'night' | 'morning' | 'day'; hero?: V1Anchor } {
  if (isEnter(kind)) return kind === 'enter-16x9' ? { ratio: '16:9', time: 'night', hero: 'hero-16x9-v1' } : { ratio: '9:16', time: 'night', hero: 'hero-9x16-v1' };
  const c = COMPANION_SHOTS.find((x) => x.kind === kind)!;
  return { ratio: c.ratio, time: c.time };
}

export interface KeyframeSpec {
  id: string;
  star: Star;
  kind: KeyframeKind | 'motion';
  aspect: '16:9' | '9:16';
  prompt: string;
  /** Local files in the order the prompt names them ("Reference image 1…"): identity first, the scene last. */
  references: string[];
  /** The next round's prompt with the judge's corrections (default: the companion keyframe prompt). */
  remake?: (corrections: string[]) => string;
  /** false: a people-free still — one round, no likeness judge, candidate a unless picked otherwise. */
  judged?: boolean;
}

/** Judge verdict kept per candidate: line-up likeness score (1–5), whether she was the top match, hair, feature drift. */
export interface Candidate { file: string; round: number; verdict?: Pick<Verdict, 'score' | 'top' | 'hair' | 'issues' | 'lineup' | 'error'> }
export interface KeyframeRecord { id: string; prompt: string; references: string[]; candidates: Candidate[]; pick?: string; cost: number; at: string }

/** Ratios that move with head pose, not with expression (a smile widens the mouth and narrows the eyes). */
const GEO = ['eyeWidth', 'faceLength', 'noseWidth', 'eyeMouth', 'chin'] as const;

/**
 * How far a frontal's landmark geometry is from her typical frontal (median per ratio, in median absolute
 * deviations). A raised chin or a tilted head shortens the lower face and shows up here; Vision's capture
 * quality does not notice it (unpai's "best" frame looked up at the ceiling and the keyframes copied it).
 */
export function poseOutlier(r: Ref, fronts: Ref[]): number {
  if (!r.geometry) return Infinity;
  let sum = 0;
  for (const k of GEO) {
    const v = fronts.map((f) => f.geometry?.[k]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const med = v[Math.floor(v.length / 2)];
    const mad = Math.max(v.map((x) => Math.abs(x - med)).sort((a, b) => a - b)[Math.floor(v.length / 2)], 0.01);
    sum += ((r.geometry[k] - med) / mad) ** 2;
  }
  return Math.sqrt(sum / GEO.length);
}

/**
 * Identity references from refs.json: the typical frontal (straight pose) with the best quality, the
 * widest-smile frontal from another moment, the best three-quarter view.
 */
export function pickIdentityRefs(refs: Ref[]): Ref[] {
  const all = refs.filter((r) => r.view === 'front');
  const typical = all.filter((r) => poseOutlier(r, all) <= 1);
  const fronts = (typical.length >= 2 ? typical : all).sort((a, b) => b.quality - a.quality);
  const main = fronts[0];
  const smile = fronts.filter((r) => r !== main && Math.abs(r.t - (main?.t ?? 0)) > 3).sort((a, b) => (b.geometry?.mouthWidth ?? 0) - (a.geometry?.mouthWidth ?? 0))[0] ?? fronts[1];
  const threeQ = refs.filter((r) => r.view === 'left34' || r.view === 'right34').sort((a, b) => b.quality - a.quality)[0];
  return [main, smile, threeQ].filter((r): r is Ref => !!r);
}

const FRAMING: Record<'16:9' | '9:16', string> = {
  '16:9': 'Horizontal 16:9 frame. She is on the right third of the frame (her face centred at about two thirds of the width), framed from the chest up, her face large and clear — about a third of the frame height. Leave clear space above her hair: the top of her head sits about 12% of the frame height below the top edge, not touching it. The left half is calm, uncluttered background, room for a title.',
  '9:16': 'Vertical 9:16 frame. She is framed from the chest up in the upper half of the frame, her face large and clear, the top of her head about 10% of the frame height below the top edge; the scene continues softly below her.'
};

const TIME: Record<'night' | 'morning' | 'day', string> = {
  night: 'It is night, blue hour: the room behind her keeps its deep navy and rose-pink night mood, while her face is brightly and softly lit.',
  morning: 'It is morning: soft, bright morning sunlight fills the room.',
  day: 'It is a bright afternoon: soft, clear daylight.'
};

/**
 * Structured like the OpenAI image prompting guide: scene → subject → details → constraints. `corrections` are
 * the judge's notes on the previous round ("eyes smaller than references") turned into instructions.
 */
const WIDE_FRAMING: Record<'16:9' | '9:16', string> = {
  '16:9': 'Horizontal 16:9 wide establishing shot. She is in the same part of the frame as in reference image 2 but much smaller (her head about one sixth of the frame height); most of the room is visible around her.',
  '9:16': 'Vertical 9:16 wide establishing shot. She is in the same part of the frame as in reference image 2 but much smaller (her head about one eighth of the frame height); most of the room is visible above and around her.'
};

/**
 * The entrance's wide first frame, built only from her v1 hero frame (reference 2) and a face close-up cut from
 * it (reference 1): no text description of outfit, hair or place, which would pull it away from the approved v1
 * look the dolly ends on.
 */
export function enterPrompt(kind: EnterKind, corrections: string[] = []): string {
  const { ratio } = kindInfo(kind);
  return [
    `A photorealistic still frame from the same video as reference image 2. ${WIDE_FRAMING[ratio]}`,
    'Reference image 2 is the close shot of this exact moment and reference image 1 is a close-up of her face in it: the same woman, face, hair, outfit, accessories, pose, expression, room, light and colour grade. Photograph that same moment from further back on the same line of sight, so that a slow straight push-in from this frame would end exactly on reference image 2.',
    'Her face must be an exact likeness of reference image 1: same eyes, eyelids, nose, lips, face shape and jawline. Do not idealize, beautify or change any of her features.',
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    'Keep everything else exactly as in reference image 2: her clothes, hair colour and cut, accessories, the room, its light and colours. She is fully clothed, looking into the lens.',
    'Depth: an out-of-focus foreground element at the edge of the frame that belongs to the room (a curtain edge, a plant, a window frame or the corner of furniture), and the background receding behind her, for a cinematic sense of depth.',
    'Camera: full-frame, 35mm lens at f/2.8, eye level, the room readable but softly out of focus behind her.',
    'Constraints: exactly one person; nothing in the frame but her and the room (no photography equipment); no text, no logo, no watermark.'
  ].join('\n');
}

export function keyframePrompt(t: Talent, kind: KeyframeKind, refCount: number, corrections: string[] = []): string {
  if (isEnter(kind)) return enterPrompt(kind, corrections);
  const shot = kindInfo(kind);
  const sceneRef = refCount + 1;
  const opening = shot.hero
    ? [
        `A photorealistic photograph, like a still from a professional Japanese photobook shoot. ${WIDE_FRAMING[shot.ratio]}`,
        `Reference image ${sceneRef} is the close-up of this exact moment: the same woman, outfit, hair, accessories, pose, expression, room and light. Photograph that same moment from further back on the same line of sight, so that a slow straight push-in from this photo would end exactly on reference image ${sceneRef}. Location: ${t.place[shot.time]}. ${TIME[shot.time]}`,
        'Depth: an out-of-focus foreground element at the edge of the frame that belongs to the location (a curtain edge, a plant, a window frame or the corner of furniture), and the background receding behind her, for a cinematic sense of depth.'
      ]
    : [
        `A photorealistic photograph, like a still from a professional Japanese photobook shoot. ${FRAMING[shot.ratio]}`,
        `Location: reference image ${sceneRef} — ${t.place[shot.time]}. Keep that location, its furniture and its colours. ${TIME[shot.time]}`
      ];
  return [
    ...opening,
    `Reference images 1 to ${refCount} are all the same real young woman (front, smiling front, three-quarter). Her face must be an exact likeness of reference image 1 — same eye size and shape, same double eyelids and under-eye fullness, same nose, same lip shape and fullness, same face shape, length and jawline, same eyebrows. Key features: ${t.features}. Do not idealize, beautify, slim, lengthen or change any of her features; she must be instantly recognizable as the same person.`,
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    `Hair: ${t.hair} — exactly this colour and cut. Accessories: ${t.accessories}. The headbands, bows, collars and chokers in the reference photos are costume; do not copy them.`,
    `She wears ${t.wearing}; ${WARDROBE_RULE}. She is an adult woman in her twenties.`,
    `She looks straight into the lens with ${t.expression}, lips gently closed (teeth not showing); her head upright and level (chin neither raised nor lowered), relaxed shoulders — a first-person point of view, as if you have just arrived.`,
    shot.hero ? 'Camera: full-frame, 35mm lens at f/2.8, eye level, the room readable but softly out of focus behind her.' : 'Camera: full-frame, 85mm lens at f/2, eye level, shallow depth of field, background softly out of focus.',
    'Light: a bright, soft key light from the front, like a large window, lights her face evenly with clear catchlights in her eyes; soft fill, no harsh shadows.',
    'Finish: natural photobook retouching — smooth, luminous, fresh skin that keeps its natural texture, not plastic or waxy; true-to-life colours, gentle contrast.',
    'Constraints: exactly one person; nothing in the frame but her and the location (no photography equipment); no text, no logo, no watermark.'
  ].join('\n');
}

async function refsOf(star: Star): Promise<string[]> {
  const file = join(REFS, star, 'refs.json');
  if (!existsSync(file)) return [];
  const { refs } = JSON.parse(await readFile(file, 'utf8')) as { refs: Ref[] };
  return pickIdentityRefs(refs).map((r) => join(REFS, star, r.file));
}

export async function specsFor(stars: Star[], kinds: KeyframeKind[] = KINDS, corrections: Partial<Record<string, string[]>> = {}): Promise<KeyframeSpec[]> {
  const out: KeyframeSpec[] = [];
  for (const star of stars) {
    const t = TALENTS.find((x) => x.star === star)!;
    const faces = await refsOf(star);
    for (const kind of kinds) {
      const shot = kindInfo(kind);
      const id = `${star}-${kind}`;
      if (shot.hero) {
        // An entrance frame: her v1 hero anchor (same moment, further back) and a face close-up cut from it.
        const anchor = `${star}-${shot.hero}`;
        if (!(await loadRecord(anchor))?.pick) throw new Error(`${id}: extract the v1 anchor first (npm run media:keyframes -- --extract-v1)`);
        out.push({ id, star, kind, aspect: shot.ratio, prompt: keyframePrompt(t, kind, 1, corrections[id]), references: [join(KEYFRAMES, `${anchor}-head.jpg`), join(KEYFRAMES, `${anchor}-a.png`)] });
        continue;
      }
      const scene = join(ROOT, 'apps/web/public/media', `${star}-${shot.time}-${shot.ratio === '16:9' ? '16x9' : '9x16'}`, 'poster.jpg');
      out.push({ id, star, kind, aspect: shot.ratio, prompt: keyframePrompt(t, kind, faces.length, corrections[id]), references: [...faces, scene] });
    }
  }
  return out;
}

/**
 * Motion-pilot stills (#79): built on an already picked picture (`from`: same room, same camera), so every
 * still of a chain shows one room. With her in it, the identity rules are the companion keyframe's.
 */
export function motionPrompt(mk: MotionKeyframe, refCount: number, corrections: string[] = []): string {
  const t = TALENTS.find((x) => x.star === mk.star)!;
  const frame = mk.ratio === '9:16' ? 'Vertical 9:16 frame.' : 'Horizontal 16:9 frame.';
  const constraints = 'Constraints: nothing in the frame but the location (no photography equipment); no text, no logo, no watermark.';
  if (!mk.person) {
    return [
      `A photorealistic photograph of an interior, like a still from a professional Japanese photobook shoot. ${frame}`,
      `Reference image 1 shows the location (with a woman in it). ${mk.brief}`,
      'No people at all: no woman, no figure, no silhouette, no reflection of a person. Keep the location\'s furniture, colours and night mood: deep navy shadows, warm rose-pink light.',
      'Camera: full-frame, 35mm lens, eye level, the room sharp from front to back.',
      constraints
    ].join('\n');
  }
  const base = refCount + 1;
  return [
    `A photorealistic photograph, like a still from a professional Japanese photobook shoot. ${frame}`,
    `Reference image ${base} is the base picture. ${mk.brief}`,
    `Reference images 1 to ${refCount} are all the same real young woman (front, smiling front, three-quarter). Her face must be an exact likeness of reference image 1 — same eye size and shape, same double eyelids and under-eye fullness, same nose, same lip shape and fullness, same face shape, length and jawline, same eyebrows. Key features: ${t.features}. Do not idealize, beautify, slim, lengthen or change any of her features; she must be instantly recognizable as the same person.`,
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    `Hair: ${t.hair} — exactly this colour and cut. Accessories: ${t.accessories}. The headbands, bows, collars and chokers in the reference photos are costume; do not copy them.`,
    `She wears ${mk.wearing ?? t.wearing}; ${WARDROBE_RULE}. She is an adult woman in her twenties.`,
    `She looks straight into the lens with ${t.expression}, lips gently closed (teeth not showing); her head upright and level — a first-person point of view.`,
    'Light: the location keeps its night mood, while a bright, soft key light from the front lights her face evenly with clear catchlights in her eyes; no harsh shadows.',
    'Finish: natural photobook retouching — smooth, luminous, fresh skin that keeps its natural texture; true-to-life colours, gentle contrast.',
    `Constraints: exactly one person, anatomically natural hands with five fingers; ${constraints.slice('Constraints: '.length)}`
  ].join('\n');
}

export async function motionSpecsFor(names: string[]): Promise<KeyframeSpec[]> {
  const out: KeyframeSpec[] = [];
  for (const name of names) {
    const mk = MOTION_KEYFRAMES.find((m) => m.name === name);
    if (!mk) throw new Error(`unknown motion keyframe "${name}" (${MOTION_KEYFRAMES.map((m) => m.name).join(', ')})`);
    const pick = (await loadRecord(mk.from))?.pick;
    // A missing base stays visible in the reference list, so main() reports it instead of generating without it.
    const basePic = pick ? join(KEYFRAMES, pick) : join(KEYFRAMES, `${mk.from}.json (no pick yet)`);
    const faces = mk.person ? await refsOf(mk.star) : [];
    out.push({
      id: name, star: mk.star, kind: 'motion', aspect: mk.ratio, prompt: motionPrompt(mk, faces.length), references: [...faces, basePic],
      remake: (c) => motionPrompt(mk, faces.length, c), judged: mk.person
    });
  }
  return out;
}

/** Candidates are <id>-a.png, <id>-b.png …; the pick is recorded in <id>.json. */
export const candidateName = (id: string, i: number) => `${id}-${String.fromCharCode(97 + i)}.png`;

/** Best candidate: identity first, hair colour second. */
export function bestCandidate(cands: Candidate[]): Candidate | undefined {
  return cands.filter((c) => c.verdict && !c.verdict.error).sort((a, b) => b.verdict!.score - a.verdict!.score || (b.verdict!.hair ?? 0) - (a.verdict!.hair ?? 0))[0];
}

const recordPath = (id: string) => join(KEYFRAMES, `${id}.json`);
export async function loadRecord(id: string): Promise<KeyframeRecord | null> {
  return existsSync(recordPath(id)) ? (JSON.parse(await readFile(recordPath(id), 'utf8')) as KeyframeRecord) : null;
}
const saveRecord = (r: KeyframeRecord) => writeFile(recordPath(r.id), `${JSON.stringify(r, null, 2)}\n`);

async function score(star: Star, c: Candidate, log: (m: string) => void) {
  if (c.file.includes('-enter-')) {
    // Entrance frames must continue her approved v1 hero clip: judged against the v1 frames, not the 4K refs.
    const v = await continuity(star, join(KEYFRAMES, c.file), { id: c.file });
    c.verdict = { score: v.score, top: v.top, issues: [], lineup: v.lineup, ...(v.error ? { error: v.error } : {}) };
    log(`  ${c.file}: continuity ${v.score}${v.top ? '' : ' (not top match)'}`);
    return;
  }
  const v = await judge(star, join(KEYFRAMES, c.file), { id: c.file });
  c.verdict = { score: v.score, top: v.top, hair: v.hair, issues: v.issues, lineup: v.lineup, ...(v.error ? { error: v.error } : {}) };
  log(`  ${c.file}: likeness ${v.score}${v.top ? '' : ' (not top match)'} hair ${v.hair ?? '?'}${v.issues.length ? ` — ${v.issues.join('; ')}` : ''}`);
}

/** Generate → score → (below PASS) regenerate with corrections, up to `rounds`; returns the record. */
async function runSpec(spec: KeyframeSpec, opts: { n: number; rounds: number; rescore: boolean }, log: (m: string) => void): Promise<KeyframeRecord> {
  const rec: KeyframeRecord = (await loadRecord(spec.id)) ?? { id: spec.id, prompt: spec.prompt, references: [], candidates: [], cost: 0, at: '' };
  rec.references = spec.references.map((f) => f.replace(`${ROOT}/`, '').replace(REFS, 'assets/agency/refs'));
  const judged = spec.judged !== false;
  if (judged) for (const c of rec.candidates) if (!c.verdict || opts.rescore) await score(spec.star, c, log);
  let round = Math.max(0, ...rec.candidates.map((c) => c.round));
  const done = () => (judged ? (bestCandidate(rec.candidates)?.verdict?.score ?? 0) >= PASS : rec.candidates.length > 0);
  while (!done() && round < opts.rounds) {
    round++;
    const issues = [...new Set(rec.candidates.flatMap((c) => c.verdict?.issues ?? []))].slice(0, 6);
    const t = TALENTS.find((x) => x.star === spec.star)!;
    const prompt = round === 1 ? spec.prompt : spec.remake ? spec.remake(issues) : keyframePrompt(t, spec.kind as KeyframeKind, spec.references.length - 1, issues);
    const refs = await Promise.all(spec.references.map((f) => readFile(f)));
    try {
      const r = await images({ model: process.env.OPENROUTER_IMAGE_MODEL ?? IMAGE.keyframe.model, prompt, refs, aspect: spec.aspect, n: opts.n, purpose: `keyframe ${spec.id} r${round}`, id: spec.id });
      rec.cost += r.cost;
      rec.prompt = prompt;
      for (const img of r.images) {
        const file = candidateName(spec.id, rec.candidates.length);
        await writeFile(join(KEYFRAMES, file), img);
        rec.candidates.push({ file, round });
      }
      log(`✓ ${spec.id} round ${round}: ${r.images.length} candidate(s) ($${r.cost.toFixed(3)})`);
    } catch (e) {
      if (e instanceof OutOfCredit) throw e;
      log(`! ${spec.id} round ${round}: ${(e as Error).message.slice(0, 200)}`);
    }
    if (judged) for (const c of rec.candidates) if (!c.verdict) await score(spec.star, c, log);
    rec.at = new Date().toISOString();
    await saveRecord(rec);
  }
  if (!judged) {
    rec.pick ??= rec.candidates[0]?.file;
    await saveRecord(rec);
    log(`→ ${spec.id}: ${rec.pick ?? 'no candidate'} (people-free still: not judged; choose with --pick)`);
    return rec;
  }
  const best = bestCandidate(rec.candidates);
  rec.pick = best?.file;
  await saveRecord(rec);
  log(`→ ${spec.id}: ${best ? `${best.file} likeness ${best.verdict!.score} hair ${best.verdict!.hair ?? '?'}` : 'no candidate'}${(best?.verdict?.score ?? 0) < PASS ? ' (below pass)' : ''}`);
  return rec;
}

/** One sheet per talent: her first reference, then every candidate (scored), for human review. */
async function reviewSheet(star: Star) {
  const recs = (await Promise.all(KINDS.map((k) => loadRecord(`${star}-${k}`)))).filter((r): r is KeyframeRecord => !!r);
  const refs = await refsOf(star);
  const files = [refs[0], ...recs.flatMap((r) => r.candidates.map((c) => join(KEYFRAMES, c.file)))].filter((f) => f && existsSync(f));
  if (files.length < 2) return;
  const inputs = files.flatMap((f) => ['-i', f]);
  const scaled = files.map((_, i) => `[${i}:v]scale=-2:480[v${i}]`).join(';');
  const stack = files.map((_, i) => `[v${i}]`).join('');
  await exec('ffmpeg', ['-v', 'error', '-y', '-threads', '2', ...inputs, '-filter_complex', `${scaled};${stack}hstack=${files.length}`, '-frames:v', '1', '-q:v', '3', join(KEYFRAMES, `review-${star}.jpg`)]);
}

/**
 * v1 anchors: frame 0 of her published v1 hero mp4 (largest H.264, full resolution) → <star>-hero-<r>-v1-a.png,
 * a head crop for the entrance prompt (-head.jpg) and a record whose pick is the frame (media:talent keyframes
 * uploads it; media:check compares clip ends with it).
 */
export async function extractV1Anchors(stars: Star[], log: (m: string) => void, force = false) {
  await mkdir(KEYFRAMES, { recursive: true });
  for (const star of stars) for (const anchor of V1_ANCHORS) {
    const r = anchor.startsWith('hero-16x9') ? '16x9' : '9x16';
    const id = `${star}-${anchor}`;
    const png = join(KEYFRAMES, `${id}-a.png`), head = join(KEYFRAMES, `${id}-head.jpg`);
    if (!force && existsSync(png) && existsSync(head) && (await loadRecord(id))?.pick) { log(`= ${id}`); continue; }
    const dir = join(ROOT, 'apps/web/public/media', `${star}-hero-${r}`);
    const mp4 = (await readdir(dir)).filter((f) => /^h264-\d+x\d+\.mp4$/.test(f)).sort((a, b) => Number(b.split(/[-x.]/)[1]) - Number(a.split(/[-x.]/)[1]))[0];
    if (!mp4) throw new Error(`${id}: no H.264 file in ${dir}`);
    await exec('ffmpeg', ['-v', 'error', '-y', '-threads', '2', '-i', join(dir, mp4), '-frames:v', '1', png]);
    const [d] = await detect([png]);
    if (!d?.faces[0]) throw new Error(`${id}: no face in the v1 frame`);
    const { side, x, y } = headBox(d.faces[0], d.width, d.height);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', `crop=${side}:${side}:${x}:${y},scale=768:768:flags=lanczos`, '-q:v', '2', head]);
    const file = `${id}-a.png`;
    await saveRecord({ id, prompt: `frame 0 of the published v1 hero loop (${mp4})`, references: [join('apps/web/public/media', `${star}-hero-${r}`, mp4)], candidates: [{ file, round: 0 }], pick: file, cost: 0, at: new Date().toISOString() });
    log(`✓ ${id} ← ${star}-hero-${r}/${mp4} (${d.width}×${d.height}, face ${Math.round(d.faces[0].w)} px)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const stars = (arg('--only')?.split(',') ?? [...STARS]) as Star[];
  if (args.includes('--extract-v1')) return extractV1Anchors(stars, (m) => console.log(m), args.includes('--force'));
  const kinds = (arg('--shot')?.split(',') ?? KINDS) as KeyframeKind[];
  for (const k of kinds) if (!KINDS.includes(k)) throw new Error(`unknown shot "${k}" (${KINDS.join(', ')})`);
  const motion = arg('--motion')?.split(',');
  if (motion && arg('--pick')) {
    for (const id of motion) {
      const rec = await loadRecord(id);
      const file = candidateName(id, arg('--pick')!.charCodeAt(0) - 97);
      if (!rec?.candidates.some((c) => c.file === file)) throw new Error(`${id} has no candidate ${file}`);
      rec.pick = file;
      await saveRecord(rec);
      console.log(`${id}: pick ${file}`);
    }
    return;
  }
  const specs = motion ? await motionSpecsFor(motion) : await specsFor(stars, kinds);
  if (args.includes('--dry')) { for (const s of specs) console.log(`── ${s.id} (${s.aspect}, refs: ${s.references.map((r) => r.replace(`${ROOT}/`, '')).join(', ')})\n${s.prompt}\n`); return; }
  const missing = [...new Set(specs.flatMap((sp) => sp.references))].filter((f) => !existsSync(f));
  if (missing.length || specs.some((s) => s.judged !== false && s.references.length < (isEnter(s.kind) ? 2 : 3))) throw new Error(`missing reference files (assets/agency/refs is local-only; run npm run media:refs):\n${missing.join('\n')}`);
  await mkdir(KEYFRAMES, { recursive: true });
  const queue = [...specs];
  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  const opts = { n: Number(arg('--n') ?? 2), rounds: Number(arg('--rounds') ?? 2), rescore: args.includes('--rescore') };
  const results: KeyframeRecord[] = [];
  let stop = false;
  await Promise.all(Array.from({ length: Number(arg('--concurrency') ?? 2) }, async () => {
    for (let s = queue.shift(); s && !stop; s = queue.shift()) {
      try { results.push(await runSpec(s, opts, log)); } catch (e) {
        if (e instanceof OutOfCredit) { stop = true; log(`■ out of OpenRouter credit (${e.message}); stopping cleanly`); } else log(`! ${s.id}: ${(e as Error).message}`);
      }
    }
  }));
  for (const star of motion ? [] : stars) await reviewSheet(star).catch((e) => log(`! review sheet ${star}: ${(e as Error).message}`));
  const spent = results.reduce((a, r) => a + r.cost, 0);
  log(`done: ${results.filter((r) => r.pick).length}/${specs.length} picked, cumulative keyframe cost of these shots $${spent.toFixed(2)}. Sheets: ${KEYFRAMES.replace(`${ROOT}/`, '')}/review-<star>.jpg`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
