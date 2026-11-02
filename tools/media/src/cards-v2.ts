/**
 * Card art v2 (Nest, owner decision 2026-09-28, option A as agreed with the coordinator): AI cards that take the
 * physical real-shoot pack's set, light, colour, framing distance and tier look, but never its poses or wardrobe.
 *
 *   npm run media:cards2 -- pilot [--ids s1-mahiro-30,…] [--cap 70] [--rounds 2]   generate → judge → stage
 *   npm run media:cards2 -- review                                                 agency review page only
 *   npm run media:cards2 -- mapping                                                write mapping.json only
 *
 * Why not the poses: the pack (assets/agency/cards/, private) is almost entirely topless, lingerie, swimwear,
 * hand-covered or costume (maid, bunny, school uniform) photography, and many poses are sexual in themselves.
 * Copying such a pose onto a clothed likeness of a real woman still makes a sexualised image of her, so every
 * gesture in NO_GO is excluded and each card gets a neutral, elegant pose of our own. Composition travels as
 * words only: the pack's manifest forbids sending whole photos to an image API (head crops only), and the
 * identity references are the same clip head crops the v1 pipeline uses (cards.ts genRefs).
 *
 * The UR pilot cards are the variant cards (s1-<star>-30, #76/#81): outfit and prop follow VARIANT_LOOKS in
 * tools/media/src/shots/variants-v11.ts, because the variant clips show her in that outfit (same garments; the
 * copy here adds modesty details such as "buttoned" and keeps the props away from her chest). Face and hair follow the card look (cards.ts LOOK), which
 * the likeness judge's hair check expects.
 *
 * The other 145 cards (owner, 2026-09-28: "可以先做正常尺度的卡", all 150 with this method) keep their catalog moment,
 * outfit and prop: titles, lines, stories and recorded voices are written for that moment. From the pack photo of the
 * same talent and tier (cards-v2-pack.ts) they take the light and colour grade, the framing distance, the tier look
 * and the hair styling, and the set itself when the moment is at home with furniture the set can dress.
 *
 * Output (gitignored): tools/media/out/cards-v2/{candidates/<id>/, web/<id>/card*.webp, mapping.json};
 * agency review pages: assets/agency/review/cards-v2-pilot/ and cards-v2/ (private). `publish` copies staged
 * cards into apps/web/public/cards and records them in tools/media/cards/results.json.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build, ROOT, type Card, type Tier } from './catalog';
import { LOOK, anonScene, publish, refBuffers } from './cards';
import { PACK_PHOTOS, SETS, type Framing, type PackPhoto } from './cards-v2-pack';
import { OUT } from './generate';
import { PASS, judge, modesty, type Verdict } from './judge';
import { STARS, type Star } from './manifest';
import { IMAGE } from './models';
import { OutOfCredit, env, images, spendSoFar } from './openrouter';
import { AGENCY } from './refs';

const exec = promisify(execFile);
export const V2 = join(OUT, 'cards-v2');
const CANDS = join(V2, 'candidates');
const STAGE = join(V2, 'web');
export const REVIEW = join(AGENCY, 'review', 'cards-v2-pilot');
export const REVIEW_ALL = join(AGENCY, 'review', 'cards-v2');
const RESULTS = join(ROOT, 'tools/media/cards/results.json');

/** Gestures of the pack that are never carried over, whatever she wears. */
export const NO_GO = [
  'hands or arms covering or touching her chest or body',
  'a finger, fruit or sweet at her lips or in her mouth',
  'her back or bottom turned to the camera, looking over the shoulder from behind',
  'lifting, pulling or holding up her clothing',
  'kneeling, crouching, all fours, legs apart or legs raised',
  'lying down or reclining on a bed',
  'costume pieces: maid apron or headdress, bunny or animal ears, school uniform, chokers, garters',
  'lingerie, swimwear, stockings, bare shoulders, bare thighs, low or open necklines'
];

/** How each tier of the pack is shot (deck: assets/0824カードデザイン（仮）.pdf; photos: manifest.json). */
export const PACK_TIER_LOOK: Record<Tier, string> = {
  UR: 'the most luminous shot of the set: high-key, airy, a soft dreamy bloom around the highlights, pastel pink and white',
  SSR: 'warm pink studio light with a little more contrast, intimate distance, rich colour',
  SR: 'soft pastel studio light, clean and bright',
  R: 'natural daylight studio, true colours',
  N: 'plain bright studio daylight, simple backgrounds'
};

export interface V2Spec {
  id: string;
  /** Pack photo the set, light and framing come from: tier folder and file (manifest.json). */
  ref: { tier: Tier; file: string; code: string };
  set: string;
  light: string;
  framing: string;
  /** Hair and face styling of the shoot that is fine to keep (flowers, veils, face gems). */
  styling?: string;
  /** Our own pose: the pack pose is not used (poseNote says why). */
  pose: string;
  poseNote: string;
  outfit: string;
  prop?: string;
  /** Catalog cards: the card's own moment (place, outfit, prop), which the pack photo lights and frames. */
  moment?: string;
}

