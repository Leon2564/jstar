/**
 * Her hero clip for the stage (the HD loop first, then the hero, then her night; this orientation first), and the
 * one the loading screen waits for before the home opens. Plain data, so the e2e suite reads the same choice.
 */
import { CAST } from './cast';
import { MEDIA, type MediaEntry } from './media.gen';
import { ALICE_FEEDBACK_MEDIA } from './aliceFeedbackMedia';
import { EIMI_FEEDBACK_MEDIA } from './eimiFeedbackMedia';
import { MAHIRO_FEEDBACK_MEDIA } from './mahiroFeedbackMedia';
import { NANA_FEEDBACK_MEDIA } from './nanaFeedbackMedia';
import { UNPAI_FEEDBACK_MEDIA } from './unpaiFeedbackMedia';

export function heroEntry(star: string, portrait: boolean): MediaEntry | undefined {
  if (star === 'alice') return ALICE_FEEDBACK_MEDIA['alice-idle-16x9'];
  // Eimi's approved entrance lands on this close idle frame; keep that same master on screen afterwards on both layouts.
  if (star === 'eimi') return EIMI_FEEDBACK_MEDIA['eimi-idle-16x9'];
  if (star === 'mahiro') return MAHIRO_FEEDBACK_MEDIA['mahiro-idle-16x9'];
  if (star === 'nana') return NANA_FEEDBACK_MEDIA['nana-idle-16x9'];
  if (star === 'unpai') return UNPAI_FEEDBACK_MEDIA['unpai-idle-16x9'];
  const [a, b] = portrait ? ['9x16', '16x9'] : ['16x9', '9x16'];
  return MEDIA[`${star}-herohd-${a}`] ?? MEDIA[`${star}-hero-${a}`] ?? MEDIA[`${star}-night-${a}`]
    ?? MEDIA[`${star}-herohd-${b}`] ?? MEDIA[`${star}-hero-${b}`] ?? MEDIA[`${star}-night-${b}`];
}

/** What the loading screen waits for on its way to the home: the first talent's hero clip (its poster and video). */
export const loaderEntry = (portrait: boolean): MediaEntry | undefined => heroEntry(CAST[0].id, portrait);

/** Every poster URL the loading screen may fetch for that clip (its poster and the responsive set). */
export const loaderPosters = (portrait: boolean): string[] => {
  const e = loaderEntry(portrait);
  return e ? [e.poster, ...(e.posters ?? []).map((p) => p.src)] : [];
};
