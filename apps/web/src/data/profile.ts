import { confirmedWorld } from '@jstar/shared/world';
import type { StarId } from './cast';

/**
 * Official profile fields. Only what the agency has confirmed is returned; an absent field is not shown
 * (never a "pending" placeholder in production). Values are per language when they need translating.
 * Birthday and hometown come from the shared world config (packages/shared/src/world.ts) through its
 * confirmation gate. Kept apart from theme.ts so the config stays out of the entry chunk (tests/e2e/perf.spec.ts).
 */
export interface Profile { birthday?: string; height?: string; from?: Partial<Record<'ja' | 'zh-Hant' | 'en' | 'ko', string>>; likes?: Partial<Record<'ja' | 'zh-Hant' | 'en' | 'ko', string>> }
/** Fields the world config does not hold yet; same rule, confirmed only. */
export const PROFILE: Partial<Record<StarId, Pick<Profile, 'height' | 'likes'>>> = {
  alice: {
    height: '155 cm',
    likes: {
      ja: 'ポーカー、ピアノ、旅行、音楽、ダンス、トレーニング',
      'zh-Hant': '撲克、鋼琴、旅行、音樂、舞蹈、健身',
      en: 'Poker, piano, travel, music, dance, fitness',
      ko: '포커, 피아노, 여행, 음악, 댄스, 운동'
    }
  }
};

export function profileOf(id: StarId): Profile {
  const w = confirmedWorld(id);
  return { ...PROFILE[id], birthday: w.birthday, from: w.hometown?.city };
}

/** Her "MM-DD" birthday as it reads in each language (3月4日 / March 4 / 3월 4일); never with a year. */
export function monthDayLabel(md: string, lang: string): string {
  const [m, d] = md.split('-').map(Number);
  return new Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m - 1, d)));
}
