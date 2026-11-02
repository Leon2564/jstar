/**
 * Stills and checks for the variant-card clips (#81; shots in shots/variants-v11.ts).
 *
 *   npx tsx src/variant-keyframes.ts rooms   [--only mahiro,…]      her empty night room: frame 0 of the published night-9x16 and -16x9 loops
 *   npx tsx src/variant-keyframes.ts outfits [--only …]             the card's outfit with the head cut away (reference only)
 *   npx tsx src/variant-keyframes.ts home    [--only …] [--n 2] [--rounds 2]   she stands in that room in the card's outfit
 *   npx tsx src/variant-keyframes.ts close   [--only …] [--n 2] [--rounds 2]   the home still photographed closer
 *   npx tsx src/variant-keyframes.ts home16  [--only …] [--n 2] [--rounds 2]   the home still again in her 16:9 room, for landscape
 *                                        [--fix "<correction>"]  one more round with that correction (a detail the face judge cannot see)
 *   npx tsx src/variant-keyframes.ts pick <still> <letter>          choose another candidate
 *   npx tsx src/variant-keyframes.ts verify --only <clip ids> [--draft]   continuity of clip frames + seams to the stills
 *
 * Why not media:keyframes --motion: its prompt draws her face from the agency 4K refs with the v2 hair, while these
 * clips must continue her owner-approved v1 hero look (#46). So the identity references here are her v1 hero frame
 * (out/keyframes/v2/<star>-hero-<ratio>-v1-a.png, of the still's ratio) and a face close-up cut from it, and every candidate is judged by
 * continuity.ts (blind line-up against the five v1 hero frames, pass 4). The outfit comes from the published card
 * image with the head removed, so the card's face and hair cannot leak into her.
 *
 * Records are written like media:keyframes's (out/keyframes/v2/<still>.json, verdict.score = continuity), so
 * media:talent -- keyframes <star> --motion <still> registers the picks and media:pack shows the scores.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { continuity } from './continuity';
import { OUT, ROOT, stateKey } from './generate';
import { KEYFRAMES, candidateName, loadRecord, type Candidate, type KeyframeRecord } from './keyframes';
import { SHOTS, STARS, WARDROBE_RULE, anchorsOf, type Star } from './manifest';
import { IMAGE } from './models';
import { mad, rawFile, thumbs } from './motion';
import { OutOfCredit, images } from './openrouter';
import { detect } from './refs';
import { VARIANT_LOOKS, variantStill, type VariantLook } from './shots/variants-v11';

const exec = promisify(execFile);
const PASS = 4;
/** Clip frame vs the still it is anchored to (64×64 grey MAD): a gpt-image still re-rendered by Seedance measures a few units; another room 40+. */
export const MAX_STILL_SEAM = 12;
const look = (star: Star) => VARIANT_LOOKS.find((v) => v.star === star)!;
type R = '9x16' | '16x9';
const v1Frame = (star: Star, r: R = '9x16') => join(KEYFRAMES, `${star}-hero-${r}-v1-a.png`);
const v1Head = (star: Star, r: R = '9x16') => join(KEYFRAMES, `${star}-hero-${r}-v1-head.jpg`);
const outfitFile = (star: Star) => join(KEYFRAMES, `${star}-variant-outfit.jpg`);
const saveRecord = (r: KeyframeRecord) => writeFile(join(KEYFRAMES, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
const pickFile = async (name: string) => { const p = (await loadRecord(name))?.pick; return p ? join(KEYFRAMES, p) : undefined; };
const jpg = async (src: string) => (await exec('ffmpeg', ['-v', 'error', '-i', src, '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 })).stdout as unknown as Buffer;

/** Frame 0 of her published night loops at full size: exactly the picture the site shows before she walks in. */
async function rooms(stars: Star[]) {
  await mkdir(KEYFRAMES, { recursive: true });
  for (const star of stars) for (const r of ['9x16', '16x9'] as const) {
    const name = r === '9x16' ? variantStill.room(star) : variantStill.room16(star), file = candidateName(name, 0);
    const src = join(ROOT, 'apps/web/public/media', `${star}-night-${r}`, r === '9x16' ? 'h264-1080x1920.mp4' : 'h264-1920x1080.mp4');
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', join(KEYFRAMES, file)]);
    await saveRecord({ id: name, prompt: `frame 0 of the published night loop (${src.replace(`${ROOT}/`, '')})`, references: [src.replace(`${ROOT}/`, '')], candidates: [{ file, round: 0 }], pick: file, cost: 0, at: new Date().toISOString() });
    console.log(`✓ ${name}`);
  }
}

/** The card with her head and hair painted out (navy), so only the outfit and the prop are left to copy. */
async function outfits(stars: Star[]) {
  for (const star of stars) {
    const card = join(ROOT, 'apps/web/public/cards', look(star).card, 'card.webp');
    const png = join(KEYFRAMES, `${star}-variant-card.png`);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', card, png]);
    const [d] = await detect([png]);
    const f = [...(d?.faces ?? [])].sort((a, b) => b.w - a.w)[0];
    if (!f) throw new Error(`${star}: no face on the card`);
    // Head and hair: from well above the hairline to just under the chin, a little wider than the hair.
    const x = Math.max(0, Math.round(f.x - f.w * 0.75)), w = Math.min(d.width - x, Math.round(f.w * 2.5));
    const h = Math.round(f.y + f.h * 1.08);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', `drawbox=x=${x}:y=0:w=${w}:h=${h}:color=0x24284D:t=fill`, '-q:v', '2', outfitFile(star)]);
    console.log(`✓ ${star}: outfit reference (head box ${x},0 ${w}×${h} filled)`);
  }
}

const CAMERA_LIGHT = [
  'Light: the location keeps its night mood and colours, while a bright, soft key light from the front lights her face evenly with clear catchlights in her eyes; no harsh shadows. Match the skin rendering of reference image 1.',
  'Finish: natural photobook retouching — smooth, luminous, fresh skin that keeps its natural texture; true-to-life colours, gentle contrast.',
  'Constraints: exactly one person, anatomically natural hands with five fingers; nothing in the frame but her and the location (no photography equipment); no text, no logo, no watermark.'
];

/** `photo`: reference 2 is also her (the close still shows her in the home still); the home still gets only her face, so the room of the base picture wins over her v1 frame's. */
function identity(v: VariantLook, photo: boolean): string[] {
  const refs = photo ? 'reference images 1 and 2' : 'reference image 1';
  return [
    `Identity: ${photo ? 'reference image 1 is a close-up of her face and reference image 2 is a photograph of her in this outfit: the same woman' : 'reference image 1 is a close-up of her face'}. Her face must be an exact likeness of reference image 1 — same eyes, eyelids, eyebrows, nose, lips, face shape, length and jawline, same skin tone. Do not idealize, beautify, slim or change any of her features.`,
    `Hair: exactly her hair in ${refs} — ${v.hair}. Same colour, length, cut and bangs.${v.face ? ` ${v.face.replace('reference images 1 and 2', refs)}` : ''}`
  ];
}

/** Home still: she stands in her empty night room (reference 3, the base picture) in the card's outfit (reference 2); her face from reference 1 only. */
export function homePrompt(v: VariantLook, corrections: string[] = []): string {
  return [
    'A photorealistic photograph, like a still from a professional Japanese photobook shoot. Vertical 9:16 frame.',
    'Reference image 3 is the base picture: keep exactly this location, camera position, lens, angle, framing and light — the same furniture, walls, windows and curtains in the same places of the frame; only add her. Place the woman in it: she stands facing the camera near the middle of the frame, framed from the waist up, close to the camera; her face is large and clear in the upper third of the frame, the top of her head about 10% of the frame height below the top edge; the location continues behind her, softly out of focus.',
    ...(v.roomNote ? [v.roomNote] : []),
    ...identity(v, false),
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    `Outfit: reference image 2 shows the outfit to dress her in (the head in it is blanked out; take nothing else from that woman). She wears ${v.outfit} — copy its colours, fabric, cut and details exactly. ${v.prop} ${WARDROBE_RULE}. She is an adult woman in her twenties.`,
    'She looks straight into the lens with a soft, warm closed-mouth smile, lips gently closed (teeth not showing); her head upright and level, relaxed shoulders — a first-person point of view.',
    ...CAMERA_LIGHT
  ].join('\n');
}

/**
 * Landscape home still: her 16:9 night room (reference 3) as the base, the card's outfit (reference 2), her v1 hero
 * 16:9 face (reference 1) and the picked 9:16 home still (reference 4) so both ratios show the same outfit and prop.
 * She stands in the middle of the frame: a landscape screen narrower than 16:9 crops the sides, a wider one the top
 * and bottom, and her face must survive both.
 */
export function home16Prompt(v: VariantLook, corrections: string[] = []): string {
  return [
    'A photorealistic photograph, like a still from a professional Japanese photobook shoot. Horizontal 16:9 frame.',
    'Reference image 3 is the base picture: keep exactly this location, camera position, lens, angle, framing and light — the same furniture, walls, windows and curtains in the same places of the frame; only add her. Place the woman in it: she stands facing the camera in the horizontal centre of the frame, framed from the waist up, close to the camera; her face is large and clear, centred left to right, in the upper third of the frame, the top of her head about 10% of the frame height below the top edge. She and what she holds stay within the middle half of the frame\'s width; the location continues on both sides of her and behind her, softly out of focus.',
    // The 9:16 room notes name furniture where the 9:16 frame has it; the 16:9 night loop is laid out differently.
    'Keep the room as dark and its colours exactly as in reference image 3: do not brighten it, recolour it or add or move furniture.',
    ...identity(v, false),
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    `Outfit: reference image 2 shows the outfit to dress her in (the head in it is blanked out; take nothing else from that woman). She wears ${v.outfit} — copy its colours, fabric, cut and details exactly. ${v.prop} Reference image 4 is a photograph of this same woman in this same outfit in a vertical frame: her clothes, what she holds, her hair and make-up must match it exactly; take nothing of its framing or background. ${WARDROBE_RULE}. She is an adult woman in her twenties.`,
    'She looks straight into the lens with a soft, warm closed-mouth smile, lips gently closed (teeth not showing); her head upright and level, relaxed shoulders — a first-person point of view.',
    ...CAMERA_LIGHT
  ].join('\n');
}

/** Close still: the picked home still (reference 2) photographed closer — the same moment, chest up, no hands. */
export function closePrompt(v: VariantLook, corrections: string[] = []): string {
  return [
    'A photorealistic photograph, like a still from a professional Japanese photobook shoot. Vertical 9:16 frame.',
    'Reference image 2 is the base picture. Photograph the same woman in the same moment from closer, on the same line of sight: a close shot from the chest up, her face large and clear in the upper half of the frame (about a quarter of the frame height), the top of her head about 8% of the frame height below the top edge. Her hands and anything she holds are below the frame. The same room, light and colour grade behind her, softly out of focus.',
    ...identity(v, true),
    ...(corrections.length ? [`Corrections from the previous attempt (fix these): ${corrections.join('; ')}.`] : []),
    `Outfit: exactly as in reference image 2 — ${v.outfit}. ${WARDROBE_RULE}. She is an adult woman in her twenties.`,
    'She looks straight into the lens with a soft, warm closed-mouth smile, lips gently closed (teeth not showing); her head upright and level — a first-person point of view.',
    ...CAMERA_LIGHT
  ].join('\n');
}

async function score(star: Star, c: Candidate) {
  const v = await continuity(star, join(KEYFRAMES, c.file), { id: c.file });
  c.verdict = { score: v.score, top: v.top, issues: [], lineup: v.lineup, ...(v.error ? { error: v.error } : {}) };
  console.log(`  ${c.file}: continuity ${v.score}${v.top ? '' : ' (not top match)'} ${JSON.stringify(v.lineup)}`);
}

/** `fix`: one more round with this correction even when a candidate already passes (the judge sees faces only). */
async function stills(kind: 'home' | 'close' | 'home16', stars: Star[], n: number, rounds: number, fix?: string) {
  for (const star of stars) {
    const v = look(star);
    const name = kind === 'home' ? variantStill.home(star) : kind === 'close' ? variantStill.close(star) : variantStill.home16(star);
    const base = await pickFile(kind === 'home' ? variantStill.room(star) : kind === 'close' ? variantStill.home(star) : variantStill.room16(star));
    const refs = kind === 'home' ? [v1Head(star), outfitFile(star), base]
      : kind === 'close' ? [v1Head(star), base]
      : [v1Head(star, '16x9'), outfitFile(star), base, await pickFile(variantStill.home(star))];
    const missing = refs.filter((f) => !f || !existsSync(f));
    if (missing.length) { console.log(`! ${name}: missing ${missing.join(', ') || 'base picture'} (run rooms / outfits / home first)`); continue; }
    const rec: KeyframeRecord = (await loadRecord(name)) ?? { id: name, prompt: '', references: [], candidates: [], cost: 0, at: '' };
    rec.references = (refs as string[]).map((f) => f.replace(`${ROOT}/`, ''));
    for (const c of rec.candidates) if (!c.verdict) await score(star, c);
    let round = Math.max(0, ...rec.candidates.map((c) => c.round));
    const best = () => rec.candidates.filter((c) => c.verdict && !c.verdict.error).sort((a, b) => b.verdict!.score - a.verdict!.score)[0];
    const until = fix ? round + 1 : rounds;
    while ((fix || (best()?.verdict?.score ?? 0) < PASS) && round < until) {
      round++;
      const corrections = fix ? [fix] : round > 1 ? ['her face must match reference image 1 more closely (eyes, nose, lips, face shape)'] : [];
      const prompt = kind === 'home' ? homePrompt(v, corrections) : kind === 'close' ? closePrompt(v, corrections) : home16Prompt(v, corrections);
      try {
        const r = await images({ model: process.env.OPENROUTER_IMAGE_MODEL ?? IMAGE.keyframe.model, prompt, refs: await Promise.all((refs as string[]).map(jpg)), aspect: kind === 'home16' ? '16:9' : '9:16', n, purpose: `variant keyframe ${name} r${round}`, id: name });
        rec.cost += r.cost;
        rec.prompt = prompt;
        for (const img of r.images) {
          const c: Candidate = { file: candidateName(name, rec.candidates.length), round };
          await writeFile(join(KEYFRAMES, c.file), img);
          rec.candidates.push(c);
          await score(star, c);
        }
        console.log(`✓ ${name} round ${round}: ${r.images.length} candidate(s) ($${r.cost.toFixed(3)})`);
      } catch (e) {
        if (e instanceof OutOfCredit) throw e;
        console.log(`! ${name} round ${round}: ${(e as Error).message.slice(0, 200)}`);
      }
      rec.at = new Date().toISOString();
      await saveRecord(rec);
    }
    // After a --fix round the fixed candidates win ties with the earlier ones.
    rec.pick = (fix ? rec.candidates.filter((c) => c.round === round && c.verdict && !c.verdict.error && c.verdict.score >= PASS).sort((a, b) => b.verdict!.score - a.verdict!.score)[0] : undefined)?.file ?? best()?.file;
    await saveRecord(rec);
    console.log(`→ ${name}: ${rec.pick ?? 'no candidate'} continuity ${best()?.verdict?.score ?? '—'}${(best()?.verdict?.score ?? 0) < PASS ? ' (below pass)' : ''}`);
    await sheet(star);
  }
}

/** One sheet per talent for the human check: v1 hero frames, outfit reference, rooms, then every candidate. */
async function sheet(star: Star) {
  const recs = await Promise.all([variantStill.home(star), variantStill.close(star), variantStill.home16(star)].map(loadRecord));
  const files = [v1Frame(star), v1Frame(star, '16x9'), outfitFile(star), await pickFile(variantStill.room(star)), await pickFile(variantStill.room16(star)), ...recs.flatMap((r) => r?.candidates.map((c) => join(KEYFRAMES, c.file)) ?? [])].filter((f): f is string => !!f && existsSync(f));
  const inputs = files.flatMap((f) => ['-i', f]);
  const scaled = files.map((_, i) => `[${i}:v]scale=-2:640[v${i}]`).join(';');
  await exec('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${scaled};${files.map((_, i) => `[v${i}]`).join('')}hstack=${files.length}`, '-frames:v', '1', '-q:v', '3', join(KEYFRAMES, `review-variant-${star}.jpg`)]);
}

/**
 * Clip QA beyond media:check: continuity (v1 line-up) on the first, middle and last frames that show her, the
 * seams between the clip's ends and the stills it is anchored to, and a contact sheet of six frames for the eye.
 */
async function verify(ids: string[], draft: boolean) {
  await mkdir(join(OUT, 'check'), { recursive: true });
  for (const id of ids) {
    const shot = SHOTS.find((s) => s.id === id);
    if (!shot?.star) throw new Error(`unknown shot ${id}`);
    const file = rawFile(id, draft);
    if (!existsSync(file)) { console.log(`- ${id}: no ${draft ? 'draft' : 'final'}`); continue; }
    const dir = join(OUT, 'check', `${stateKey(id, draft)}-frames`);
    await mkdir(dir, { recursive: true });
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const dur = Number(stdout.trim());
    const times = [0, 0.2, 0.4, 0.6, 0.8, 1].map((k) => Math.min(dur - 0.05, k * dur));
    const frames: string[] = [];
    for (const [i, t] of times.entries()) {
      const f = join(dir, `${i}.jpg`);
      await exec('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '2', f]);
      frames.push(f);
    }
    await exec('ffmpeg', ['-v', 'error', '-y', ...frames.flatMap((f) => ['-i', f]), '-filter_complex', `${frames.map((_, i) => `[${i}:v]scale=-2:720[v${i}]`).join(';')};${frames.map((_, i) => `[v${i}]`).join('')}hstack=${frames.length}`, '-frames:v', '1', '-q:v', '3', join(OUT, 'check', `${stateKey(id, draft)}.sheet.jpg`)]);
    const dets = await detect(frames);
    const withFace = frames.map((f, i) => ({ f, i, w: [...(dets[i]?.faces ?? [])].sort((a, b) => b.w - a.w)[0]?.w ?? 0 })).filter((x) => x.w >= 60);
    const judged = [withFace[0], withFace[Math.floor(withFace.length / 2)], withFace[withFace.length - 1]].filter((x, k, a) => x && a.indexOf(x) === k);
    const scores: { frame: number; t: number; score: number; top: boolean }[] = [];
    for (const x of judged) { const r = await continuity(shot.star, x.f, { id: `${id} t${times[x.i].toFixed(1)}` }); scores.push({ frame: x.i, t: Number(times[x.i].toFixed(2)), score: r.score, top: r.top }); }
    const t = await thumbs(file);
    const { first, last } = anchorsOf(shot);
    const seamTo = async (a: typeof first, frame: Uint8Array) => {
      if (!a || 'rendered' in a) return undefined;
      const still = await pickFile('keyframe' in a ? a.keyframe : a.still);
      if (!still) return undefined;
      const [s] = await thumbs(still);
      return mad(s, frame);
    };
    const seams = { first: await seamTo(first, t[0]), last: await seamTo(last, t[t.length - 1]) };
    const min = Math.min(...scores.map((s) => s.score));
    const problems = [
      ...(scores.length ? [] : ['no judged face']),
      ...(min < PASS ? [`continuity ${min} < ${PASS}`] : []),
      ...Object.entries(seams).filter(([, d]) => d !== undefined && d > MAX_STILL_SEAM).map(([k, d]) => `${k} frame ${d} from its still > ${MAX_STILL_SEAM}`)
    ];
    const report = { id, draft, continuity: scores, seams, ok: !problems.length, problems, at: new Date().toISOString() };
    await writeFile(join(OUT, 'check', `${stateKey(id, draft)}.continuity.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.ok ? '✓' : '✗'} ${id.padEnd(26)} continuity ${scores.map((s) => `${s.score}@${s.t}s`).join(' ')}  seams first ${seams.first ?? '—'} last ${seams.last ?? '—'}${problems.length ? `  — ${problems.join('; ')}` : ''}`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const stars = (arg('--only')?.split(',') ?? [...STARS]) as Star[];
  if (cmd !== 'verify' && cmd !== 'pick') for (const s of stars) if (!STARS.includes(s)) throw new Error(`unknown talent ${s}`);
  await mkdir(KEYFRAMES, { recursive: true });
  switch (cmd) {
    case 'rooms': return rooms(stars);
    case 'outfits': return outfits(stars);
    case 'home':
    case 'close':
    case 'home16': return stills(cmd, stars, Number(arg('--n') ?? 2), Number(arg('--rounds') ?? 2), arg('--fix'));
    case 'pick': {
      const [name, letter] = args;
      const rec = await loadRecord(name);
      const file = candidateName(name, (letter ?? '').charCodeAt(0) - 97);
      if (!rec?.candidates.some((c) => c.file === file)) throw new Error(`${name} has no candidate ${file}`);
      rec.pick = file;
      await saveRecord(rec);
      console.log(`${name}: pick ${file}`);
      return;
    }
    case 'verify': {
      const ids = arg('--only')?.split(',');
      if (!ids) throw new Error('verify needs --only <clip ids>');
      return verify(ids, args.includes('--draft'));
    }
    default: throw new Error('usage: variant-keyframes.ts rooms | outfits | home | close | home16 | pick <still> <letter> | verify --only ids [--draft]');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
