import { createECDH, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createPusher, herPush, httpTransport, vapidFromEnv, type PushRequest, type VapidKeys } from '../src/lib/push';
import { createSqliteClient } from './sqlite';

/** Web Push (#50): subscriptions in both stores, the routes, and delivery with cleanup of dead endpoints. */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

// Throwaway keys made per run: a real pair never lives in the repo.
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const VAPID: VapidKeys = { publicKey, privateKey, subject: 'mailto:noreply@jstarcards.ai' };

/** What a browser's PushManager hands out: a P-256 public key and a 16-byte auth secret, base64url. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const endpointOf = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

let repos: Repos;
async function newUser() {
  const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }));
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}

describe.each(BACKENDS)('push (%s store)', (_name, makeRepos) => {
  let app: FastifyInstance;
  let sent: PushRequest[];
  /** The push service's answer per endpoint; 201 unless set. */
  let answer: Record<string, number>;

  beforeEach(async () => {
    repos = makeRepos();
    sent = [];
    answer = {};
    const transport = async (r: PushRequest) => { sent.push(r); return answer[r.endpoint] ?? 201; };
    app = await buildApp({ repos, logger: false, demo: true, push: { vapid: VAPID, transport } });
  });

  it('stores subscriptions per browser, moves a browser between accounts and forgets them on deletion', async () => {
    const a = await newUser();
    const b = await newUser();
    const keys = browserKeys();
    await repos.push.subscribe({ endpoint: endpointOf('one'), userId: a.user.id, keys, tz: 'Asia/Taipei', createdAt: '2026-09-26T00:00:00.000Z' });
    await repos.push.subscribe({ endpoint: endpointOf('two'), userId: a.user.id, keys: browserKeys(), tz: null, createdAt: '2026-09-26T00:00:01.000Z' });
    expect((await repos.push.forUser(a.user.id)).map((s) => s.endpoint)).toEqual([endpointOf('one'), endpointOf('two')]);
    expect(await repos.push.forUser(a.user.id)).toContainEqual({ endpoint: endpointOf('one'), userId: a.user.id, keys, tz: 'Asia/Taipei', createdAt: '2026-09-26T00:00:00.000Z', failedAt: null });
    expect((await repos.users.byId(a.user.id))!.tz).toBe('Asia/Taipei');

    // The same browser signed in to another account: one row, now b's, and a failure mark does not carry over.
    await repos.push.setFailed(endpointOf('one'), '2026-09-26T01:00:00.000Z');
    await repos.push.subscribe({ endpoint: endpointOf('one'), userId: b.user.id, keys, tz: 'Asia/Tokyo', createdAt: '2026-09-27T00:00:00.000Z' });
    expect((await repos.push.forUser(a.user.id)).map((s) => s.endpoint)).toEqual([endpointOf('two')]);
    expect(await repos.push.forUser(b.user.id)).toEqual([expect.objectContaining({ endpoint: endpointOf('one'), failedAt: null, createdAt: '2026-09-26T00:00:00.000Z' })]);

    // Unsubscribing only touches the caller's own rows.
    expect(await repos.push.unsubscribe(a.user.id, endpointOf('one'))).toBe(0);
    expect(await repos.push.unsubscribe(b.user.id, endpointOf('one'))).toBe(1);
    await repos.push.subscribe({ endpoint: endpointOf('three'), userId: a.user.id, keys: browserKeys(), tz: null, createdAt: '2026-09-27T00:00:00.000Z' });
    expect(await repos.push.unsubscribe(a.user.id)).toBe(2);
    expect(await repos.push.forUser(a.user.id)).toEqual([]);

    await repos.push.subscribe({ endpoint: endpointOf('four'), userId: a.user.id, keys: browserKeys(), tz: null, createdAt: '2026-09-27T00:00:00.000Z' });
    await repos.users.anonymise(a.user.id, new Date().toISOString());
    expect(await repos.push.forUser(a.user.id)).toEqual([]);
    expect((await repos.users.byId(a.user.id))!.tz).toBeNull();
  });

  it('offers the public key and subscribes a signed-in browser with its time zone', async () => {
    expect(JSON.parse((await app.inject('/v1/config')).payload).vapidPublicKey).toBe(publicKey);
    const { user, h } = await newUser();
    const body = { endpoint: endpointOf('web'), keys: browserKeys(), tz: 'Asia/Taipei' };
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscribe', payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: { ...body, endpoint: 'http://evil.example/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: { ...body, keys: { p256dh: '<script>', auth: 'x' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: body })).statusCode).toBe(200);
    expect((await repos.users.byId(user.id))!.tz).toBe('Asia/Taipei');
    // An unknown zone is dropped, not stored.
    await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: { ...body, tz: 'Mars/Olympus' } });
    expect((await repos.push.forUser(user.id))[0].tz).toBeNull();

    const off = await app.inject({ method: 'DELETE', url: '/v1/push/subscribe', headers: h, payload: { endpoint: body.endpoint } });
    expect(JSON.parse(off.payload)).toEqual({ ok: true, removed: 1 });
    expect(await repos.push.forUser(user.id)).toEqual([]);
  });

  it('delivers to every browser, deletes the ones the push service reports gone (404/410) and marks other failures', async () => {
    const { user, h } = await newUser();
    for (const name of ['phone', 'laptop', 'tablet', 'old']) {
      await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: { endpoint: endpointOf(name), keys: browserKeys() } });
    }
    answer = { [endpointOf('laptop')]: 410, [endpointOf('old')]: 404, [endpointOf('tablet')]: 503 };
    const result = await app.sendPush(user.id, herPush('nana', 'ja', 'おはよう。起きてる？', { tag: 'wakeup-nana' }), { urgency: 'high', ttl: 900 });
    expect(result).toEqual({ sent: 1, removed: 2, failed: 1 });
    const left = await repos.push.forUser(user.id);
    expect(left.map((s) => s.endpoint).sort()).toEqual([endpointOf('phone'), endpointOf('tablet')]);
    expect(left.find((s) => s.endpoint === endpointOf('tablet'))!.failedAt).not.toBeNull();

    // Encrypted for the browser and signed with the VAPID key; the plain text never travels.
    const req = sent.find((r) => r.endpoint === endpointOf('phone'))!;
    expect(req.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '900', Urgency: 'high', Topic: 'wakeup-nana' });
    expect(req.headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKey}$`));
    expect(Buffer.from(req.body!).toString('utf8')).not.toContain('おはよう');

    // The service recovers: the failure mark is cleared.
    answer = {};
    expect(await app.sendPush(user.id, herPush('nana', 'ja', 'まだ寝てる？'))).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect((await repos.push.forUser(user.id)).every((s) => s.failedAt === null)).toBe(true);
  });

  it('drops a subscription whose keys cannot encrypt anything and refuses payloads that are not hers', async () => {
    const { user } = await newUser();
    await repos.push.subscribe({ endpoint: endpointOf('broken'), userId: user.id, keys: { p256dh: 'AAAA', auth: 'AAAA' }, tz: null, createdAt: new Date().toISOString() });
    expect(await app.sendPush(user.id, herPush('eimi', 'en', 'hi'))).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(sent).toHaveLength(0);
    // Off-site links and empty lines never reach a lock screen.
    await expect(app.sendPush(user.id, { title: 'x', body: 'y', url: 'https://evil.example/' })).rejects.toThrow();
    await expect(app.sendPush(user.id, { title: 'x', body: '', url: '/#/me/home' })).rejects.toThrow();
  });

  it('sends a test notification on the test site only', async () => {
    const { user, h } = await newUser();
    await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: { endpoint: endpointOf('t'), keys: browserKeys() } });
    const res = await app.inject({ method: 'POST', url: '/v1/push/test', headers: h, payload: { star: 'alice' } });
    expect(JSON.parse(res.payload)).toEqual({ sent: 1, removed: 0, failed: 0 });
    const prod = await buildApp({ repos, logger: false, demo: false, human: null, push: { vapid: VAPID, transport: async () => 201 } });
    expect((await prod.inject({ method: 'POST', url: '/v1/push/test', headers: h, payload: {} })).statusCode).toBe(404);
    expect((await repos.push.forUser(user.id))).toHaveLength(1);
  });

  it('keeps working with push off: no key offered, subscribing refused, turning off still allowed', async () => {
    const off = await buildApp({ repos, logger: false, demo: true, push: { vapid: null } });
    expect(JSON.parse((await off.inject('/v1/config')).payload).vapidPublicKey).toBeNull();
    const { user, h } = await newUser();
    const sub = await off.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h, payload: { endpoint: endpointOf('x'), keys: browserKeys() } });
    expect([sub.statusCode, JSON.parse(sub.payload).error]).toEqual([404, 'push_disabled']);
    expect((await off.inject({ method: 'DELETE', url: '/v1/push/subscribe', headers: h, payload: {} })).statusCode).toBe(200);
    expect(await off.sendPush(user.id, herPush('mahiro', 'ja', 'おやすみ'))).toEqual({ sent: 0, removed: 0, failed: 0 });
  });
});

describe('push helpers', () => {
  it('reads the keys from the environment and turns push off instead of crashing on bad ones', () => {
    const warn = vi.fn();
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:a@b.c' }, warn)).toBeNull();
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:a@b.c' }, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: 'short', VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: 'mailto:a@b.c' }, warn)).toBeNull();
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: 'not a url' }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: ` ${publicKey}\n`, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: 'mailto:a@b.c' }, warn)).toEqual({ publicKey, privateKey, subject: 'mailto:a@b.c' });
  });

  it('relays through the Worker and reads the push service status from its answer', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake = (status: number, body: unknown) => (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const req: PushRequest = { endpoint: endpointOf('r'), headers: { TTL: '60' }, body: new Uint8Array([1, 2, 3]) };
    expect(await httpTransport('http://push.internal', fake(200, { status: 410 }))(req)).toBe(410);
    expect(calls[0]).toEqual({ url: 'http://push.internal/send', body: { endpoint: endpointOf('r'), headers: { TTL: '60' }, body: 'AQID' } });
    expect(await httpTransport('http://push.internal', fake(403, { error: 'push_host_not_allowed' }))(req)).toBe(0);
    const down = (async () => { throw new Error('refused'); }) as unknown as typeof fetch;
    expect(await httpTransport('http://push.internal', down)(req)).toBe(0);
  });

  it('builds her notification: her first name, her line, a link into her room', () => {
    expect(herPush('nana', 'ja', ' おはよう ')).toEqual({ title: '奈々', body: 'おはよう', url: '/#/me/home?star=nana', star: 'nana' });
    expect(herPush('alice', 'en', 'hi', { to: 'chat', tag: 't' })).toMatchObject({ title: 'Alice', url: '/#/me/chat?star=alice', tag: 't' });
    const long = herPush('eimi', 'ja', 'あ'.repeat(300)).body;
    expect([...long]).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('sends nothing while push is off', async () => {
    const r = createMemoryRepos();
    const transport = vi.fn();
    expect(await createPusher(r, null, transport)('usr_x', herPush('mahiro', 'ja', 'x'))).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(transport).not.toHaveBeenCalled();
  });
});
