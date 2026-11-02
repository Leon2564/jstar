import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { drawPickupPulls, poolCards, seeded, type AdminMetricsResT } from '@jstar/shared';
import { CATALOG } from '@jstar/shared/catalog';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { SCRIPTS } from '../src/lib/sceneTriggers';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { JOBS } from '../src/jobs';
import { runTick } from '../src/lib/tick';
import { createSqliteClient } from './sqlite';

/**
 * #52 acceptance: one user's first week, through the API only — sign up, talk with her on seven JST days, answer
 * her confession, set the alarm and open the wake-up, keep a promise and play the scene it opens, then her variant:
 * she brings it up, he draws it and opens its scene. Afterwards the admin 指標 has a number for each of the five
 * metrics, and the trigger-source mix has all three sources. Every event comes from the flow that makes it happen;
 * nothing is written to the events table directly.
 */

// The server draws with a random seed; pinning it makes the Pickup draw land on her variant (pickup.test.ts does the same).
const pin = vi.hoisted(() => ({ seed: null as number | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((...a: Parameters<typeof orig.randomInt>) => (pin.seed ?? (orig.randomInt as (...x: unknown[]) => number)(...a))) as typeof orig.randomInt;
  return { ...orig, default: { ...orig, randomInt }, randomInt };
});
// The persona service by its contract (apps/agent has its own suites). `ASK:<card>` answers as when he asks about an
// outfit he lacks (#78); anything else is a plain reply.
vi.mock('../src/lib/agent', () => {
  const answer = (input: { text: string }) => {
    const [kind, arg] = input.text.split(':');
    return { reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null, directive: kind === 'ASK' ? { outfit: arg, action: 'pickup' } : undefined };
  };
  return {
    askPersona: async (input: { text: string }) => answer(input),
    streamPersona: async function* (input: { text: string }) {
      const r = answer(input);
      yield { type: 'delta', text: r.reply };
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null, directive: r.directive };
    },
    greetPersona: async () => 'hi'
  };
});
// His answer to her confession, judged by keyword (the judge has its own suite: apps/agent/tests/test_confession.py).
vi.mock('../src/lib/confessionJudge', () => ({
  judgeConfession: async (input: { text: string }) => ({ answer: /YES/.test(input.text) ? 'accept' : 'not_yet', confident: true, source: 'agent' })
}));

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const STAR = 'mahiro';
const VARIANT = 's1-mahiro-30';
const DAY = 86_400_000;
/** Monday 2026-11-02, 20:00 JST: the evening of his first day. */
const DAY0 = Date.UTC(2026, 10, 2, 11, 0);
/** Chat XP is RULES.xpPerMessage (8): eight messages a day reach each stage's XP by the day its days are met (80 / 200 / 400 on days 2 / 4 / 7). */
const MESSAGES_A_DAY = 8;
const silent = { info() {}, error() {} };

/**
 * Her variant scene (#76) is not written yet; until it is, the week plays a stand-in: her demo evening, gated on the
 * variant card like #76's will be. Only its meta differs, and that is what the scene route reads to record the funnel.
 */
const VARIANT_SCENE = 'variant-mahiro-e2e';
function addVariantScene() {
  const base = SCRIPTS.get('demo-evening')!;
  SCRIPTS.set(VARIANT_SCENE, { ...base, meta: { ...base.meta, id: VARIANT_SCENE, trigger: { ...base.meta.trigger, variantCard: VARIANT } } });
}

let app: FastifyInstance;
let repos: Repos;
const json = (res: { payload: string }) => JSON.parse(res.payload);
const at = (ms: number) => vi.setSystemTime(ms);
const tick = () => runTick(repos, JOBS, { log: silent, demo: true });
async function call(method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: object) {
  const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBeLessThan(300);
  return json(res);
}

afterEach(() => { vi.useRealTimers(); pin.seed = null; SCRIPTS.delete(VARIANT_SCENE); });