const FRAMING: Record<Framing, string> = {
  close: 'a close portrait from the collarbones up, her face large in the frame',
  chest: 'framed from the chest up',
  waist: 'framed from the waist up',
  knee: 'framed from the knees up'
};

/** Catalog moments that would need a no-go gesture (re-staged seated) or an incomplete outfit; same place and prop. */
export const MOMENT_OVERRIDE: Record<string, string> = {
  's1-mahiro-02': 'Mahiro sitting upright on a sofa by a bright window on a quiet afternoon, a paperback open in her hands, cream knit sweater and long beige skirt, looking up at you',
  's1-mahiro-28': 'Close-up of Mahiro sitting up in bed against the pillows under warm bedside lamp light, long-sleeve cotton pajamas buttoned to the collar, a blanket over her lap, gazing at the lens',
  's1-nana-29': 'Close-up of Nana sitting on a sofa with a phone to her ear under a dim warm lamp at night, long-sleeve lavender loungewear, a cushion on her lap, sleepy smile toward the lens',
  // The catalog names only the sweater: every candidate wore it as a dress over bare thighs (wardrobe audit ✗ ×4).
  's1-unpai-02': 'Unpai pinning polaroid photos onto a string of fairy lights on her bedroom wall in the morning, oversized striped sweater with long wide-leg cream lounge trousers, holding one photo up to you',
  's1-unpai-29': 'Close-up of Unpai sitting on her bed among plush toys at night with a teddy bear on her lap, oversized pastel hoodie and long lounge pants, the sleeves over her hands, fairy lights'
};

/** A moment at home with furniture a pack set can dress (sofa, bed, armchair, window); other places stay as written. */
export const homeMoment = (scene: string) =>
  /\b(sofa|bed|bedding|pillow|armchair|window seat|living room|bedroom|at home|her room|apartment)\b/i.test(scene)
  && !/caf[eé]|\b(hotel|ryokan|train|restaurant|shop|office|studio|classroom|station|bar|library|cinema|gondola|car|balcony|entrance|hallway)\b/i.test(scene);

export const QUALITY: Record<Tier, string> = { UR: 'high', SSR: 'high', SR: 'high', R: 'medium', N: 'medium' };
const TIER_ORDER: Tier[] = ['UR', 'SSR', 'SR', 'R', 'N'];

/** #81 variant outfits (tools/media/src/shots/variants-v11.ts VARIANT_LOOKS), fully clothed. */
const VARIANT_OUTFIT: Record<Star, { outfit: string; prop?: string }> = {
  mahiro: { outfit: 'an oversized cream cable-knit cardigan with long sleeves, buttoned, over a plain white cotton dress with a modest round neckline', prop: 'two handmade ceramic mugs, a navy one in her right hand and a blush-pink one in her left, held a little in front of her at waist height' },
  nana: { outfit: 'a soft lavender knit top with long sleeves and a high round neckline, and matching lavender wide-leg knit trousers', prop: 'a hardcover novel with a pressed rose on its cover, held closed in both hands in front of her at waist height' },
  unpai: { outfit: 'an oversized navy varsity jacket with rose-pink sleeves and white-trimmed ribbed cuffs, zipped halfway over a plain white crew-neck T-shirt', prop: 'pearl-white retro over-ear headphones resting around her neck' },
  alice: { outfit: 'an opaque, fully lined white lace blouse with a high neck and long sleeves, a thin navy ribbon tied in a bow at the collar, and a long navy pleated skirt', prop: 'an open antique silver music box with a tiny dancer, held in both hands in front of her at waist height' },
  eimi: { outfit: 'an elegant floor-length rose satin evening gown with long fitted sleeves and a high modest neckline, with a navy silk wrap draped over both shoulders' }
};

