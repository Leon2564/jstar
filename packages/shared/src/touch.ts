/**
 * Her reaction when he touches her in her room's pure view (⑤, docs/design/room-v2/spec.md: 「咦？……怎麼了，突然碰我。」).
 * QA #5 (U-36): it used to be one of her recorded greetings (「午餐有好好吃嗎？」, 「初次見面，我是まひろ」 on day 6), with its
 * Japanese name in a zh-Hant room. These are lines for being touched, in his language, by how close they are:
 * `early` (new, familiar), `close` (ambiguous, confession_ready) and `lover`. No name in them, his or hers, except the
 * way 奈々 says her own. Drafts until native review (#84), like her other system lines; subtitle only (no recording).
 */
import type { StarId } from './domain';
import type { RelationshipStage } from './relationship';

/** The lines themselves are ./touch.json: data, so the web fetches them as an asset when he first touches her. */
export type TouchLine = { ja: string; 'zh-Hant': string; en: string; ko: string };
export type TouchStage = 'early' | 'close' | 'lover';
export type TouchLines = Record<StarId, Record<TouchStage, TouchLine[]>>;

export const touchStageOf = (stage: RelationshipStage | null | undefined): TouchStage =>
  stage === 'lover' ? 'lover' : stage === 'ambiguous' || stage === 'confession_ready' ? 'close' : 'early';

/** Her reaction to his n-th touch this visit: by how close they are, turning, never the same twice in a row. */
export function touchLine(lines: TouchLines, star: StarId, stage: RelationshipStage | null | undefined, n: number, lang: string): string {
  const set = lines[star][touchStageOf(stage)];
  const line = set[((n % set.length) + set.length) % set.length];
  return lang === 'ja' || lang === 'en' || lang === 'ko' ? line[lang] : line['zh-Hant'];
}