describe.each(BACKENDS)('the five v1.1 metrics from one user\'s first week (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(DAY0);
    repos = makeRepos();
    // The demo scene (and the variant stand-in built from it) is demo-only, so the week runs in the test site's mode.
    app = await buildApp({ repos, logger: false, demo: true });
    addVariantScene();
  });

  it('sign up → 7 days of chat → confession → alarm → promise kept → scenes → variant: every metric has a number', async () => {
    // 注册: the demo sign-in code, as on the test site.
    await call('POST', '/v1/auth/otp/start', {}, { email: 'first-week@example.com', lang: 'ja' });
    const { token } = await call('POST', '/v1/auth/otp/verify', {}, { email: 'first-week@example.com', code: '123456' });
    const h = { authorization: `Bearer ${token}` };
    const { user: me } = await call('GET', '/v1/auth/me', h);
    const send = (text: string) => call('POST', '/v1/chat/send', h, { star: STAR, text });

    // 聊 7 天: he opens her room each evening and talks with her. On day 0 he also asks for her evening scene.
    for (let day = 0; day < 7; day++) {
      at(DAY0 + day * DAY);
      await call('GET', `/v1/chat/greeting?star=${STAR}`, h);
      let last: { relationship: { stage: string } } | null = null;
      for (let i = 0; i < MESSAGES_A_DAY; i++) last = await send(`day ${day}, message ${i}`);
      if (day === 0) {
        const { run } = await call('POST', '/v1/scene/start', h, { sceneId: 'demo-evening' });
        await call('POST', '/v1/scene/end', h, { runId: run.id });
      }
      // The stages move only on their days: familiar on day 2 (index 1), ambiguous on day 4, ready on day 7.
      expect(last!.relationship.stage).toBe(day < 1 ? 'new' : day < 3 ? 'familiar' : day < 6 ? 'ambiguous' : 'confession_ready');
    }

    // 告白: the seventh evening she confesses, and he says yes.
    const confession = (await call('GET', '/v1/relationship', h)).talents.find((t: { star: string }) => t.star === STAR).confession;
    expect(confession).toMatchObject({ phase: 'due', sceneId: `confession-${STAR}`, tonight: true });
    const { run } = await call('POST', '/v1/scene/start', h, { sceneId: `confession-${STAR}` });
    expect(run.waiting).toMatchObject({ id: 'answer', type: 'input' });
    const answered = (await call('POST', '/v1/scene/step', h, { runId: run.id, seq: run.seq, input: 'YES, me too' })).run;
    expect(answered.status).toBe('ended');
    expect((await call('GET', '/v1/relationship', h)).talents.find((t: { star: string }) => t.star === STAR).stage).toBe('lover');

    // 设闹钟: she wakes him at 7:30 every day. He also says yes to her proposal of an evening together tomorrow (her
    // proposals take turns by day; this one is hers whose keeping opens a scene, #71).
    await call('PUT', '/v1/alarm', h, { star: STAR, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], tz: 'Asia/Tokyo' });
    expect((await call('GET', `/v1/promises?star=${STAR}`, h)).proposal).not.toBeNull();
    const { promise } = await call('POST', '/v1/promises', h, { star: STAR, lineId: 'welcome' });
    expect(promise).toMatchObject({ kind: 'scene', status: 'open' });

    // The next morning the tick rings, and he opens her wake-up.
    at(Date.parse('2026-11-09T07:31:00+09:00'));
    await tick();
    const wake = (await call('GET', '/v1/inbox', h)).items.find((i: { kind: string }) => i.kind === 'wakeup');
    expect(wake).toBeDefined();
    await call('POST', '/v1/alarm/wake/open', h, { id: wake.id });

    // 约定兑现: the tick reaches the promise at its time, he opens her line and so keeps it, and the moment's scene
    // is offered from that line (a time event) and accepted.
    expect(Date.parse(promise.dueAt)).toBeGreaterThan(Date.now());
    at(Date.parse(promise.dueAt));
    await tick();
    const due = (await call('GET', '/v1/inbox', h)).items.find((i: { kind: string }) => i.kind === 'promise_due');
    expect(due).toBeDefined();
    expect((await call('POST', `/v1/inbox/${due.id}/read`, h)).promise).toMatchObject({ id: promise.id, status: 'kept' });
    const { offer } = await call('POST', '/v1/scene/room', h, { star: STAR, inboxId: due.id });
    expect(offer).toMatchObject({ source: 'time' });
    const kept = (await call('POST', '/v1/scene/start', h, { sceneId: offer.sceneId, offerId: offer.id })).run;
    await call('POST', '/v1/scene/end', h, { runId: kept.id });

    // 变体: a Pickup of her variant is live; he asks about the outfit, draws it with a free pull (the stages paid
    // those), and opens its scene the same day.
    const admin = await repos.users.create({ ...newUserRow({ email: 'ops@example.com', lineSub: null, nickname: 'ops', via: 'email', lang: 'ja' }), role: 'admin' });
    const ah = { authorization: `Bearer ${signJwt({ sub: admin.id }, env.JWT_SECRET, 3600)}` };
    const { pickup } = await call('PUT', '/v1/admin/pickups', ah, { cardId: VARIANT, startsAt: '2026-11-09T00:00:00+09:00', endsAt: '2026-11-16T00:00:00+09:00' });
    expect((await send(`ASK:${VARIANT}`)).pickup).toMatchObject({ poolId: pickup.id, cardId: VARIANT, via: 'ask' });
    const row = (await repos.pickups.byId(pickup.id))!;
    const pity = (await repos.users.byId(me.id))!.pity;
    let seed = 0;
    while (drawPickupPulls(1, poolCards(`star:${STAR}`, CATALOG), row, seeded(seed), pity, row.rates).drawn[0].card.id !== VARIANT) seed++;
    pin.seed = seed;
    const drawn = await call('POST', '/v1/gacha/draw', h, { pool: pickup.id, count: 1, useFreePull: true });
    pin.seed = null;
    expect(drawn.cards.map((c: { id: string }) => c.id)).toEqual([VARIANT]);
    await call('POST', '/v1/scene/start', h, { sceneId: VARIANT_SCENE });

    // The admin 指標, as the page asks for it.
    const metrics = await call('GET', '/v1/admin/metrics?grain=day&days=28', ah) as AdminMetricsResT;
    const t = metrics.total;
    const five = {
      confession: t.confessed / t.newUsers,
      alarm: t.alarmSet / t.activeUsers,
      promise: t.promisesKept / t.promisesDue,
      scenesPerEntry: t.sceneTriggers / t.roomEntries,
      variant: t.variantSceneOpened / t.variantPrompted
    };
    for (const [name, value] of Object.entries(five)) expect(value, name).toBeGreaterThan(0);
    expect(t).toMatchObject({
      newUsers: 1, confessed: 1, activeUsers: 1, alarmSet: 1, promisesDue: 1, promisesKept: 1,
      // Seven evenings; opening her room on day 8 is not needed for anything above.
      roomEntries: 7,
      // His request (day 0), her confession, the promise's moment, the variant scene.
      sceneTriggers: 4, triggerSources: { request: 2, proposed: 1, time: 1 },
      variantPrompted: 1, variantDrawn: 1, variantSceneOpened: 1,
      // He played a scene in his first week and was back on day 8.
      sceneUsers: 1, sceneRetained: 1, chatOnlyUsers: 0, chatOnlyRetained: 0
    });
    expect(five).toEqual({ confession: 1, alarm: 1, promise: 1, scenesPerEntry: 4 / 7, variant: 1 });
    // Each step of the week wrote its own event (gifts and call names are not part of this week).
    const written = ['stage.changed', 'confession.reached', 'confession.answered', 'alarm.set', 'wakeup.opened', 'promise.due', 'promise.kept', 'room.entered',
      'scene.trigger', 'scene.start', 'scene.end', 'variant.prompted', 'variant.drawn', 'variant.scene_opened'] as const;
    for (const name of written) expect((await repos.events.ofUser(me.id, name, '2026-11-01')).length, name).toBeGreaterThan(0);
    // The days add up to the whole range.
    const sum = (k: 'roomEntries' | 'sceneTriggers' | 'promisesKept') => metrics.periods.reduce((n, p) => n + p[k], 0);
    expect([sum('roomEntries'), sum('sceneTriggers'), sum('promisesKept')]).toEqual([t.roomEntries, t.sceneTriggers, t.promisesKept]);
  });
});
