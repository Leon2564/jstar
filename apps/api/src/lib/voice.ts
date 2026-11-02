import type { FastifyInstance } from 'fastify';
import { VOICE_RULES, jstDay, voiceAllowance, voiceLeft, type StarId, type VoiceStateT } from '@jstar/shared';
import type { Repos, SceneExtension, UserRow, VoiceDayRow } from '../db/types';
import { newId } from './crypto';

/** Same shape as app.ts httpError (not imported: lib/ stays free of the app module). */
const httpError = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode });

/**
 * His voice time (#74, docs/requirements.md §13.6): a ledger of seconds per JST day (migrations/0026_voice.sql).
 * Her runtime voice (#73) and his voice input in scenes (#72) are charged here; an extension adds minutes for points.
 * Every charge carries a request id, so a retried request is charged once.
 */

/**
 * Who has a runtime voice on this server (#73): the talents with a cloned voice, when a TTS relay is configured
 * (app.ttsStars, from the Worker's TTS_STARS); empty = her runtime voice is off.
 */
export type TtsStars = readonly StarId[];
export const ttsStarsOf = (app: Pick<FastifyInstance, 'synthesize' | 'ttsStars'>): TtsStars => (app.synthesize ? app.ttsStars : []);

/**
 * Her runtime voice is for every signed-in member (VOICE_RULES.ttsRoles; owner, 2026-10-02, Fish Audio), and only with
 * a provider configured and a cloned voice of hers.
 */
export const ttsAllowed = (configured: boolean | TtsStars, role: UserRow['role']): boolean =>
  (typeof configured === 'boolean' ? configured : configured.length > 0) && VOICE_RULES.ttsRoles.includes(role);
/** The talents whose runtime voice HE hears: none unless he may (ttsAllowed). */
const heard = (stars: TtsStars, role: UserRow['role']): TtsStars => (ttsAllowed(stars, role) ? stars : []);

/** `tts`: the talents whose runtime voice he hears (none = off for him). */
export function voiceStateOf(user: Pick<UserRow, 'passUntil'>, day: VoiceDayRow, tts: TtsStars, now = Date.now()): VoiceStateT {
  const today = day.day === jstDay(now) ? day : { day: jstDay(now), usedSeconds: 0, extensions: 0 };
  return {
    day: today.day,
    leftSeconds: voiceLeft(today, user.passUntil, now),
    usedSeconds: today.usedSeconds,
    allowanceSeconds: voiceAllowance(user.passUntil, today.extensions, now),
    extensions: today.extensions,
    extensionsLeft: Math.max(0, VOICE_RULES.extendsPerDay - today.extensions),
    extendCost: VOICE_RULES.extendCostPoints,
    extendMinutes: VOICE_RULES.extendMinutes,
    tts: tts.length > 0,
    ...(tts.length ? { ttsStars: [...tts] } : {})
  };
}

/** His voice time now. `stars`: who has a runtime voice on this server (ttsStarsOf). */
export async function voiceOf(repos: Repos, user: UserRow, stars: TtsStars, now = Date.now()): Promise<VoiceStateT> {
  return voiceStateOf(user, await repos.voice.day(user.id, jstDay(now)), heard(stars, user.role), now);
}

/** Seconds are charged whole, rounded up: a 0.4 s line is a second of her voice. */
export const chargeableSeconds = (seconds: number): number => (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0);

/**
 * Charges seconds of voice to today (once per `requestId`). Nothing ever stops when they run out; what is left simply
 * reaches zero and the web app switches to subtitles.
 */
