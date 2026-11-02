import { RULES, chatLeft, duplicateGain, extendPass, isVariantCard, jstDay, passActive, variantState, type MeResT } from '@jstar/shared';
import type { Repos, UserRow } from '../db/types';
import { newId } from './crypto';
import { voiceOf, type TtsStars } from './voice';
import { lapseCalendar } from './inboxLang';

/** The stand-in nickname a new e-mail account starts with (the part before @), until he chooses his own (M4). */
export const defaultNickname = (email: string) => email.split('@')[0].replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12) || 'you';

/** M4: he chose his nickname — it is no longer the stand-in made from his address (shown nowhere as his name). */
export const isNamed = (user: Pick<UserRow, 'nickname' | 'email'>): boolean =>
  !!user.nickname && !(user.email && user.nickname === defaultNickname(user.email));

/** The session's view of an account (POST /otp/verify, GET /me). */
export const userView = (user: UserRow) =>
  ({ id: user.id, nickname: user.nickname, via: user.via, lang: user.lang, ageConfirmedAt: user.ageConfirmedAt, named: isNamed(user) });

export function newUserRow(fields: Pick<UserRow, 'email' | 'lineSub' | 'nickname' | 'via' | 'lang'>): Omit<UserRow, 'createdAt'> {
  return {
    id: newId('usr'), ...fields, ageConfirmedAt: new Date().toISOString(), points: RULES.welcomePoints, freePulls: RULES.signupFreePulls,
    role: 'user', banned: false, passUntil: null, chatDay: '', chatUsedToday: 0, bonusDay: null,
    pity: 0, shards: 0, loginDay: null, checkMonth: null, checkDays: 0, checkClaimed: [], birthday: null, tz: null
  };
}

/**
 * Sign-up claim (docs/requirements.md §2, §5): everything a visitor did on this device — trial messages,
 * cards drawn from lucky-card codes and the pass days that came with them — moves into the account.
 */
export async function claimDevice(repos: Repos, user: UserRow, device: string | null): Promise<UserRow> {
  if (!device) return user;
  await repos.messages.reassign(`device:${device}`, user.id);
  const claimed = await repos.lucky.claim(user, device, RULES.lucky.duplicateBondXp, (days) => (days > 0 ? extendPass(user.passUntil, days) : user.passUntil),
    (cardId) => (isVariantCard(cardId) ? duplicateGain() : null));
  if (!claimed) return user;
  await repos.audit.add({ id: newId('aud'), actorId: user.id, action: 'serial.claim', target: device, meta: { serials: claimed.serials, cards: claimed.cardIds }, createdAt: new Date().toISOString() });
  return (await repos.users.byId(user.id)) ?? user;
}

/**
 * First visit of a JST day (docs/requirements.md, free launch): login points, a monthly check-in day, check-in
 * rewards on days 7/14/21/28, and pass holders' daily points. Each step is conditional, so it pays once.
 */
async function grantDailyBonus(repos: Repos, current: UserRow): Promise<{ user: UserRow; bonus: number }> {
  const today = jstDay();
  let user = current;
  let bonus = 0;
  const logged = await repos.users.dailyLogin(user.id, today, today.slice(0, 7), RULES.dailyLoginPoints);
  if (logged) { user = logged; bonus += RULES.dailyLoginPoints; }
  const due = RULES.checkIn.filter((r) => r.day <= user.checkDays && !user.checkClaimed.includes(r.day));
  if (due.length) {
    const reward = { points: due.reduce((n, r) => n + r.points, 0), freePulls: due.reduce((n, r) => n + r.freePulls, 0) };
    const paid = await repos.users.claimCheckIn(user.id, user.checkClaimed, [...user.checkClaimed, ...due.map((r) => r.day)], reward);
    if (paid) { user = paid; bonus += reward.points; }
  }
  if (passActive(user.passUntil) && user.bonusDay !== today) {
    await repos.users.update(user.id, { bonusDay: today });
    user = (await repos.users.adjustWallet(user.id, { points: RULES.passDailyPoints })) ?? user;
    bonus += RULES.passDailyPoints;
  }
  return { user, bonus };
}

/** `ttsStars`: who has a runtime voice on this server (lib/voice.ts ttsStarsOf), for `voice.tts` (#73). */
export async function buildMe(repos: Repos, current: UserRow, ttsStars: TtsStars = []): Promise<MeResT> {
  const { user, bonus } = await grantDailyBonus(repos, current);
  // M16: her calendar messages past their day are no longer new (lib/inboxLang.ts), so they do not count here either.
  const inboxUnread = lapseCalendar(repos, user, await repos.inbox.forUser(user.id, 50)).then(() => repos.inbox.unread(user.id));
  const [owned, memories, affinity, serialsRedeemed, unread, variants, voice] = await Promise.all([
    repos.owned.forUser(user.id), repos.memories.forUser(user.id), repos.affinity.all(user.id), repos.serials.countByUser(user.id), inboxUnread,
    repos.cardAffection.forUser(user.id), voiceOf(repos, user, ttsStars)
  ]);
  const variantOf = (cardId: string) => (isVariantCard(cardId) ? { variant: variantState(variants.find((v) => v.cardId === cardId) ?? null) } : {});
  const used = user.chatDay === jstDay() ? user.chatUsedToday : 0;
  return {
    user: userView(user),
    wallet: { points: user.points, freePulls: user.freePulls, pity: user.pity, shards: user.shards },
    owned: owned.map((o) => ({ cardId: o.cardId, copies: o.copies, viaSerial: o.viaSerial, ...variantOf(o.cardId) })),
    memories: memories.map((m) => ({ id: m.id, star: m.star, title: m.title, createdAt: m.createdAt, still: m.still ?? null, sceneId: m.sceneId ?? null, kind: m.kind ?? 'chat' })),
    affinity,
    chat: { left: chatLeft(used, user.passUntil), passUntil: user.passUntil },
    serialsRedeemed,
    dailyBonus: bonus,
    checkIn: { month: user.checkMonth ?? jstDay().slice(0, 7), days: user.checkDays, claimed: user.checkClaimed },
    birthdayConfirmed: !!user.birthday,
    inboxUnread: unread,
    voiceLeft: voice.leftSeconds,
    voice
  };
}
