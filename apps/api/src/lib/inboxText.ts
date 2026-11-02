import {
  CALENDAR_EVENT_KINDS, LANGS, calendarLine, confessionOf, keepLineKind, localText, promiseLine, timelessPromise, type CalendarEventKind, type Lang, type LocalText, type StarId
} from '@jstar/shared';
import { promiseTextIn } from '@jstar/shared/memoryText';
import { HER_MESSAGE_KINDS, HER_MESSAGE_LINES, type HerMessageKind } from '@jstar/shared/herMessages';
import { LINES } from '@jstar/shared/lines';
import type { InboxRow, PromiseRow } from '../db/types';
import { wakeLineText } from './wakeup';

/**
 * U-29 / M18: her items are shown in his language at the time he reads them, not in the one he had when the tick
 * wrote them (he switched the app's language, or the row is older than this). The row keeps the line in every
 * language (`texts`) and `text` is the one in his. Rows made of her written lines that predate `texts` are found
 * again among her lines here (a wake-up by its line id, a calendar message by its event and id, a weather or
 * confession message or a fallback note by its words). Her own words written by the model (her messages, #58) are in
 * one language; lib/inboxLang.ts re-renders them into his on read and keeps that on the row.
 */
export const textsOf = (line: LocalText): Record<Lang, string> => Object.fromEntries(LANGS.map((l) => [l, localText(line, l)])) as Record<Lang, string>;

/** The line among `lines` that is `text` in one of its languages. */
const findLine = (lines: readonly LocalText[], text: string): LocalText | undefined =>
  lines.find((l) => LANGS.some((lang) => localText(l, lang) === text));

const isMessageKind = (v: unknown): v is HerMessageKind => typeof v === 'string' && (HER_MESSAGE_KINDS as readonly string[]).includes(v);
const isCalendarKind = (v: unknown): v is CalendarEventKind => typeof v === 'string' && (CALENDAR_EVENT_KINDS as readonly string[]).includes(v);

/** Rows written before `texts`: her line, found again from what the row says it was. */
function legacyTexts(row: Pick<InboxRow, 'id' | 'star' | 'kind' | 'payload'>): Partial<Record<Lang, string>> | null {
  const p = row.payload;
  const text = typeof p.text === 'string' ? p.text : null;
  const star: StarId = row.star;
  // Her wake-up (#57): by the id of the line she said (a line since rewritten keeps its stored words).
  if (row.kind === 'wakeup' && typeof p.lineId === 'string') {
    const all = Object.fromEntries(LANGS.map((l) => [l, wakeLineText(star, p.lineId as string, l, true)]));
    return LANGS.every((l) => all[l]) ? all as Record<Lang, string> : null;
  }
  // Her calendar message (#61): its event and its id are the line's seed (lib/calendar.ts greetingRow).
  if (isCalendarKind(p.calendar)) {
    const e = { kind: p.calendar, ...(typeof p.season === 'string' ? { season: p.season } : {}), ...(typeof p.count === 'number' ? { count: p.count } : {}) } as Parameters<typeof calendarLine>[0];
    const all = Object.fromEntries(LANGS.map((l) => [l, calendarLine(e, l, row.id)]));
    return LANGS.every((l) => all[l]) && (!text || LANGS.some((l) => all[l] === text)) ? all as Record<Lang, string> : null;
  }
  if (!text) return null;
  // Her fallback note (#58), when the model could not write one: the same line in every language.
  if (isMessageKind(p.herMessage)) {
    const sets = HER_MESSAGE_LINES[p.herMessage];
    for (const lang of LANGS) {
      const i = sets[lang].indexOf(text);
      if (i >= 0) return Object.fromEntries(LANGS.map((l) => [l, sets[l][i] ?? sets.ja[i]])) as Record<Lang, string>;
    }
    return null;
  }
  const lines = LINES[star];
  if (!lines) return null;
  const candidates: LocalText[] = [];
  // Her confession-day message (#55).
  if (typeof p.scene === 'string' && confessionOf(p.scene)) candidates.push(lines.confession.inbox, lines.confession.retry);
  // Her weather message (#63) and her variant invitation (#76).
  if (typeof p.event === 'string' && p.event in lines.weather) candidates.push(...lines.weather[p.event as keyof typeof lines.weather]);
  if (p.event === 'variant') candidates.push(...lines.variantInvite);
  const line = findLine(candidates, text);
  return line ? textsOf(line) : null;
}

/** Her item's text in every language it is known in: stored, or found again among her lines. */
export function textsIn(row: Pick<InboxRow, 'id' | 'star' | 'kind' | 'payload'>): Partial<Record<Lang, string>> | null {
  const stored = row.payload.texts;
  const kept = stored && typeof stored === 'object' ? stored as Partial<Record<Lang, string>> : null;
  if (kept && LANGS.every((l) => kept[l])) return kept;
  const found = legacyTexts(row);
  return found || kept ? { ...found, ...kept } : null;
}

/** Her item's payload as he reads it in `lang`. */
export function payloadIn(row: Pick<InboxRow, 'id' | 'star' | 'kind' | 'payload'>, lang: string): Record<string, unknown> {
  const all = textsIn(row);
  const text = all?.[lang as Lang];
  return typeof text === 'string' && text ? { ...row.payload, text, texts: all } : row.payload;
}

/**
 * Her line when a promise falls due (#59, jobs/duePromises.ts), in every language: the promise quoted in his language
 * when it is one of hers, else named by its time (promiseLine). `at`: when the line was written.
 */
export function promiseDueTexts(p: Pick<PromiseRow, 'star' | 'text' | 'dueAt' | 'madeAt'>, at: number, tz: string | null | undefined): Record<Lang, string> {
  const kind = keepLineKind(p, at);
  return Object.fromEntries(LANGS.map((l) => [l, promiseLine(kind, l, timelessPromise(promiseTextIn(p.star, p.text, l)), { star: p.star, dueAt: p.dueAt, tz })])) as Record<Lang, string>;
}