export async function chargeVoice(app: FastifyInstance, user: UserRow, c: { requestId: string; kind: 'tts' | 'input'; seconds: number }, now = Date.now()): Promise<{ recorded: boolean; voice: VoiceStateT }> {
  const seconds = chargeableSeconds(c.seconds);
  const day = jstDay(now);
  if (!seconds) return { recorded: false, voice: await voiceOf(app.repos, user, ttsStarsOf(app), now) };
  const out = await app.repos.voice.use({ userId: user.id, requestId: c.requestId, day, kind: c.kind, seconds, nonce: newId('vn'), createdAt: new Date(now).toISOString() });
  return { recorded: out.recorded, voice: voiceStateOf(user, out.day, heard(ttsStarsOf(app), user.role), now) };
}

/**
 * Her runtime voice (#73) is charged before the vendor is asked: a claim on the request id (a ledger row of 0 seconds),
 * so a request id is synthesized at most once however often it is sent. Null when the id was already used — the caller
 * refuses it rather than synthesizing again for one charge. Settle the claim with `settleVoice`.
 */
export async function claimVoice(app: FastifyInstance, user: UserRow, requestId: string, now = Date.now()): Promise<{ requestId: string; nonce: string; day: string } | null> {
  const claim = { requestId, nonce: newId('vn'), day: jstDay(now) };
  const out = await app.repos.voice.use({ userId: user.id, ...claim, kind: 'tts', seconds: 0, createdAt: new Date(now).toISOString() });
  return out.recorded ? claim : null;
}

/** Charges a claim the seconds synthesized (rounded up, as chargeVoice), or takes it back (null) when nothing was. */
export async function settleVoice(app: FastifyInstance, user: UserRow, claim: { requestId: string; nonce: string; day: string }, seconds: number | null, now = Date.now()): Promise<VoiceStateT> {
  const day = await app.repos.voice.settle(user.id, claim.requestId, claim.nonce, claim.day, seconds === null ? null : chargeableSeconds(seconds));
  return voiceStateOf(user, day, heard(ttsStarsOf(app), user.role), now);
}

/**
 * Buys an extension for today with points (#74; also アリス's date, #69). 402 `insufficient_points`, 409 `extend_limit`,
 * 409 `request_conflict`; a repeat of the same request id returns the first answer and charges nothing.
 */
export async function extendVoice(app: FastifyInstance, user: UserRow, requestId: string, now = Date.now()): Promise<{ voice: VoiceStateT; points: number; replayed: boolean }> {
  const { row, perDay } = voiceExtension(user, requestId, now);
  const out = await app.repos.voice.extend(row, perDay);
  if (!out.ok) {
    throw out.reason === 'insufficient' ? httpError('insufficient_points', 402) : httpError(out.reason === 'limit' ? 'extend_limit' : 'request_conflict', 409);
  }
  return { voice: voiceStateOf(out.user, out.day, heard(ttsStarsOf(app), out.user.role), now), points: out.user.points, replayed: out.replayed };
}

/** An extension for today at today's price, as the ledger takes it (voice.extend, or with a scene step: sceneRuns.advance). */
export const voiceExtension = (user: Pick<UserRow, 'id'>, requestId: string, now = Date.now()): SceneExtension => ({
  row: {
    userId: user.id, requestId, day: jstDay(now), kind: 'extend', seconds: VOICE_RULES.extendMinutes * 60,
    points: VOICE_RULES.extendCostPoints, nonce: newId('vn'), createdAt: new Date(now).toISOString()
  },
  perDay: VOICE_RULES.extendsPerDay
});

/**
 * Why he could not buy an extension now, as voice.extend would answer: 409 `extend_limit` or 402 `insufficient_points`
 * (null when nothing stands in the way). For a scene step, which buys it inside sceneRuns.advance.
 */
export async function extensionRefusal(repos: Repos, userId: string, now = Date.now()): Promise<Error | null> {
  const [user, day] = await Promise.all([repos.users.byId(userId), repos.voice.day(userId, jstDay(now))]);
  if (day.extensions >= VOICE_RULES.extendsPerDay) return httpError('extend_limit', 409);
  if (!user || user.points < VOICE_RULES.extendCostPoints) return httpError('insufficient_points', 402);
  return null;
}
