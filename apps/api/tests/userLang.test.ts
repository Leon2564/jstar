import { describe, expect, it } from 'vitest';
import { localClock, zonedInstant } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { buildApp } from '../src/app';
import { createMemoryRepos } from '../src/db/memory';
import { SEED_CARDS } from '../src/db/seed';
import { createSqlRepos } from '../src/db/sql';
import type { Repos } from '../src/db/types';
import { JOBS } from '../src/jobs';
import type { SendPush } from '../src/lib/push';
import { runTick } from '../src/lib/tick';
import type { PushPayloadT } from '@jstar/shared';
import { createSqliteClient } from './sqlite';

/**
 * #176: what the server writes for him (her wake-up line, her messages, the day's words, the pushes) is in users.lang,
 * so the account has to speak his language: from sign-up, and whenever he switches the app's language.
 */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const json = (res: { payload: string }) => JSON.parse(res.payload);
const TAIPEI = 'Asia/Taipei';

describe.each(BACKENDS)('his language on the server (%s store)', (_name, makeRepos) => {
  async function setup() {
    const repos = makeRepos();
    const app = await buildApp({ repos, logger: false, demo: true });
    const signIn = async (email: string, lang?: string) => {
      expect((await app.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { email } })).statusCode).toBe(200);
      const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { email, code: '123456', ...(lang ? { lang } : {}) } });
      expect(res.statusCode).toBe(200);
      const s = json(res);
      return { s, h: { authorization: `Bearer ${s.token}` } };
    };
    return { repos, app, signIn };
  }

  it('a new account starts in the language he signed up in; without one, Japanese', async () => {
    const { repos, signIn } = await setup();
    const { s } = await signIn('tw@example.com', 'zh-Hant');
    expect(s.user.lang).toBe('zh-Hant');
    expect((await repos.users.byEmail('tw@example.com'))!.lang).toBe('zh-Hant');
    expect((await signIn('jp@example.com')).s.user.lang).toBe('ja');
  });

  it('signing in again from the app in another language moves the account there', async () => {
    const { repos, signIn } = await setup();
    await signIn('k@example.com', 'ja');
    expect((await signIn('k@example.com', 'ko')).s.user.lang).toBe('ko');
    expect((await repos.users.byEmail('k@example.com'))!.lang).toBe('ko');
    // A sign-in that does not say keeps what he chose.
    expect((await signIn('k@example.com')).s.user.lang).toBe('ko');
  });

  it('PUT /v1/auth/me/lang follows his switch; only his own, only a language the app has', async () => {
    const { app, signIn } = await setup();
    const { h } = await signIn('e@example.com', 'ja');
    const res = await app.inject({ method: 'PUT', url: '/v1/auth/me/lang', headers: h, payload: { lang: 'en' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).user.lang).toBe('en');
    expect(json(await app.inject({ url: '/v1/auth/me', headers: h })).user.lang).toBe('en');
    expect((await app.inject({ method: 'PUT', url: '/v1/auth/me/lang', headers: h, payload: { lang: 'fr' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/auth/me/lang', payload: { lang: 'en' } })).statusCode).toBe(401);
  });

  it('her wake-up line and its push reach a zh-Hant account in zh-Hant, and follow him when he switches', async () => {
    const { repos, app, signIn } = await setup();
    const { s, h } = await signIn('wake@example.com', 'zh-Hant');
    expect((await app.inject({ method: 'PUT', url: '/v1/alarm', headers: h, payload: { star: 'nana', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], tz: TAIPEI } })).statusCode).toBe(200);
    const pushes: PushPayloadT[] = [];
    const sendPush: SendPush = async (_u, payload) => { pushes.push(payload); return { sent: 1, removed: 0, failed: 0 }; };
    const tick = (ms: number) => runTick(repos, JOBS, { log: { info() {}, error() {} }, sendPush, clock: () => ms, demo: true });
    const day = (n: number) => localClock(Date.now() + n * 86_400_000, TAIPEI).date;
    const ring = async (n: number) => {
      await tick(zonedInstant(day(n), 7 * 60 + 30, TAIPEI) + 3_000);
      const rows = (await repos.inbox.forUser(s.user.id, 50)).filter((r) => r.kind === 'wakeup' && r.payload.day === day(n));
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    const first = await ring(3);
    const line = LINES.nana.wakeup.find((l) => l.id === first.payload.lineId)!;
    expect(first.payload.text).toBe(line.text['zh-Hant']);
    expect(pushes.at(-1)!.body).toBe(line.text['zh-Hant']);
    expect(pushes.at(-1)!.title).not.toMatch(/[぀-ヿ]/);

    await app.inject({ method: 'PUT', url: '/v1/auth/me/lang', headers: h, payload: { lang: 'en' } });
    const next = await ring(4);
    const line2 = LINES.nana.wakeup.find((l) => l.id === next.payload.lineId)!;
    expect(next.payload.text).toBe(line2.text.en);
    expect(pushes.at(-1)!.body).toBe(line2.text.en);
  });
});