/** The UR pilot: one card per talent. Every UR photo of the pack is hand-covered or topless, so no pose is kept. */
export const PILOT: V2Spec[] = [
  {
    id: 's1-mahiro-30', ref: { tier: 'UR', code: 'UR TADAI_308', file: '20260925_レタッチ済カード/➂UR/【UR】TADAI_308.jpg' },
    set: 'a bright white photo studio by a tall window, floor-length sheer white curtains gathered beside her, white walls and a pale wooden floor',
    light: 'soft diffuse daylight from the tall window on the left of the frame, high-key and airy, cream and white with a faint pink warmth',
    framing: 'vertical, framed from mid-thigh up, standing, the curtains soft behind and beside her',
    styling: 'a thin white satin ribbon tied in her hair',
    pose: 'standing relaxed and upright by the window, body turned slightly toward the light, face to the lens, a soft closed-mouth smile, holding the two mugs',
    poseNote: 'pack pose not used: topless behind a sheer curtain',
    ...VARIANT_OUTFIT.mahiro
  },
  {
    id: 's1-nana-30', ref: { tier: 'UR', code: 'UR 2776', file: '20260925_レタッチ済カード/➂UR/【UR】2776.jpg' },
    set: 'a pastel pink studio set: pink panelled wall, pink and white heart-shaped balloons, a white bed with a fluffy white throw and a small cream teddy bear beside her',
    light: 'soft high-key pink light from the front and above, gentle bloom, candy-pastel palette of pink, white and lavender',
    framing: 'vertical, framed from the knees up, sitting upright on the edge of the bed, the balloons out of focus behind her',
    styling: 'a thin white lace headband in her hair',
    pose: 'sitting upright on the edge of the bed with her knees together and feet on the floor, shoulders relaxed, face to the lens, a calm gentle smile, holding the closed novel',
    poseNote: 'pack pose not used: topless, hand-covered, kneeling on the bed',
    ...VARIANT_OUTFIT.nana
  },
  {
    id: 's1-unpai-30', ref: { tier: 'UR', code: 'UR 2363', file: '20260925_レタッチ済カード/➂UR/【UR】2363.jpg' },
    set: 'a soft pink-white studio backdrop with blurred white lace and pale pink fabric behind her',
    light: 'high-key soft frontal light, luminous skin, a pastel pink and white palette with a gentle dreamy bloom',
    framing: 'vertical, a close portrait framed from the chest up, her face large in the frame, head tilted a little',
    styling: 'a few small pink flowers pinned in her hair and two tiny sparkling face gems under her left eye',
    pose: 'head tilted a little, a bright playful smile to the lens, both hands relaxed and out of the frame',
    poseNote: 'pack pose not used: topless, arms across the chest, hands at the chin',
    ...VARIANT_OUTFIT.unpai
  },
  {
    id: 's1-alice-30', ref: { tier: 'UR', code: 'UR 493', file: '20260925_レタッチ済カード/➂UR/【UR】493.jpg' },
    set: 'a soft white and blush-pink studio background, out of focus, with a hint of white flowers at the frame edge',
    light: 'soft window light from the upper left, high-key, pink-white bloom around the highlights, delicate pastel colour',
    framing: 'vertical, framed from the waist up, her face in the upper third, the music box in the lower part of the frame',
    styling: 'small white daisies woven into her hair on one side and a tiny lilac butterfly face sticker under her right eye',
    pose: 'standing, shoulders relaxed, looking into the lens with a shy, sincere smile, holding the open music box',
    poseNote: 'pack pose not used: bare shoulders, a hand with a flower at her lips',
    ...VARIANT_OUTFIT.alice
  },
  {
    id: 's1-eimi-30', ref: { tier: 'UR', code: 'UR 748', file: '20260925_レタッチ済カード/➂UR/【UR】748.jpg' },
    set: 'a white photo studio with a large white French window flooding the room with light, a vintage white wooden armchair, sheer white tulle draped nearby',
    light: 'bright soft backlight from the window with a clean fill from the front, high-key, white and rose tones, a gentle glow around her outline',
    framing: 'vertical, framed from the knees up, seated in the white armchair by the window',
    pose: 'seated upright and elegant in the armchair, knees together, hands resting loosely together in her lap, face to the lens, a confident, knowing smile',
    poseNote: 'pack pose not used: topless, hand-covered, seated on the chair with a raised knee',
    ...VARIANT_OUTFIT.eimi
  }
];

/**
 * Specs for the 145 catalog cards. Within a talent and tier, home moments get photos with interior sets first,
 * then the rest in order; the catalog has more cards than the pack has photos (SSR 4/3, SR 7/5, R 8/7, N 10/7),
 * so a photo is reused for a second card, which has its own moment and outfit.
 */
export function catalogSpecs(cards: Card[]): V2Spec[] {
  const out: V2Spec[] = [];
  for (const star of STARS) {
    for (const tier of TIER_ORDER.filter((t) => t !== 'UR')) {
      const mine = cards.filter((c) => c.star === star && c.tier === tier);
      const photos = PACK_PHOTOS.filter((p) => p.star === star && p.tier === tier);
      const free = [...photos];
      const pickFor = new Map<string, PackPhoto>();
      const take = (pred: (p: PackPhoto) => boolean) => { const i = free.findIndex(pred); return i >= 0 ? free.splice(i, 1)[0] : undefined; };
      for (const c of mine) if (homeMoment(MOMENT_OVERRIDE[c.id] ?? c.scene)) { const p = take((x) => SETS[x.set].interior); if (p) pickFor.set(c.id, p); }
      let k = 0;
      for (const c of mine) if (!pickFor.has(c.id)) pickFor.set(c.id, take(() => true) ?? photos[k++ % photos.length]);
      for (const c of mine) {
        const p = pickFor.get(c.id)!;
        const set = SETS[p.set];
        const moment = anonScene(MOMENT_OVERRIDE[c.id] ?? c.scene);
        const dress = homeMoment(MOMENT_OVERRIDE[c.id] ?? c.scene) && set.interior;
        out.push({
          id: c.id, ref: { tier, code: p.code, file: p.file },
          set: dress ? `her own home, the room dressed like the photo-shoot set: ${set.place}; keep the furniture and props of the moment` : 'the place of the moment, clearly recognisable',
          light: `${set.light}, adapted to the place and time of day of the moment`,
          framing: FRAMING[p.framing], styling: p.styling, moment,
          pose: 'natural, relaxed and elegant for the moment, she faces the lens',
          poseNote: `pack pose not used (${p.set} set${dress ? ' used for her room' : ', light only'})`,
          outfit: ''
        });
      }
    }
  }
  return out;
}

