import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SERIALS } from '@jstar/shared';
import { createMemoryRepos } from '../src/db/memory';
import { SEED_CARDS } from '../src/db/seed';
import { hashSerial } from '../src/lib/crypto';
import { assertProductionSafe, env, parseEnv } from '../src/env';
import { buildApp } from '../src/app';
import type { OtpMail } from '../src/lib/mail';
import { TURNSTILE_SITEKEY, apiModeVars, geoPreview, noindex, restartOnHost, stageOf, turnstileHostOk, webOrigin } from '../../../infra/cloudflare/src/stage';

// The Worker (infra/cloudflare/src/stage.ts) decides the API's mode from its STAGE var: unset = production,
// `review` = production behaviour on Nest (nest.jstarcards.ai), `test` = the demo sites. These tests boot the API with
// exactly the settings the Worker gives each stage.

const NEST = { STAGE: 'review', WEB_HOST: 'nest.jstarcards.ai', TURNSTILE_SECRET: 'turnstile-secret' };
const PROD = { TURNSTILE_SECRET: 'turnstile-secret', ADMIN_EMAILS: 'ops@example.com' };
const DEMO = { STAGE: 'test', WEB_HOST: 'v1.jstarcards.ai' };
/** Nest's own secrets are random; the development defaults would be refused in production mode. */
const SECRETS = { JWT_SECRET: 'nest-jwt-secret-0123456789', SERIAL_HMAC_KEY: 'ab'.repeat(32), AGENT_API_KEY: 'nest-agent-key', DB: 'd1' };

/** The API as the Worker starts it on that stage, with a recording mailer and a Turnstile check that accepts "ok". */
async function apiOn(stageEnv: Parameters<typeof apiModeVars>[0]) {
  const settings = parseEnv({ ...apiModeVars(stageEnv), ...SECRETS });
  const repos = createMemoryRepos({ cards: SEED_CARDS });
  const sent: OtpMail[] = [];
  const human = settings.TURNSTILE_URL ? async (token: string | undefined) => token === 'ok' : null;
  const app = await buildApp({ repos, logger: false, demo: settings.DEMO_MODE, human, mailer: async (m) => { sent.push(m); } });
  return { app, repos, sent, settings };
}

const prevSitekey = env.TURNSTILE_SITEKEY;
afterEach(() => { env.TURNSTILE_SITEKEY = prevSitekey; });

describe('the Worker stage switch (infra/cloudflare/src/stage.ts)', () => {
  it('reads STAGE: unset is production, review is Nest, test is the demo sites', () => {
    expect(stageOf({})).toBe('production');
    expect(stageOf({ STAGE: 'review' })).toBe('review');
    expect(stageOf({ STAGE: 'test' })).toBe('test');
    expect(stageOf({ STAGE: 'anything-else' })).toBe('production');
  });

  it('gives the API on review exactly the production settings, with Turnstile and the mail relay', () => {
    const review = apiModeVars(NEST);
    expect(review).toEqual(apiModeVars({ TURNSTILE_SECRET: 'turnstile-secret' }));
    expect(review).toMatchObject({ NODE_ENV: 'production', DEMO_MODE: 'false', MAIL_URL: 'http://mail.internal', TURNSTILE_URL: 'http://turnstile.internal', TURNSTILE_SITEKEY });
    // No admins on Nest unless ADMIN_EMAILS is set; production keeps its list.
    expect(review.ADMIN_EMAILS).toBe('');
    expect(apiModeVars(PROD).ADMIN_EMAILS).toBe('ops@example.com');
    // The API's own boot check accepts it (it refuses production mode without mail or with demo mode on).
    expect(() => assertProductionSafe(parseEnv({ ...review, ...SECRETS }))).not.toThrow();
    // Demo sites: fixed code, nothing mailed, no bot checks.
    expect(apiModeVars({ ...DEMO, TURNSTILE_SECRET: 'x' })).toEqual({ NODE_ENV: 'development', DEMO_MODE: 'true' });
  });

  it('serves each site on its own origin, keeps all but production out of search, and previews geo only on demo sites', () => {
    expect(webOrigin(NEST)).toBe('https://nest.jstarcards.ai');
    expect(webOrigin({})).toBe('https://jstarcards.ai');
    expect(webOrigin({ STAGE: 'test' })).toBe('https://test.jstarcards.ai');
    expect([noindex(NEST), noindex(DEMO), noindex({})]).toEqual([true, true, false]);
    expect([geoPreview(NEST), geoPreview(DEMO), geoPreview({})]).toEqual([false, true, false]);
    // The deploy script restarts the containers on the site's own host everywhere but production.
    expect([restartOnHost(NEST), restartOnHost(DEMO), restartOnHost({})]).toEqual([true, true, false]);
  });

  it('accepts a Turnstile token only from the site it was solved on: Nest takes nest tokens, production the apex and www', () => {
    expect(turnstileHostOk('nest.jstarcards.ai', NEST)).toBe(true);
    expect(turnstileHostOk('jstarcards.ai', NEST)).toBe(false);
    expect(turnstileHostOk('www.jstarcards.ai', NEST)).toBe(false);
    expect(turnstileHostOk('jstarcards.ai', {})).toBe(true);
    expect(turnstileHostOk('www.jstarcards.ai', {})).toBe(true);
    expect(turnstileHostOk('nest.jstarcards.ai', {})).toBe(false);
    expect(turnstileHostOk('evil.example.com', NEST)).toBe(false);
    // siteverify leaves the hostname out for Cloudflare's test keys; accepted as before.
    expect(turnstileHostOk(undefined, NEST)).toBe(true);
  });
});

