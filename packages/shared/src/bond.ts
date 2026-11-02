import type { StarId } from './domain';
import type { RelationshipStage } from './relationship';
import { BOND_RULES, VARIANT_CARDS } from './rules';
import { WORLD, type CallStage } from './world';

/**
 * What she calls him, and how she changes for him (#56, docs/requirements.md §10.3). Shared by the API, the persona
 * service's contract and the web. Pure and free of zod, like relationship.ts.
 *
 * Call names follow the relationship, but never on their own: when the relationship reaches a new call stage
 * (world.ts `callNames`: familiar, lover), she asks once — her #82 `callName` lines — and his answer is kept. Yes: she
 * calls him the new way from then on. No: she keeps the old one, and never asks about that change again.
 *
 * "She is changed by you": the memory model notes which of her looks he praises (her usual outfit, her face and smile,
 * her variant card). Only counts are kept, never his words; a look praised often shows more in her room — among the
 * clips that exist, nothing is generated for it.
 */

// ---------------------------------------------------------------- call names

/** A change she can ask about. */
export type CallChange = Exclude<CallStage, 'new'>;
const ORDER: Record<CallStage, number> = { new: 0, familiar: 1, lover: 2 };
export const isCallStage = (v: unknown): v is CallStage => typeof v === 'string' && v in ORDER;
export const isCallChange = (v: unknown): v is CallChange => v === 'familiar' || v === 'lover';

/** The call stage a relationship stage stands for: ambiguous and confession_ready keep `familiar` (world.ts). */
export const callStageOf = (stage: RelationshipStage): CallStage => (stage === 'new' ? 'new' : stage === 'lover' ? 'lover' : 'familiar');

export const CALL_ANSWERS = ['accepted', 'declined'] as const;
export type CallAnswer = (typeof CALL_ANSWERS)[number];

/** What is kept per (user, talent); mirrors the `call_names` table (migrations/0021_call_names.sql). */
export interface CallNameState {
  /** The call stage he said yes to (she uses it, capped by the relationship). */
  stage: CallStage;
  /** The highest call stage she has asked about: she never asks about it, or one below it, again. */
  asked: CallStage;
  lastAnswer: CallAnswer | null;
  answeredAt: string | null;
}

export const freshCallName = (): CallNameState => ({ stage: 'new', asked: 'new', lastAnswer: null, answeredAt: null });

/**
 * The change she asks about now, or null. When the relationship skipped a call stage she did not ask about (a demo,
 * or a stage reached while her lines were not offered), she asks only about the one it stands at.
 */
export function callAskDue(rel: RelationshipStage, s: CallNameState | null): CallChange | null {
  const to = callStageOf(rel);
  return to !== 'new' && ORDER[to] > ORDER[(s ?? freshCallName()).asked] ? to : null;
}

/** His answer to her question about `to`; null when she is not asking about it (asked before, or not reached). */
export function answerCall(rel: RelationshipStage, s: CallNameState | null, to: CallChange, accepted: boolean, at: string): CallNameState | null {
  const cur = s ?? freshCallName();
  if (callAskDue(rel, cur) !== to) return null;
  return { stage: accepted ? to : cur.stage, asked: to, lastAnswer: accepted ? 'accepted' : 'declined', answeredAt: at };
}

/** The call stage she uses now: what he said yes to, never beyond where the relationship stands (a demo can move it back). */
export function callStageNow(rel: RelationshipStage, s: CallNameState | null): CallStage {
  const accepted = (s ?? freshCallName()).stage;
  const reached = callStageOf(rel);
  return ORDER[accepted] <= ORDER[reached] ? accepted : reached;
}

/**
 * Demo mode moved the relationship back below what she already asked about: she forgets those questions, so each
 * change can be tried again. Null when nothing changes (moving forward, or to the same stage, never re-asks).
 */
export function callNameAfterDemo(rel: RelationshipStage, s: CallNameState | null): CallNameState | null {
  if (!s) return null;
  const to = callStageOf(rel);
  if (ORDER[s.asked] <= ORDER[to]) return null;
  return { ...s, asked: to, stage: callStageNow(rel, s) };
}

// ---------------------------------------------------------------- his name

/** Honorifics and endearments that already make a name a form of address: ケンちゃん never becomes ケンちゃんさん. */
const HONORIFIC = /(さん|くん|君|ちゃん|チャン|様|さま|たん|っち|氏)$/;

/**
 * Fills `{name}` in a call-name template or one of her lines (#82). The template's own さん / くん is dropped when the
 * name already ends in one.
 */
export function fillName(text: string, name: string): string {
  return text.replace(/\{name\}(さん|くん)?/g, (_m, suffix: string | undefined) => (suffix && !HONORIFIC.test(name) ? name + suffix : name));
}