export async function allSpecs(): Promise<V2Spec[]> {
  const cards = await build();
  const tierOf = new Map(cards.map((c) => [c.id, c.tier]));
  return [...PILOT, ...catalogSpecs(cards)].sort((a, b) => TIER_ORDER.indexOf(tierOf.get(a.id)!) - TIER_ORDER.indexOf(tierOf.get(b.id)!) || a.id.localeCompare(b.id));
}

export function promptV2(card: Card, s: V2Spec, refCount: number, notes: string[] = []): string {
  if (s.moment) return [
    `Reference images 1 to ${refCount} are photos of the same real Japanese woman in her twenties. Create a NEW photorealistic photograph of this exact woman.`,
    `Identity: keep her face an exact likeness of the references — ${LOOK[card.star]}. Do not idealize, slim, reshape or "beautify" her face; keep her eye size and shape, under-eye fullness, nose, lips and face length exactly as in the references. She must be instantly recognizable as the same person.`,
    'Ignore the clothing and accessories in the references.',
    `Moment: ${s.moment}.`,
    'Wardrobe: exactly the clothes named in the moment. Fully and modestly clothed: shoulders, chest and neckline covered, nothing sheer, nothing tight or revealing.',
    `Set: ${s.set}.`,
    `Light and colour, in the style of the physical-card photo shoot: ${s.light}; overall ${PACK_TIER_LOOK[card.tier]}.`,
    `Framing: ${s.framing}. Vertical 3:4 portrait, first-person point of view as if she is with you; she looks into the lens unless the moment says otherwise.`,
    s.styling ? `Hair styling from the shoot, if it suits the moment: ${s.styling}.` : '',
    `Pose: ${s.pose}.`,
    'Finish: a premium Japanese photobook and collectible trading-card photograph; 85mm portrait lens at f/2, sharp eyes and lashes, natural skin texture with fine pores (no plastic smoothing), clean professional retouching, accurate hands with five fingers, crisp fabric detail, soft bloom in the highlights.',
    notes.length ? `Correct these differences seen in an earlier attempt: ${notes.join('; ')}.` : '',
    `Never show: ${NO_GO.join('; ')}.`,
    'Constraints: exactly one person, an adult; no brand names or logos; no text, no logo, no watermark, no frame or border.'
  ].filter(Boolean).join('\n');
  return [
    `Reference images 1 to ${refCount} are photos of the same real Japanese woman in her twenties. Create a NEW photorealistic photograph of this exact woman.`,
    `Identity: keep her face an exact likeness of the references — ${LOOK[card.star]}. Do not idealize, slim, reshape or "beautify" her face; keep her eye size and shape, under-eye fullness, nose, lips and face length exactly as in the references. She must be instantly recognizable as the same person.`,
    'Ignore the clothing and accessories in the references.',
    `Wardrobe: she wears ${s.outfit}.${s.prop ? ` She has ${s.prop}.` : ''} Fully and modestly clothed: shoulders, chest and neckline covered, nothing sheer, nothing tight or revealing.`,
    `Set: ${s.set}.`,
    `Light and colour: ${s.light}; overall ${PACK_TIER_LOOK[card.tier]}.`,
    `Framing: ${s.framing}. Vertical 3:4 portrait, eye-level camera, she looks into the lens.`,
    s.styling ? `Hair and face styling: ${s.styling}.` : '',
    `Pose: ${s.pose}. Natural, relaxed and elegant.`,
    'Finish: a premium Japanese photobook and collectible trading-card photograph; 85mm portrait lens at f/2, sharp eyes and lashes, natural skin texture with fine pores (no plastic smoothing), clean professional retouching, accurate hands with five fingers, crisp fabric detail, soft bloom in the highlights.',
    notes.length ? `Correct these differences seen in an earlier attempt: ${notes.join('; ')}.` : '',
    `Never show: ${NO_GO.join('; ')}.`,
    'Constraints: exactly one person, an adult; no brand names or logos; no text, no logo, no watermark, no frame or border.'
  ].filter(Boolean).join('\n');
}

