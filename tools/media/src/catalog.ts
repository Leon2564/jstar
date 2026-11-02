/**
 * npm run media:catalog — build packages/shared/src/catalog.s1.json from tools/media/cards/catalog/<star>.json
 * and check it against docs/catalog-spec.md (the contract). Fails loudly instead of writing a bad catalog.
 *
 * Source files hold each talent's 30 cards in order; ids and tiers come from the position
 * (01–10 N, 11–18 R, 19–25 SR, 26–29 SSR, 30 UR), art from the id, voice once the mp3 exists.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STARS, type Star } from './manifest';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const CATALOG_SRC = resolve(import.meta.dirname, '../cards/catalog');
export const CATALOG_OUT = join(ROOT, 'packages/shared/src/catalog.s1.json');

export type Tier = 'N' | 'R' | 'SR' | 'SSR' | 'UR';
/** ja / zh-Hant / en are checked here; `ko` (owner, 2026-09-28, N-06) is carried through to the catalog as written. */
export type L3 = { ja: string; 'zh-Hant': string; en: string; ko?: string };
export type Story = { ja: string[]; 'zh-Hant': string[]; en: string[]; ko?: string[] };
export interface Card { id: string; star: Star; tier: Tier; title: L3; scene: string; line: L3; story?: Story; art: string; voice?: string }
interface SourceCard { title: L3; scene: string; line: L3; story?: Story }

export const PER_TALENT: Record<Tier, number> = { N: 10, R: 8, SR: 7, SSR: 4, UR: 1 };
export const tierOf = (n: number): Tier => (n <= 10 ? 'N' : n <= 18 ? 'R' : n <= 25 ? 'SR' : n <= 29 ? 'SSR' : 'UR');
export const cardId = (star: Star, n: number) => `s1-${star}-${String(n).padStart(2, '0')}`;

/** Words that must never appear in a scene (the image prompt) — clothed companion tone. */
export const BANNED = /\b(nude|naked|topless|lingerie|underwear|bra|panties|bikini|swimsuit|swimwear|school ?uniform|schoolgirl|see-through|sheer top|cleavage|sexy|seductive|bed ?sheets? only|towel only)\b/i;

/** Spoken length proxy: Japanese read at ~6 characters a second, pauses (……) count double. */
export const spokenSeconds = (ja: string) => (ja.replace(/[\s「」、。！？…―]/g, '').length + (ja.match(/…/g)?.length ?? 0) * 0.5 + (ja.match(/[、。！？]/g)?.length ?? 0) * 0.8) / 6;
export const storyChars = (s: string) => s.replace(/\s/g, '').length;

export function validate(cards: Card[]): string[] {
  const errors: string[] = [];
  if (cards.length !== 150) errors.push(`expected 150 cards, got ${cards.length}`);
  const ids = new Set<string>();
  const titles: Record<'ja' | 'zh-Hant' | 'en', Set<string>> = { ja: new Set(), 'zh-Hant': new Set(), en: new Set() };
  for (const star of STARS) {
    const mine = cards.filter((c) => c.star === star);
    for (const tier of Object.keys(PER_TALENT) as Tier[]) {
      const n = mine.filter((c) => c.tier === tier).length;
      if (n !== PER_TALENT[tier]) errors.push(`${star}: ${tier} ×${n}, expected ${PER_TALENT[tier]}`);
    }
  }
  for (const c of cards) {
    if (ids.has(c.id)) errors.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    if (!/^s1-(mahiro|nana|unpai|alice|eimi)-(0[1-9]|[12]\d|30)$/.test(c.id)) errors.push(`${c.id}: bad id`);
    if (c.tier !== tierOf(Number(c.id.slice(-2)))) errors.push(`${c.id}: tier ${c.tier} does not match its number`);
    if (c.art !== `/cards/${c.id}/card.webp`) errors.push(`${c.id}: art path`);
    for (const lang of ['ja', 'zh-Hant', 'en'] as const) {
      if (!c.title[lang]?.trim()) errors.push(`${c.id}: title.${lang} missing`);
      if (!c.line[lang]?.trim()) errors.push(`${c.id}: line.${lang} missing`);
      if (titles[lang].has(c.title[lang])) errors.push(`${c.id}: title.${lang} "${c.title[lang]}" not unique`);
      titles[lang].add(c.title[lang]);
    }
    if ([...c.title.ja].length > 14) errors.push(`${c.id}: title.ja longer than 14 chars`);
    if (spokenSeconds(c.line.ja) > 12) errors.push(`${c.id}: line.ja too long to say in 12 s`);
    if (!c.scene?.trim() || /[^\x00-\x7F’–—…é]/.test(c.scene)) errors.push(`${c.id}: scene must be one line of English`);
    if (BANNED.test(c.scene)) errors.push(`${c.id}: scene breaks the clothed companion tone`);
    const needsStory = c.tier === 'SSR' || c.tier === 'UR';
    if (needsStory !== !!c.story) errors.push(`${c.id}: ${needsStory ? 'SSR/UR needs a story' : 'only SSR/UR have stories'}`);
    if (c.story) {
      for (const lang of ['ja', 'zh-Hant', 'en'] as const) if (c.story[lang]?.length !== 2) errors.push(`${c.id}: story.${lang} needs 2 episodes`);
      for (const [i, ep] of (c.story.ja ?? []).entries()) {
        const n = storyChars(ep);
        if (n < 300 || n > 500) errors.push(`${c.id}: story.ja[${i}] is ${n} chars (300–500)`);
      }
    }
  }
  return errors;
}

export async function build(): Promise<Card[]> {
  const cards: Card[] = [];
  for (const star of STARS) {
    const src = JSON.parse(await readFile(join(CATALOG_SRC, `${star}.json`), 'utf8')) as { star: Star; cards: SourceCard[] };
    if (src.star !== star) throw new Error(`${star}.json: star is ${src.star}`);
    src.cards.forEach((s, i) => {
      const id = cardId(star, i + 1);
      const voice = existsSync(join(ROOT, 'apps/web/public/voice', `${id}.mp3`)) ? `/voice/${id}.mp3` : undefined;
      cards.push({ id, star, tier: tierOf(i + 1), title: s.title, scene: s.scene, line: s.line, ...(s.story ? { story: s.story } : {}), art: `/cards/${id}/card.webp`, ...(voice ? { voice } : {}) });
    });
  }
  return cards;
}

async function main() {
  const cards = await build();
  const errors = validate(cards);
  if (errors.length) { console.error(errors.map((e) => `✗ ${e}`).join('\n')); process.exit(1); }
  await writeFile(CATALOG_OUT, `${JSON.stringify(cards, null, 2)}\n`);
  console.log(`✓ ${cards.length} cards → ${CATALOG_OUT.replace(`${ROOT}/`, '')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