/**
 * A call form with no name in it (えいみ's キミ, her name for him once they are lovers), in the other languages: her
 * pet name for him there, as her lines promise it (#171) — never "you" / 너 / 你 used as a name (round 13).
 */
const PET_NAME: Record<string, Partial<Record<string, string>>> = { キミ: { en: 'darling', ko: '자기', 'zh-Hant': '親愛的' } };

/**
 * What she calls him at a call stage: world.ts `callNames` with his name in it. The さん / くん of the forms are
 * Japanese: in another language she calls him by his name as he set it, with no Japanese around it (N-09).
 */
export const callNameOf = (star: StarId, stage: CallStage, name: string, lang: string = 'ja'): string => {
  const form = WORLD[star].callNames[stage];
  if (lang === 'ja') return fillName(form, name);
  // Her own name for him (えいみ's キミ) is her pet name in his language; else his name, no Japanese around it.
  if (!form.includes('{name}')) return PET_NAME[form]?.[lang] ?? (name || form);
  return name;
};

/**
 * `{name}`: the name he set on My page, else what he told her to call him or his name as her memory holds it. Null
 * when there is none (she then says きみ / you / 너 / 你, in her own words). Never the account's nickname: for an
 * e-mail account that is his address's handle (「qanest-r9-ja」), not a name he ever gave her (round 10).
 */
export function baseName(from: { set?: string | null; facts?: Record<string, string> | null }): string | null {
  const pick = [from.set, from.facts?.call_name, from.facts?.name].find((v) => typeof v === 'string' && v.trim());
  return pick ? pick.trim().slice(0, 40) : null;
}

/**
 * The name he sets on My page, cleaned; null when it cannot be one: empty, too long, control characters, markup, or
 * anything that looks like contact details (an address, a link, a number). The persona service's safety filter checks
 * the words themselves before a prompt uses them.
 */
export function cleanCallName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (!length || length > BOND_RULES.nameMax) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029{}<>\\]/.test(name)) return null;
  if (/@|https?:|:\/\/|www\.|\.(?:com|net|jp|io)\b|\d{3,}/i.test(name)) return null;
  return name;
}

// ---------------------------------------------------------------- her looks

/** Her own looks: her usual outfit (every clip of her room) and her face and smile (her close-up). */
export const BASE_LOOKS = ['outfit', 'face'] as const;
export type BaseLook = (typeof BASE_LOOKS)[number];
/** A base look, or the id of her variant card (#75). */
export type LookId = string;

/** Her variant card, when this card is one and is hers. */
export const isVariantLookOf = (star: StarId, id: string): boolean => VARIANT_CARDS.includes(id) && id.split('-')[1] === star;
export const isLookOf = (star: StarId, id: string): boolean => (BASE_LOOKS as readonly string[]).includes(id) || isVariantLookOf(star, id);

/**
 * Her usual outfit, as every clip of her room shows it (tools/media manifest `wearing`): what the model is told he
 * praises when he says the outfit is cute. Never new clothes: she only has what her media shows.
 */
export const USUAL_OUTFIT: Record<StarId, string> = {
  mahiro: 'an oversized cream cable-knit cardigan over a simple white cotton dress',
  nana: 'a soft lavender knit top with long sleeves and matching wide trousers',
  unpai: 'an oversized navy varsity jacket with rose-pink sleeves over a white T-shirt',
  alice: 'a white lace high-neck blouse with a small navy ribbon at the collar',
  eimi: 'a rose satin blouse with long sleeves and a high neckline, and a navy silk scarf'
};

/** The looks of hers he can praise now: the two of her own, and her variant card if he owns it. */
export function looksOf(star: StarId, owned: Iterable<string>): LookId[] {
  return [...BASE_LOOKS, ...[...new Set(owned)].filter((id) => isVariantLookOf(star, id))];
}

/**
 * How much a look weighs when her room picks one. Her usual outfit and an owned variant always count; her close-up
 * only once he has praised her face (she shows it because he likes it). Praised `BOND_RULES.praisedAt` times or more:
 * `BOND_RULES.praisedWeight` times as much.
 */
export function lookWeight(look: LookId, praised: number): number {
  const base = look === 'face' ? (praised > 0 ? 1 : 0) : 1;
  return praised >= BOND_RULES.praisedAt ? base * BOND_RULES.praisedWeight : base;
}

/** One look by weight; `r` in [0, 1). Null when nothing weighs anything. */
export function pickLook(weights: { id: LookId; weight: number }[], r: number): LookId | null {
  const total = weights.reduce((n, w) => n + Math.max(0, w.weight), 0);
  if (total <= 0) return null;
  let at = Math.min(Math.max(r, 0), 0.999999) * total;
  for (const w of weights) {
    if (w.weight <= 0) continue;
    if (at < w.weight) return w.id;
    at -= w.weight;
  }
  const last = weights.filter((w) => w.weight > 0);
  return last[last.length - 1].id;
}