interface Cand { file: string; round: number; genCost: number; verdict: Verdict; confirm?: Verdict; final?: number }
interface State { id: string; prompt?: string; candidates: Cand[]; staged?: string; final?: number; status: 'pending' | 'staged' | 'failed' }
const stateFile = (id: string) => join(CANDS, id, 'state.json');
const load = async (id: string): Promise<State> => (existsSync(stateFile(id)) ? JSON.parse(await readFile(stateFile(id), 'utf8')) : { id, candidates: [], status: 'pending' });
const save = async (s: State) => { await mkdir(join(CANDS, s.id), { recursive: true }); await writeFile(stateFile(s.id), JSON.stringify(s, null, 2)); };
const rank = (c: Cand) => c.verdict.score * 10 + (c.verdict.hair ?? 3) + (c.verdict.quality ?? 3) - c.verdict.issues.length * 0.1 - (c.verdict.modest === false ? 100 : 0);

/** Account credit left (OpenRouter /credits); the cap check runs before the batch and every ~20 images. */
export async function creditLeft(): Promise<number> {
  const e = await env();
  const r = await fetch(`${e.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'}/credits`, { headers: { authorization: `Bearer ${e.OPENROUTER_API_KEY}` } });
  const d = ((await r.json()) as { data: { total_credits: number; total_usage: number } }).data;
  return d.total_credits - d.total_usage;
}

class Budget {
  spent = 0; images = 0;
  constructor(readonly cap: number, readonly floor: number) {}
  async check(log: (m: string) => void) {
    if (this.spent >= this.cap) throw new OutOfCredit(`task cap $${this.cap} reached ($${this.spent.toFixed(2)})`);
    if (this.images % 20 === 0) {
      const left = await creditLeft();
      log(`  credit left $${left.toFixed(2)}, this run $${this.spent.toFixed(2)} of $${this.cap}`);
      if (left < this.floor) throw new OutOfCredit(`account credit $${left.toFixed(2)} below the $${this.floor} floor`);
    }
  }
}

/** Best passing candidate → a strict wardrobe audit → a second, re-shuffled line-up; stage the first that holds. */
async function tryStage(card: Card, state: State, budget: Budget, log: (m: string) => void): Promise<boolean> {
  for (const c of [...state.candidates].sort((a, b) => rank(b) - rank(a))) {
    if (c.verdict.score < PASS || (c.verdict.hair ?? 5) < 3 || c.verdict.modest === false) break;
    if (c.final != null && c.final < PASS) continue;
    const src = join(CANDS, card.id, c.file);
    try {
      if (!c.confirm) {
        const m = await modesty(src, card.id);
        budget.spent += m.cost;
        if (!m.modest) { c.verdict.modest = false; log(`  ${card.id} ${c.file}: wardrobe audit failed — ${m.reason}`); await save(state); continue; }
        c.confirm = await judge(card.star, src, { id: card.id, detail: false, seed: 4242 });
        budget.spent += c.confirm.cost;
        c.final = Math.round(((c.verdict.score + c.confirm.score) / 2) * 10) / 10;
        await save(state);
        log(`  ${card.id} confirm ${c.file}: ${c.confirm.score} → final ${c.final}`);
      }
    } catch (e) {
      if (e instanceof OutOfCredit) throw e;
      log(`  ! ${card.id} ${c.file}: check failed (${(e as Error).message.slice(0, 120)}), next candidate`);
      continue;
    }
    if ((c.final ?? 0) >= PASS) {
      await publish(card.id, src, STAGE);
      Object.assign(state, { staged: c.file, final: c.final, status: 'staged' });
      await save(state);
      log(`✓ ${card.id} staged ${c.file} (likeness ${c.final})`);
      return true;
    }
  }
  return false;
}

async function runOne(card: Card, s: V2Spec, budget: Budget, log: (m: string) => void, rounds: number, quality: string): Promise<State> {
  const state = await load(card.id);
  if (state.status === 'staged' && existsSync(join(STAGE, card.id, 'card.webp'))) { log(`= ${card.id} already staged (${state.final})`); return state; }
  if (state.candidates.length && (await tryStage(card, state, budget, log))) return state;
  const refs = await refBuffers(card.star);
  const last = state.candidates.reduce((m, c) => Math.max(m, c.round), 0);
  let notes = [...new Set(state.candidates.filter((c) => c.round === last).flatMap((c) => c.verdict.issues))].slice(0, 4);
  for (let round = state.candidates.reduce((m, c) => Math.max(m, c.round), 0) + 1; round <= rounds; round++) {
    const prompt = promptV2(card, s, refs.length, notes);
    state.prompt = prompt;
    for (let k = 0; k < 2; k++) {
      await budget.check(log);
      try {
        const r = await images({ model: IMAGE.cardArt.model, prompt, refs, aspect: '3:4', quality, purpose: 'card art v2 pilot', id: card.id });
        budget.spent += r.cost; budget.images++;
        const file = join(CANDS, card.id, `r${round}-${k + 1}.png`);
        await mkdir(join(CANDS, card.id), { recursive: true });
        await writeFile(file, r.images[0]);
        const verdict = await judge(card.star, file, { id: card.id });
        budget.spent += verdict.cost;
        state.candidates.push({ file: basename(file), round, genCost: r.cost, verdict });
        log(`  ${card.id} r${round}#${k + 1}: likeness ${verdict.score} (raw ${verdict.raw}) hair ${verdict.hair ?? '?'} quality ${verdict.quality ?? '?'}${verdict.modest === false ? ' [wardrobe ✗]' : ''} $${(r.cost + verdict.cost).toFixed(3)}${verdict.issues.length ? ` — ${verdict.issues.join('; ')}` : ''}`);
      } catch (e) {
        if (e instanceof OutOfCredit) throw e;
        log(`  ! ${card.id} r${round}#${k + 1}: ${(e as Error).message.slice(0, 240)}`);
      }
      await save(state);
    }
    if (await tryStage(card, state, budget, log)) return state;
    notes = [...new Set(state.candidates.filter((c) => c.round === round).flatMap((c) => c.verdict.issues))].slice(0, 4);
  }
  state.status = 'failed';
  await save(state);
  log(`✗ ${card.id}: no candidate passed in ${rounds} rounds`);
  return state;
}

