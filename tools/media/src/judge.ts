/**
 * Likeness judge (1–5) for generated card art, calibrated on real held-out photos.
 *
 *   npx tsx src/judge.ts score <star> <image>...        → JSON line per image
 *   npx tsx src/judge.ts calibrate [--model m]           → identification accuracy and score spread
 *
 * Method — a blind line-up, not a yes/no question:
 *  1. Apple Vision (face.swift) finds the candidate's face; we cut a tight, roll-aligned face crop
 *     (little hair, no clothes) so the judge cannot match on hair colour or costume.
 *  2. A vision model sees the five talents as anonymous people A–E (two face crops each, order shuffled
 *     per call) plus the candidate, and rates 1–5 how likely the candidate is each person.
 *  3. Likeness = the rating for the intended talent; if another person rates as high or higher, it is
 *     capped (2.5 if she is not the top match, 3.5 on a tie). PASS is ≥ 4.
 *  4. A second, cheaper call compares the head crop with her references to list feature drift and
 *     score hair colour/cut against the bible (hair drift was a past review finding).
 *
 * Why not a direct "is this the same woman?" question: calibrated on held-out real photos, a single-pair
 * judge gave 4.5–5 to a different talent in about a third of trials. Why not local Vision feature prints
 * (likeness.ts): they identified the right talent in only 13–20 % of held-out photos (chance 20 %).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT } from './generate';
import { STARS, type Star } from './manifest';
import { JUDGE } from './models';
import { OutOfCredit, chat, dataUrl } from './openrouter';
import { REFS, detect, faceCrop, headBox, type Ref } from './refs';

const exec = promisify(execFile);
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? JUDGE.likeness.model;
export const DETAIL_MODEL = process.env.JUDGE_DETAIL_MODEL ?? JUDGE.detail.model;
export const PASS = 4;
const CACHE = join(OUT, 'judge');

/** What each talent's hair must look like on every card (agency clips and the key visual). */
export const HAIR: Record<Star, string> = {
  mahiro: 'dark chocolate-brown hair, soft waves, thin, airy wispy bangs',
  nana: 'very dark brown, almost black, long hair with thin, airy bangs',
  unpai: 'soft caramel / honey-brown hair with a light warm tint (bright orange or ginger is wrong), long and wavy, wispy bangs',
  alice: 'deep burgundy / wine-red hair with wispy curtain bangs',
  eimi: 'jet-black hair in a short chin-length bob with side-swept bangs'
};

async function refList(star: Star): Promise<Ref[]> {
  return (JSON.parse(await readFile(join(REFS, star, 'refs.json'), 'utf8')) as { refs: Ref[] }).refs;
}

/** Line-up references per talent: best frontal and best three-quarter (never profile). */
export async function lineupRefs(star: Star): Promise<Ref[]> {
  const refs = await refList(star);
  const front = refs.filter((r) => r.view === 'front');
  const threeQ = refs.filter((r) => r.view === 'left34' || r.view === 'right34').sort((a, b) => b.quality - a.quality);
  return [front[0], threeQ[0] ?? front[1]].filter(Boolean);
}

/** Detail-call references: best frontal, best three-quarter, a second frontal from another moment. */
export async function detailRefs(star: Star): Promise<Ref[]> {
  const refs = await refList(star);
  const front = refs.filter((r) => r.view === 'front');
  const [a, b] = await lineupRefs(star);
  const second = front.find((r) => r !== a && Math.abs(r.t - a.t) > 5) ?? front[1];
  return [a, b, second].filter(Boolean);
}

/** Tight aligned face crop, cached (JPEG 384 px). */
async function tight(src: string, key: string): Promise<Buffer | null> {
  const png = join(CACHE, `${key}.png`), jpg = join(CACHE, `${key}.jpg`);
  if (!existsSync(jpg)) {
    if (!(await faceCrop(src, png, 384, 1.3))) return null;
    await exec('ffmpeg', ['-v', 'error', '-i', png, '-q:v', '3', '-y', jpg]);
  }
  return readFile(jpg);
}

