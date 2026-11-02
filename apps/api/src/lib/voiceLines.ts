import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { StarId } from '@jstar/shared';
import { env } from '../env';
import type { UserRow } from '../db/types';
import { ttsAllowed, ttsStarsOf } from './voice';

/**
 * Only her own words in her voice (#73, docs/requirements.md §13.6). The server signs every line it gives her that
 * may be spoken at runtime — her chat reply, a scene line — for the account it was given to; `POST /v1/tts` speaks
 * nothing else. A signature is bound to (account, talent, exact text): his own text, another account's line, or an
 * edited one does not verify. The key is derived from JWT_SECRET (no new secret), so a key rotation voids them too.
 */
const KEY = () => createHmac('sha256', env.JWT_SECRET).update('jstar/tts-line/v1').digest();
let key: Buffer | null = null;

function mac(userId: string, star: StarId, text: string): Buffer {
  key ??= KEY();
  return createHmac('sha256', key).update(`${userId}\n${star}\n${text}`).digest().subarray(0, 18);
}

/** The signature of her line for him (base64url, 24 characters). */
export const signLine = (userId: string, star: StarId, text: string): string => mac(userId, star, text).toString('base64url');

export function lineSigned(userId: string, star: StarId, text: string, sig: string): boolean {
  const want = mac(userId, star, text);
  const got = Buffer.from(sig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Whether her runtime voice is on for him and her: a vendor is configured, she has a voice, and his role may hear it. */
export const hearsHer = (app: FastifyInstance, user: Pick<UserRow, 'role'>, star: StarId): boolean => {
  const stars = ttsStarsOf(app);
  return ttsAllowed(stars, user.role) && stars.includes(star);
};
