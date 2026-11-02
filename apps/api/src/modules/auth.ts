import type { FastifyInstance } from 'fastify';
import { BirthdayReq, DeleteAccountReq, LangReq, NicknameReq, OtpStartReq, OtpVerifyReq, RULES, ageOn, cleanCallName } from '@jstar/shared';
import { deviceOf, httpError, requireHuman, requireUser } from '../app';
import { env } from '../env';
import { DEMO_OTP } from '../db/seed';
import { buildMe, claimDevice, defaultNickname, newUserRow, userView } from '../lib/account';
import { purgeAfterDeletion } from '../lib/memoryAssets';
import { newId, signJwt, signupBlockHash, sixDigitCode } from '../lib/crypto';
import type { UserRow } from '../db/types';
import { ttsStarsOf } from '../lib/voice';

const adminEmails = () => new Set(env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

function session(user: UserRow) {
  return {
    token: signJwt({ sub: user.id, role: user.role }, env.JWT_SECRET, env.SESSION_TTL_HOURS * 3600),
    user: userView(user)
  };
}

export async function registerAuth(app: FastifyInstance) {
  // One-time codes are rate limited per IP on top of the global limit: e-mail enumeration and
  // code brute force are the two attacks this endpoint pair has to survive.
  app.post('/otp/start', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const { email, lang } = OtpStartReq.parse(req.body);
    // Every sign-in mail costs sender reputation: bots are stopped before anything is sent.
    await requireHuman(app, req);
    // B-N5: an address closed under 18 (M7) is refused here, before a code is sent, with the same 403 /otp/verify gives:
    // no code to type for an account that cannot be made. An existing account is never blocked (a closed one has no address).
    const key = email.toLowerCase();
    if (!(await app.repos.users.byEmail(key)) && await app.repos.signupBlocks.until(signupBlockHash(key, env.JWT_SECRET), new Date().toISOString())) {
      throw httpError('signup_cooldown', 403);
    }
    const code = app.demo ? DEMO_OTP : sixDigitCode();
    await app.repos.otp.put(key, code, Date.now() + env.OTP_TTL_MINUTES * 60_000);
    // Demo keeps the fixed code on screen; otherwise it goes out by e-mail and is never logged.
    if (!app.demo) await app.mailer({ to: email, code, lang, ttlMinutes: env.OTP_TTL_MINUTES });
    req.log.info({ code: env.NODE_ENV === 'production' ? '******' : code }, 'otp_issued');
    return { ok: true, ttlMinutes: env.OTP_TTL_MINUTES };
  });

  app.post('/otp/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { email, code, lang } = OtpVerifyReq.parse(req.body);
    const key = email.toLowerCase();
    // M1: an expired code and a code spent by too many wrong tries each say so — he needs a new code, not another try.
    const taken = await app.repos.otp.take(key, code);
    if (taken !== 'ok') throw httpError(taken === 'expired' ? 'code_expired' : taken === 'attempts' ? 'code_attempts' : 'invalid_code', 400);
    let user = await app.repos.users.byEmail(key);
    if (!user) {
      // M7: an address closed under 18 is refused a new account for RULES.underageCooldownDays (only its keyed hash is kept).
      if (await app.repos.signupBlocks.until(signupBlockHash(key, env.JWT_SECRET), new Date().toISOString())) throw httpError('signup_cooldown', 403);
      // #176: the account speaks his language from the start — her wake-up, her messages, the day's words and the pushes
      // the server writes are in users.lang; signing in from the app in another language moves it there.
      user = await app.repos.users.create(newUserRow({ email: key, lineSub: null, nickname: defaultNickname(key), via: 'email', lang: lang ?? 'ja' }));
    }
    if (lang && user.lang !== lang) user = await app.repos.users.update(user.id, { lang });
    // Operators are named by address (ADMIN_EMAILS); the code they just entered proves they own it.
    if (user.role !== 'admin' && adminEmails().has(key)) user = await app.repos.users.update(user.id, { role: 'admin' });
    return session(await claimDevice(app.repos, user, deviceOf(req)));
  });

  app.get('/me', async (req) => buildMe(app.repos, requireUser(req), ttsStarsOf(app)));

  /** #176: he switched the app's language; what the server writes for him from now on follows. */
  app.put('/me/lang', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req) => {
    const user = requireUser(req);
    const { lang } = LangReq.parse(req.body);
    const next = user.lang === lang ? user : await app.repos.users.update(user.id, { lang });
    return buildMe(app.repos, next, ttsStarsOf(app));
  });

  /** M4: his nickname (My page, and the step after his birthday): the same rule as 「呼び方」 (length, no contact details). */
  app.put('/me/nickname', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req) => {
    const user = requireUser(req);
    const name = cleanCallName(NicknameReq.parse(req.body).nickname);
    if (!name) throw httpError('invalid_name', 400);
    return buildMe(app.repos, await app.repos.users.update(user.id, { nickname: name }), ttsStarsOf(app));
  });

  /**
   * Date of birth, asked once right after sign-up. Under RULES.minAge the account is closed on the spot
   * (anonymised, like a deletion) — the age gate before sign-up is a self-declaration, this is the record.
   */
  app.post('/me/birthday', async (req) => {
    const user = requireUser(req);
    const { birthday } = BirthdayReq.parse(req.body);
    if (user.birthday) throw httpError('birthday_already_set', 409);
    const age = ageOn(birthday);
    if (age === null || age > 120) throw httpError('invalid_birthday', 400);
    if (age < RULES.minAge) {
      // M7: the address may not sign up again for a while; only its keyed hash is kept, never the address.
      if (user.email) await app.repos.signupBlocks.put(signupBlockHash(user.email, env.JWT_SECRET), new Date(Date.now() + RULES.underageCooldownDays * 86_400_000).toISOString());
      await app.repos.users.anonymise(user.id, new Date().toISOString());
      await purgeAfterDeletion(app.memoryFiles, app.repos, user.id, req.log);
      throw httpError('underage', 403);
    }
    await app.repos.users.setBirthday(user.id, birthday);
    return buildMe(app.repos, (await app.repos.users.byId(user.id))!, ttsStarsOf(app));
  });

  /**
   * Account deletion (退会). E-mail, LINE id, nickname, birthday, chats, memories and her inbox are erased; the row stays,
   * anonymised and closed, so redeemed codes and draw logs remain auditable (提供割合 disputes, 景品表示法).
   */
  app.delete('/me', async (req) => {
    const user = requireUser(req);
    DeleteAccountReq.parse(req.body);
    await app.repos.users.anonymise(user.id, new Date().toISOString());
    // His memory files (#51): erased now; whatever the store did not take is retried by the tick.
    await purgeAfterDeletion(app.memoryFiles, app.repos, user.id, req.log);
    await app.repos.audit.add({ id: newId('aud'), actorId: user.id, action: 'account.delete', target: user.id, meta: {}, createdAt: new Date().toISOString() });
    return { ok: true };
  });
}