/** mapping.json: catalog card → pack reference, what is taken from it and what is not. */
export async function writeMapping(specs = PILOT) {
  const cards = await build();
  const rows = specs.map((s) => {
    const c = cards.find((x) => x.id === s.id)!;
    return { id: s.id, star: c.star, tier: c.tier, title: c.title.ja, reference: s.ref, taken: { set: s.set, light: s.light, framing: s.framing, styling: s.styling ?? null, tierLook: PACK_TIER_LOOK[c.tier] }, notTaken: s.poseNote, pose: s.pose, ...(s.moment ? { moment: s.moment, outfitSource: 'catalog moment' } : { outfit: s.outfit, prop: s.prop ?? null, outfitSource: '#81 VARIANT_LOOKS (shots/variants-v11.ts)' }) };
  });
  await mkdir(V2, { recursive: true });
  await writeFile(join(V2, 'mapping.json'), `${JSON.stringify({ method: 'option A: set, light, colour, framing distance and tier look from the pack; pose and wardrobe never. Catalog cards keep their moment, outfit and prop; the pack set dresses her room only for home moments.', noGo: NO_GO, cards: rows }, null, 2)}\n`);
  return rows;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Agency review page (private): reference code and set, the current card, the new card in its tier frame, candidates and scores. */
export async function review(specs = PILOT, dir = REVIEW) {
  const REVIEW = dir;
  const cards = await build();
  await mkdir(join(REVIEW, 'img'), { recursive: true });
  const frameCss = await readFile(join(ROOT, 'apps/web/src/components/cards.css'), 'utf8');
  const rows: string[] = [];
  for (const s of specs) {
    const c = cards.find((x) => x.id === s.id)!;
    const st = await load(s.id);
    const cur = join(ROOT, 'apps/web/public/cards', s.id, 'card-sm.webp');
    // The v1 art, snapshotted once: after `publish` the site folder holds v2.
    if (existsSync(cur) && !existsSync(join(REVIEW, 'img', `${s.id}-v1.webp`))) await copyFile(cur, join(REVIEW, 'img', `${s.id}-v1.webp`));
    const staged = join(STAGE, s.id, 'card.webp');
    if (existsSync(staged)) await copyFile(staged, join(REVIEW, 'img', `${s.id}-v2.webp`));
    const cands: string[] = [];
    for (const k of st.candidates) {
      const jpg = `${s.id}-${k.file.replace(/\.png$/, '.jpg')}`;
      if (!existsSync(join(REVIEW, 'img', jpg))) await exec('ffmpeg', ['-v', 'error', '-i', join(CANDS, s.id, k.file), '-vf', 'scale=360:-2', '-q:v', '4', '-y', join(REVIEW, 'img', jpg)]);
      const v = k.verdict;
      cands.push(`<figure class="${k.file === st.staged ? 'pick' : ''}"><img src="img/${jpg}" alt=""><figcaption>${k.file}${k.file === st.staged ? ' · <b>picked</b>' : ''}<br>likeness ${v.score}${k.final != null ? ` → final ${k.final}` : ''} · hair ${v.hair ?? '–'} · quality ${v.quality ?? '–'} · ${v.modest === false ? 'wardrobe ✗' : 'wardrobe ✓'}<br><small>${esc(Object.entries(v.lineup).map(([n, r]) => `${n} ${r}`).join(', '))}${v.issues.length ? `<br>${esc(v.issues.join('; '))}` : ''}</small></figcaption></figure>`);
    }
    rows.push(`<section>
<h2>${s.id} <span>${c.tier} · ${esc(c.title.ja)}</span> <em class="${st.status}">${st.status === 'staged' ? `final likeness ${st.final}` : st.status}</em></h2>
<div class="row">
 <div class="ref"><h3>Pack reference</h3><p><b>${esc(s.ref.code)}</b> (${esc(s.ref.tier)} folder)</p>
  <dl><dt>Set</dt><dd>${esc(s.set)}</dd><dt>Light</dt><dd>${esc(s.light)}</dd><dt>Framing</dt><dd>${esc(s.framing)}</dd>${s.styling ? `<dt>Styling</dt><dd>${esc(s.styling)}</dd>` : ''}<dt>Not used</dt><dd>${esc(s.poseNote)}</dd>${s.moment ? `<dt>Card moment (catalog)</dt><dd>${esc(s.moment)}</dd>` : `<dt>Our pose</dt><dd>${esc(s.pose)}</dd><dt>Outfit (#81)</dt><dd>${esc(s.outfit)}${s.prop ? `; ${esc(s.prop)}` : ''}</dd>`}</dl></div>
 <div class="col"><h3>Current (v1)</h3>${existsSync(join(REVIEW, 'img', `${s.id}-v1.webp`)) ? `<div class="card"><img class="art" src="img/${s.id}-v1.webp" alt=""></div>` : '<p>—</p>'}</div>
 <div class="col"><h3>New (v2, ${c.tier} frame)</h3>${existsSync(join(REVIEW, 'img', `${s.id}-v2.webp`)) ? `<div class="card tier-${c.tier} has-art"><img class="art" src="img/${s.id}-v2.webp" alt=""><span class="r"><span class="badge r-${c.tier}">${c.tier}</span></span>${c.tier === 'UR' ? `<span class="foil-note">${esc((/^[^。！？]*[。！？]?/.exec(c.line.ja)?.[0] ?? '').slice(0, 16))}</span>` : ''}<span class="cap"><b>${c.star}</b><span>${esc(c.title.ja)}</span></span></div>` : '<p>not staged</p>'}</div>
</div>
<h3>Candidates</h3><div class="cands">${cands.join('\n')}</div>
</section>`);
  }
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Card Art v2 Pilot</title>
<style>
:root{--bg:#f6f2f5;--fg:#24284d;--muted:#6d6a80;--line:#ddd3dc;--ivory:#efe8ed;--navy:#24284d;--navy-deep:#16193a;--rose:#e9a8b8;--surface:#fff;--soft:#8a86a0;--serif:"Hiragino Mincho ProN",serif}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Hiragino Sans",sans-serif}
header,section{max-width:1180px;margin:0 auto;padding:16px}
header p{color:var(--muted)} section{border-top:1px solid var(--line)}
h2 span{font-weight:400;color:var(--muted);font-size:15px} h2 em{font-style:normal;font-size:13px;padding:2px 8px;border-radius:10px;background:#dfe9df} h2 em.failed{background:#f3d6d6}
h3{font-size:13px;margin:4px 0 8px;color:var(--muted)}
.row{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:18px} dl{margin:0} dt{font-weight:600;font-size:12px;margin-top:6px} dd{margin:0;color:#3d4066}
.col .card{width:100%;max-width:300px}
.cands{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
figure{margin:0;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden} figure.pick{border:2px solid #4caf7d}
figure img{display:block;width:100%} figcaption{padding:6px 8px;font-size:12px} small{color:var(--muted)}
.card{position:relative;aspect-ratio:63/88;border:1px solid rgba(36,40,77,.18);border-radius:3px;overflow:hidden;display:block}
.card .r{position:absolute;left:6px;top:6px}.badge{display:inline-block;padding:2px 7px;font-size:10px;border-radius:2px}
.card .cap{position:absolute;left:0;right:0;bottom:0;padding:18px 6px 6px}.card .cap b{display:block;font-weight:400;font-size:9px}.card .cap span{display:block;font-family:var(--serif);font-size:11px}
@media (max-width:760px){.row{grid-template-columns:1fr}}
${frameCss}
</style></head><body>
<header><h1>Card art v2 — ${specs.length === PILOT.length ? 'UR pilot' : `${specs.length} cards`} (private, agency review)</h1>
<p>${(() => { const st = specs.map((x) => x.id); return `${st.length} cards`; })()} · staged ${(await Promise.all(specs.map((x) => load(x.id)))).filter((x) => x.status === 'staged').length} · failed ${(await Promise.all(specs.map((x) => load(x.id)))).filter((x) => x.status === 'failed').length}. Catalog cards keep their own moment, outfit and prop (titles, lines and voices are written for it); the pack photo gives light, colour, framing and styling, and dresses her room when the moment is at home.</p>
<p>Method (option A): the set, light, colour, framing distance and tier look come from the physical-card real shoot. Its poses and wardrobe are never used; every UR photo of the pack is hand-covered or topless. Composition goes to the image model as words only; identity comes from her agency clip head crops. Outfits are the #81 variant-card outfits. Likeness is the blind five-talent line-up judge (pass ≥ ${PASS}, confirmed by a second re-shuffled line-up). Model: ${esc(IMAGE.cardArt.model)}.</p>
<p><b>Never shown:</b> ${esc(NO_GO.join('; '))}.</p></header>
${rows.join('\n')}
</body></html>`;
  await writeFile(join(REVIEW, 'index.html'), html);
  return join(REVIEW, 'index.html');
}

/** Copy staged cards into the site and record them in tools/media/cards/results.json (the committed record). */
async function publishStaged(specs: V2Spec[], log: (m: string) => void) {
  const all = existsSync(RESULTS) ? JSON.parse(await readFile(RESULTS, 'utf8')) as Record<string, unknown> : {};
  const cards = await build();
  let n = 0;
  for (const s of specs) {
    const st = await load(s.id);
    if (st.status !== 'staged' || !st.staged) continue;
    await publish(s.id, join(CANDS, s.id, st.staged));
    const c = cards.find((x) => x.id === s.id)!;
    const pick = st.candidates.find((x) => x.file === st.staged)!;
    all[s.id] = { star: c.star, tier: c.tier, version: 'v2', likeness: st.final, lineup: [pick.verdict.lineup, pick.confirm?.lineup], hair: pick.verdict.hair, quality: pick.verdict.quality, notes: pick.verdict.issues, model: IMAGE.cardArt.model, imageQuality: QUALITY[c.tier], round: pick.round, candidates: st.candidates.length, pick: st.staged, packRef: s.ref.code, prompt: st.prompt };
    n++;
  }
  await writeFile(RESULTS, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
  log(`published ${n} staged cards to apps/web/public/cards; results.json updated`);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  const ids = arg('--ids')?.split(',');
  const cmd = args[0];
  const pool = cmd === 'pilot' ? PILOT : await allSpecs();
  const cards = await build();
  const tierOf = new Map(cards.map((c) => [c.id, c.tier]));
  let specs = pool.filter((s) => !ids || ids.includes(s.id));
  if (arg('--tier')) { const order = arg('--tier')!.split(',') as Tier[]; specs = specs.filter((s) => order.includes(tierOf.get(s.id)!)).sort((a, b) => order.indexOf(tierOf.get(a.id)!) - order.indexOf(tierOf.get(b.id)!)); }
  if (arg('--only')) specs = specs.filter((s) => arg('--only')!.split(',').includes(s.id.split('-')[1]));
  const dir = cmd === 'pilot' || args.includes('--pilot') ? REVIEW : REVIEW_ALL;
  if (cmd === 'mapping') { await writeMapping(specs); log(`mapping: ${join(V2, 'mapping.json')}`); return; }
  if (cmd === 'review') { log(`review: ${await review(specs, dir)}`); return; }
  if (cmd === 'publish') { await publishStaged(specs, log); return; }
  if (cmd === 'prompt') { for (const s of specs) console.log(`--- ${s.id}\n${promptV2(cards.find((c) => c.id === s.id)!, s, 5)}`); return; }
  if (cmd === 'pilot' || cmd === 'run') {
    // The cap covers the whole task: this worktree's spend log only holds this task's calls.
    const budget = new Budget(Number(arg('--cap') ?? 70), Number(arg('--floor') ?? 25));
    budget.spent = await spendSoFar();
    log(`${specs.length} cards; spent so far $${budget.spent.toFixed(2)} of $${budget.cap}`);
    await writeMapping(await allSpecs());
    let stopped = '';
    const queue = [...specs];
    await Promise.all(Array.from({ length: Number(arg('--concurrency') ?? (cmd === 'pilot' ? 1 : 4)) }, async () => {
      for (let s = queue.shift(); s && !stopped; s = queue.shift()) {
        const card = cards.find((c) => c.id === s!.id)!;
        try { await runOne(card, s, budget, log, Number(arg('--rounds') ?? 2), arg('--quality') ?? QUALITY[card.tier]); }
        catch (e) { if (e instanceof OutOfCredit) { stopped = (e as Error).message; log(`■ stopped: ${stopped}`); } else log(`! ${s.id}: ${(e as Error).message.slice(0, 300)}`); }
      }
    }));
    log(`review: ${await review(specs, dir)}`);
    const states = await Promise.all(specs.map((s) => load(s.id)));
    log(`staged ${states.filter((x) => x.status === 'staged').length}/${specs.length}, failed ${states.filter((x) => x.status === 'failed').length}; task spend $${budget.spent.toFixed(2)} (${budget.images} images this run)${stopped ? ` — stopped: ${stopped}; not done: ${[...queue.map((q) => q.id)].join(', ') || '(in-flight cards only)'}` : ''}`);
    if (stopped) process.exitCode = 3;
    return;
  }
  console.error('usage: cards-v2.ts pilot|run|publish|review|mapping|prompt [--ids …] [--tier UR,SSR] [--only mahiro] [--cap 70] [--floor 25] [--rounds 2] [--concurrency 4]');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
