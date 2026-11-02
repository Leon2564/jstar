import type { MediaEntry } from './media.gen';

/** The one Eimi SSR whose ownership/insertion unlocks the matching special-edition video suite. */
export const EIMI_BONUS_CARD_ID = 's1-eimi-29';

export const EIMI_BONUS_REACTIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
export type EimiBonusReaction = typeof EIMI_BONUS_REACTIONS[number];

const ROOT = '/media/s1-eimi-29-bonus';
const POSTER = `${ROOT}/poster.jpg`;

function entry(id: string): MediaEntry {
  return {
    id,
    category: 'character',
    star: 'eimi',
    ratio: '16:9',
    poster: POSTER,
    sources: [{
      src: `${ROOT}/web-1080/${id}.mp4`,
      type: 'video/mp4; codecs="avc1"',
      width: 1920,
      height: 1080
    }]
  };
}

const ids = [
  `${EIMI_BONUS_CARD_ID}-bonus-enter`,
  `${EIMI_BONUS_CARD_ID}-bonus-idle`,
  ...EIMI_BONUS_REACTIONS.map((key) => `${EIMI_BONUS_CARD_ID}-bonus-react-${key}`)
] as const;

export const EIMI_BONUS_MEDIA: Record<string, MediaEntry> = Object.fromEntries(ids.map((id) => [id, entry(id)]));

export const eimiBonusEnter = (): MediaEntry => EIMI_BONUS_MEDIA[`${EIMI_BONUS_CARD_ID}-bonus-enter`];
export const eimiBonusIdle = (): MediaEntry => EIMI_BONUS_MEDIA[`${EIMI_BONUS_CARD_ID}-bonus-idle`];
export const eimiBonusReaction = (key: EimiBonusReaction): MediaEntry => EIMI_BONUS_MEDIA[`${EIMI_BONUS_CARD_ID}-bonus-react-${key}`];
export const hasEimiBonusCard = (owned: Readonly<Record<string, unknown>> | readonly string[]): boolean => {
  if (Array.isArray(owned as readonly unknown[])) return (owned as readonly string[]).includes(EIMI_BONUS_CARD_ID);
  return !!(owned as Readonly<Record<string, unknown>>)[EIMI_BONUS_CARD_ID];
};