describe('the API on the review stage (nest.jstarcards.ai)', () => {
  it('mails a real one-time code, rejects 123456 and signs in with the mailed code only', async () => {
    const { app, sent } = await apiOn(NEST);
    const post = (url: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload, headers });
    // Every sign-in mail is behind the bot check, as on production.
    expect((await post('/v1/auth/otp/start', { email: 'owner@example.com', lang: 'ja' })).statusCode).toBe(403);
    expect(sent).toHaveLength(0);
    const start = await post('/v1/auth/otp/start', { email: 'Owner@example.com', lang: 'ja' }, { 'x-turnstile-token': 'ok' });
    expect(start.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'Owner@example.com', lang: 'ja' });
    expect(sent[0].code).toMatch(/^\d{6}$/);
    // The demo code is just a wrong code here (unless the mailed one happens to be 123456; then another wrong code).
    const wrong = sent[0].code === '123456' ? '654321' : '123456';
    expect((await post('/v1/auth/otp/verify', { email: 'owner@example.com', code: wrong })).statusCode).toBe(400);
    const ok = await post('/v1/auth/otp/verify', { email: 'owner@example.com', code: sent[0].code });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload).token).toBeTruthy();
  });

  it('answers demo:false with the Turnstile site key, has no demo endpoints, codes or LINE login route', async () => {
    const { app, repos, settings } = await apiOn(NEST);
    env.TURNSTILE_SITEKEY = settings.TURNSTILE_SITEKEY;
    expect(JSON.parse((await app.inject('/v1/config')).payload)).toMatchObject({ demo: false, turnstile: TURNSTILE_SITEKEY });
    const demoOnly: [string, string][] = [
      ['POST', '/v1/inbox/demo'], ['POST', '/v1/calendar/demo'], ['POST', '/v1/relationship/demo'], ['POST', '/v1/promises/demo'],
      ['POST', '/v1/her-messages/demo'], ['PUT', '/v1/world/demo'], ['GET', '/v1/scene/previews'], ['GET', '/v1/scene/preview/x'], ['POST', '/v1/push/test']
    ];
    for (const [method, url] of demoOnly) expect([url, (await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} })).statusCode]).toEqual([url, 404]);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/line', payload: { code: 'x', state: 'y' } })).statusCode).toBe(404);
    // No demo lucky codes were seeded: they are printed in the repo.
    expect(await repos.serials.byHash(hashSerial(DEMO_SERIALS[0], SECRETS.SERIAL_HMAC_KEY))).toBeFalsy();
    const redeem = await app.inject({ method: 'POST', url: '/v1/serial/redeem', headers: { 'x-device-id': 'review-device-1' }, payload: { code: DEMO_SERIALS[0] } });
    expect(redeem.statusCode).toBe(404);
  });

  it('asks a new device for a Turnstile token before its first trial message, as production does', async () => {
    const { app } = await apiOn(NEST);
    const trial = await app.inject({ method: 'POST', url: '/v1/chat/trial', headers: { 'x-device-id': 'review-device-2' }, payload: { star: 'mahiro', text: 'hello', lang: 'en' } });
    expect(trial.statusCode).toBe(403);
    expect(JSON.parse(trial.payload).error).toBe('challenge_required');
  });

  it('the demo stage still uses the fixed code and mails nothing', async () => {
    const { app, sent } = await apiOn(DEMO);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { email: 'demo@example.com' } })).statusCode).toBe(200);
    expect(sent).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { email: 'demo@example.com', code: '123456' } })).statusCode).toBe(200);
    expect(JSON.parse((await app.inject('/v1/config')).payload)).toMatchObject({ demo: true, turnstile: null });
  });
});
