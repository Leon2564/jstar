/**
 * npm run media:continuity -- <star> <image>…
 *
 * Continuity judge for clips that must join the owner-approved v1 hero loops (#24 phase 3): is the woman in
 * a candidate frame the same woman as in HER v1 hero clip? Same blind line-up method as judge.ts (#29), but
 * the references are the five talents' v1 hero first frames (both ratios) instead of the agency 4K refs, so a
 * frame that drifts from the approved look scores low even if it resembles the real person.
 *
 * Score = the rating for the intended talent (1–5); capped at 2.5 when another talent rates higher and 3.5
 * on a tie. PASS is ≥ 4, like judge.ts.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT } from './generate';
import { STARS, type Star } from './manifest';
import { JUDGE } from './models';
import { OutOfCredit, chat, dataUrl } from './openrouter';
import { faceCrop } from './refs';

const exec = promisify(execFile);
export const CONTINUITY_MODEL = process.env.JUDGE_MODEL ?? JUDGE.continuity.model;
const CACHE = join(OUT, 'continuity');
/** The v1 anchor frames (see keyframes.ts extractV1Anchors): out/keyframes/v2/<star>-hero-<r>-v1-a.png. */
const anchorFile = (star: Star, r: '16x9' | '9x16') => join(OUT, 'keyframes', 'v2', `${star}-hero-${r}-v1-a.png`);

export interface ContinuityVerdict { score: number; raw: number; top: boolean; lineup: Record<string, number>; cost: number; error?: string }

/** Continuity scores: the intended talent's rating, capped when another talent rates as high or higher. */
export function continuityScore(lineup: Record<string, number>, star: Star): { score: number; raw: number; top: boolean } {
  const raw = lineup[star] ?? 1;
  const others = Math.max(...Object.entries(lineup).filter(([s]) => s !== star).map(([, v]) => v), 1);
  const score = raw < others ? Math.min(raw, 2.5) : raw === others ? Math.min(raw, 3.5) : raw;
  return { score, raw, top: raw > others };
}

async function tight(src: string, key: string): Promise<Buffer | null> {
  const png = join(CACHE, `${key}.png`), jpg = join(CACHE, `${key}.jpg`);
  if (!existsSync(jpg)) {
    if (!(await faceCrop(src, png, 384, 1.3))) return null;
    await exec('ffmpeg', ['-v', 'error', '-i', png, '-q:v', '3', '-y', jpg]);
  }
  return readFile(jpg);
}

const PROMPT = (letters: string[]) => `You are a forensic face-comparison examiner. Below are reference face photos of ${letters.length} different women, labelled ${letters.join(', ')} (two photos each), followed by one CANDIDATE face.
Rate for EACH woman how likely the candidate is that same woman, judging only permanent facial anatomy: eye size and shape, eyelid crease, under-eye fullness, eyebrow shape, nose bridge and tip, lip shape, face shape and length, jaw and chin, and their proportions.
Ignore hair, makeup, lighting, colour, expression, head angle and image quality.
Scale: 5 = certainly her, 4 = probably her, 3 = possible, 2 = unlikely, 1 = certainly not her. Only one woman can plausibly be the candidate, so at most one rating should be 4 or 5.
Answer with JSON only: {"ratings": {${letters.map((l) => `"${l}": n`).join(', ')}}, "best": "<letter>"}`;

export async function continuity(star: Star, candidate: string, opts: { id?: string; seed?: number } = {}): Promise<ContinuityVerdict> {
  await mkdir(CACHE, { recursive: true });
  const cand = await tight(candidate, `cand-${basename(candidate).replace(/\.\w+$/, '')}-${Math.random().toString(36).slice(2, 7)}`);
  if (!cand) return { score: 1, raw: 1, top: false, lineup: {}, cost: 0, error: 'no face' };
  // Seeded Fisher–Yates: the talents appear in a different anonymous order on every call.
  let s = (opts.seed ?? Math.floor(Math.random() * 1e9)) || 1;
  const order: Star[] = [...STARS];
  for (let i = order.length - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const letters = order.map((_, i) => String.fromCharCode(65 + i));
  const parts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [{ type: 'text', text: PROMPT(letters) }];
  for (const [i, t] of order.entries()) {
    for (const r of ['16x9', '9x16'] as const) {
      const img = existsSync(anchorFile(t, r)) ? await tight(anchorFile(t, r), `v1-${t}-${r}`) : null;
      if (img) parts.push({ type: 'text', text: `Woman ${letters[i]}:` }, { type: 'image_url', image_url: { url: dataUrl(img) } });
    }
  }
  parts.push({ type: 'text', text: 'CANDIDATE:' }, { type: 'image_url', image_url: { url: dataUrl(cand) } });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await chat({ model: CONTINUITY_MODEL, parts, purpose: 'continuity line-up', id: opts.id, json: true, temperature: 0, maxTokens: 3000 });
      const m = /\{[\s\S]*\}/.exec(r.text);
      if (!m) throw new Error(`no JSON: ${r.text.slice(0, 120)}`);
      const json = JSON.parse(m[0]) as { ratings?: Record<string, number> };
      const lineup: Record<string, number> = {};
      for (const [i, t] of order.entries()) lineup[t] = Number(json.ratings?.[letters[i]] ?? 1);
      return { ...continuityScore(lineup, star), lineup, cost: r.cost };
    } catch (e) {
      if (e instanceof OutOfCredit || attempt >= 2) throw e;
    }
  }
}

async function main() {
  const [star, ...files] = process.argv.slice(2) as [Star, ...string[]];
  if (!STARS.includes(star) || !files.length) { console.error('usage: continuity.ts <star> <image>…'); process.exit(2); }
  for (const f of files) console.log(JSON.stringify({ file: basename(f), ...(await continuity(star, f)) }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
