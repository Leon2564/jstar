/**
 * Her recorded greeting lines (tools/voice/greetings.json: ja is what she says, zh-Hant / en are subtitles).
 * Loaded on the first tap, so the text stays out of the entry bundle.
 */
import greetings from '../../../../tools/voice/greetings.json';
import type { Lang } from '../i18n';

export type VoiceSlot = 'morning' | 'day' | 'evening' | 'night' | 'welcome' | 'return' | 'levelup' | 'gacha-ssr';
export type HeroInteractionZone = 'eyes' | 'lips' | 'shoulder' | 'heart';
type Line = Partial<Record<'ja' | 'zh-Hant' | 'en' | 'ko', string>>;
const G = greetings as unknown as Record<string, Partial<Record<VoiceSlot, Line>>>;

/** 5–11 morning, 11–17 day, 17–21 evening, otherwise night. */
export const clockSlot = (h: number): VoiceSlot => (h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'day' : h >= 17 && h < 21 ? 'evening' : 'night');

/**
 * What she says on the n-th tap: first the hour's line, then hello and "we got closer" in turn, so repeated taps
 * never say the same thing twice in a row and never say something out of time (no "good morning" at night).
 */
export function slotForTap(n: number, hour = new Date().getHours()): VoiceSlot {
  const order: VoiceSlot[] = [clockSlot(hour), 'welcome', 'levelup'];
  return order[n % order.length];
}

/**
 * Each of the four homepage touch points has its own response order. Keeping a counter per point makes a second
 * tap on the same area advance that area's conversation instead of borrowing the previous area's response.
 */
export function slotForZone(zone: HeroInteractionZone, n: number, hour = new Date().getHours()): VoiceSlot {
  const timed = clockSlot(hour);
  const order: Record<HeroInteractionZone, VoiceSlot[]> = {
    eyes: [timed, 'welcome', 'return', 'levelup'],
    lips: ['welcome', 'return', timed, 'levelup'],
    shoulder: ['return', 'levelup', 'welcome', timed],
    heart: ['levelup', 'welcome', 'return', timed]
  };
  return order[zone][n % order[zone].length];
}

export function lineFor(star: string, slot: VoiceSlot, lang: Lang): string {
  const l = G[star]?.[slot];
  if (!l) return '';
  return (lang === 'ja' ? l.ja : lang === 'zh-Hant' ? l['zh-Hant'] : lang === 'ko' ? l.ko ?? l.en : l.en) ?? l.ja ?? '';
}

export const voiceUrl = (star: string, slot: VoiceSlot) => `/voice/greet/${star}-${slot}.mp3`;