async function shrink(src: string, key: string, px = 640): Promise<Buffer> {
  const out = join(CACHE, `${key}.jpg`);
  if (!existsSync(out)) await exec('ffmpeg', ['-v', 'error', '-i', src, '-vf', `scale='min(${px},iw)':'min(${px},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', '-y', out]);
  return readFile(out);
}

/** Head-and-hair crop of the largest face (for the hair/drift call). */
async function headCrop(image: string, key: string): Promise<Buffer | null> {
  const [d] = await detect([image]);
  const face = d?.faces[0];
  if (!face) return null;
  const { side, x, y } = headBox(face, d.width, d.height);
  const out = join(CACHE, `${key}.jpg`);
  await exec('ffmpeg', ['-v', 'error', '-i', image, '-vf', `crop=${side}:${side}:${x}:${y},scale='min(640,iw)':-2`, '-q:v', '3', '-y', out]);
  return readFile(out);
}

export interface Verdict {
  score: number;              // 1–5 likeness for the intended talent (after caps)
  raw: number;                // the judge's own rating for her
  top: boolean;               // she was the single best match in the line-up
  lineup: Record<string, number>;  // rating per talent
  hair?: number;              // 1–5 against HAIR[star]
  quality?: number;           // 1–5 photographic quality (anatomy, hands, artefacts)
  modest?: boolean;           // fully and modestly clothed, adult styling
  issues: string[];
  facePx?: number;
  cost: number;
  error?: string;
}

const LINEUP_PROMPT = (letters: string[]) => `You are a forensic face-comparison examiner. Below are reference face photos of ${letters.length} different real women, labelled ${letters.join(', ')} (two photos each), followed by one CANDIDATE face.
Rate for EACH woman how likely the candidate is that same woman, judging only permanent facial anatomy: eye size and shape, eyelid crease, under-eye fullness, eyebrow shape, nose bridge and tip, lip shape, face shape and length, jaw and chin, and their proportions.
Ignore hair, makeup, lighting, colour, expression and image quality (the candidate may be a stylised photo).
Scale: 5 = certainly her, 4 = probably her, 3 = possible, 2 = unlikely, 1 = certainly not her. Only one woman can plausibly be the candidate, so at most one rating should be 4 or 5; rate the others honestly lower.
Answer with JSON only: {"ratings": {${letters.map((l) => `"${l}": n`).join(', ')}}, "best": "<letter>"}`;

const DETAIL_PROMPT = (hair: string) => `Images 1–3 are reference photos of one woman; image 4 is a candidate photo meant to show her.
List up to three concrete differences in permanent facial features of the candidate compared with the references (e.g. "eyes smaller", "face longer", "no under-eye fullness", "nose narrower"); return an empty list if none are noticeable.
Also rate the candidate's hair against the expected look "${hair}": 5 exact colour and cut, 3 close, 1 wrong colour.
Image 5 is the whole candidate picture: rate its photographic quality 1–5 (5 = flawless; lower for distorted hands or anatomy, warped faces, garbled objects, text or watermarks) and say whether she is fully and modestly clothed with adult styling. Be strict: modest is false if any cleavage is visible, if thighs are bare, if underwear shows, if she wears lingerie, swimwear or a school uniform, or if sheer fabric reveals her torso. Lined lace, lace sleeves, a yukata's crossed collar and a modest collarbone-level neckline are fine.
Answer with JSON only: {"issues": ["..."], "hair": n, "quality": n, "modest": true|false}`;

const seededShuffle = <T>(arr: T[], seed: number) => {
  const a = [...arr];
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

async function ask(model: string, parts: any[], purpose: string, id?: string): Promise<{ json: any; cost: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await chat({ model, parts, purpose, id, json: true, temperature: 0, maxTokens: 3000 });
      const m = /\{[\s\S]*\}/.exec(r.text);
      if (!m) throw new Error(`no JSON: ${r.text.slice(0, 120)}`);
      return { json: JSON.parse(m[0]), cost: r.cost };
    } catch (e) {
      if (e instanceof OutOfCredit || attempt >= 2) throw e;
    }
  }
}

export async function judge(star: Star, candidate: string, opts: { model?: string; id?: string; detail?: boolean; seed?: number } = {}): Promise<Verdict> {
  const model = opts.model ?? JUDGE_MODEL;
  await mkdir(CACHE, { recursive: true });
  const tag = `${basename(candidate).replace(/\.\w+$/, '')}-${Math.random().toString(36).slice(2, 7)}`;
  const [d] = await detect([candidate]);
  const facePx = d?.faces[0] ? Math.round(d.faces[0].w) : undefined;
  const cand = d?.faces[0] ? await tight(candidate, `cand-${tag}`) : null;
  if (!cand) return { score: 1, raw: 1, top: false, lineup: {}, issues: ['no face found'], cost: 0, error: 'no face' };

  // Line-up: talents shuffled, anonymous letters.
  const order = seededShuffle([...STARS], opts.seed ?? Math.floor(Math.random() * 1e9));
  const letters = order.map((_, i) => String.fromCharCode(65 + i));
  const parts: any[] = [{ type: 'text', text: LINEUP_PROMPT(letters) }];
  for (const [i, s] of order.entries()) {
    for (const [j, r] of (await lineupRefs(s)).entries()) {
      const img = await tight(join(REFS, s, r.file), `ref-${s}-${basename(r.file, '.jpg')}`);
      if (img) parts.push({ type: 'text', text: `Woman ${letters[i]}, photo ${j + 1}:` }, { type: 'image_url', image_url: { url: dataUrl(img) } });
    }
  }
  parts.push({ type: 'text', text: 'CANDIDATE:' }, { type: 'image_url', image_url: { url: dataUrl(cand) } });
  const { json, cost } = await ask(model, parts, 'likeness line-up', opts.id);
  const lineup: Record<string, number> = {};
  for (const [i, s] of order.entries()) lineup[s] = Number(json.ratings?.[letters[i]] ?? 1);
  const raw = lineup[star];
  const others = Math.max(...STARS.filter((s) => s !== star).map((s) => lineup[s]));
  const top = raw > others;
  let score = raw;
  if (raw < others) score = Math.min(score, 2.5);
  else if (raw === others) score = Math.min(score, 3.5);
  const v: Verdict = { score, raw, top, lineup, issues: [], facePx, cost };

  if (opts.detail !== false) {
    const head = await headCrop(candidate, `head-${tag}`);
    if (head) {
      const refs = await Promise.all((await detailRefs(star)).map((r) => shrink(join(REFS, star, r.file), `dref-${star}-${basename(r.file, '.jpg')}`)));
      const dp: any[] = [{ type: 'text', text: DETAIL_PROMPT(HAIR[star]) }];
      refs.forEach((b, i) => dp.push({ type: 'text', text: `Image ${i + 1}:` }, { type: 'image_url', image_url: { url: dataUrl(b) } }));
      dp.push({ type: 'text', text: 'Image 4 (candidate):' }, { type: 'image_url', image_url: { url: dataUrl(head) } });
      dp.push({ type: 'text', text: 'Image 5 (whole candidate picture):' }, { type: 'image_url', image_url: { url: dataUrl(await shrink(candidate, `whole-${tag}`, 768)) } });
      try {
        const r = await ask(DETAIL_MODEL, dp, 'likeness detail', opts.id);
        v.issues = Array.isArray(r.json.issues) ? r.json.issues.slice(0, 3) : [];
        v.hair = Number(r.json.hair);
        v.quality = Number(r.json.quality);
        v.modest = r.json.modest !== false;
        v.cost += r.cost;
      } catch (e) { if (e instanceof OutOfCredit) throw e; }
    }
  }
  return v;
}

const MODESTY_PROMPT = `Is the woman in this photo fully and modestly clothed with adult styling? Be strict: answer false if any cleavage is visible, if thighs are bare, if underwear shows, if she wears lingerie, swimwear or a school uniform, or if sheer fabric reveals her torso. Lined lace, lace sleeves, a yukata's crossed collar and a modest collarbone-level neckline are fine. Also rate photographic quality 1–5 (lower for distorted hands or anatomy, warped faces, garbled objects, text or watermarks).
Answer with JSON only: {"modest": true|false, "quality": n, "reason": "<short>"}`;

/** Wardrobe and quality audit of a finished picture (used on already published cards). */
export async function modesty(image: string, id?: string): Promise<{ modest: boolean; quality: number; reason: string; cost: number }> {
  await mkdir(CACHE, { recursive: true });
  const img = await shrink(image, `audit-${basename(image).replace(/\.\w+$/, '')}-${Math.random().toString(36).slice(2, 7)}`, 768);
  const r = await ask(DETAIL_MODEL, [{ type: 'text', text: MODESTY_PROMPT }, { type: 'image_url', image_url: { url: dataUrl(img) } }], 'wardrobe audit', id);
  return { modest: r.json.modest !== false, quality: Number(r.json.quality), reason: String(r.json.reason ?? ''), cost: r.cost };
}

/**
 * Held-out real photos the judge never sees as references: unseen frames of her clip, her crop from the
 * official key visual, stills from the agency PV (CAL_EXTRA json: [{star, file, kind}]). Old AI keyframes
 * (kind gen-old, reviewed at 2.9/5 by the owner) show where past generations would have landed.
 */
async function calibrate(model: string) {
  const held: { star: Star; file: string; kind: string }[] = [];
  for (const star of STARS) {
    const used = new Set([...(await lineupRefs(star)), ...(await detailRefs(star))].map((r) => r.file));
    const unseen = (await refList(star)).filter((r) => !used.has(r.file) && r.view !== 'profile');
    for (const r of [unseen[unseen.length - 1], unseen[Math.floor(unseen.length / 2)]].filter(Boolean)) held.push({ star, file: join(REFS, star, r.file), kind: 'ref-unseen' });
  }
  const extra = process.env.CAL_EXTRA ?? join(OUT, 'judge-cal-extra.json');
  if (existsSync(extra)) held.push(...(JSON.parse(await readFile(extra, 'utf8')) as typeof held));
  const rows: { star: Star; kind: string; file: string; v: Verdict }[] = [];
  for (const [i, h] of held.entries()) {
    const v = await judge(h.star, h.file, { model, detail: false, seed: i + 7 });
    rows.push({ ...h, v });
    console.log(`${h.kind.padEnd(10)} ${h.star.padEnd(6)} score=${v.score} top=${v.top} ${JSON.stringify(v.lineup)} ${v.error ?? ''}`);
  }
  const real = rows.filter((r) => r.kind !== 'gen-old' && !r.v.error);
  const stat = (xs: number[]) => (xs.length ? { n: xs.length, mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), min: Math.min(...xs), max: Math.max(...xs) } : null);
  const summary = {
    model,
    realTop1: `${real.filter((r) => r.v.top).length}/${real.length}`,
    realScore: stat(real.map((r) => r.v.score)),
    realPass: `${real.filter((r) => r.v.score >= PASS).length}/${real.length}`,
    wrongTalentMaxRating: stat(real.map((r) => Math.max(...STARS.filter((s) => s !== r.star).map((s) => r.v.lineup[s] ?? 1)))),
    genOld: stat(rows.filter((r) => r.kind === 'gen-old').map((r) => r.v.score)),
    genOldPass: `${rows.filter((r) => r.kind === 'gen-old' && r.v.score >= PASS).length}/${rows.filter((r) => r.kind === 'gen-old').length}`,
    byKind: Object.fromEntries([...new Set(rows.map((r) => r.kind))].map((k) => [k, stat(rows.filter((r) => r.kind === k).map((r) => r.v.score))])),
    cost: +rows.reduce((a, r) => a + r.v.cost, 0).toFixed(4)
  };
  console.log(JSON.stringify(summary, null, 2));
  await writeFile(join(REFS, `judge-calibration-${model.replace(/\//g, '_')}.json`), `${JSON.stringify({ at: new Date().toISOString(), summary, rows: rows.map((r) => ({ star: r.star, kind: r.kind, file: basename(r.file), score: r.v.score, top: r.v.top, lineup: r.v.lineup })) }, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === 'calibrate') return calibrate(arg('--model') ?? JUDGE_MODEL);
  if (args[0] === 'score') {
    const rest = args.slice(1).filter((a, i, all) => a !== '--model' && all[i - 1] !== '--model');
    const [star, ...files] = rest as [Star, ...string[]];
    for (const f of files) console.log(JSON.stringify({ file: basename(f), ...(await judge(star, f, { model: arg('--model') })) }));
    return;
  }
  console.error('usage: judge.ts score <star> <image>… | calibrate [--model m]');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
