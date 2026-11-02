import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VARIANT_RULES, variantGain } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { metBefore } from './met';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { deliverInbox } from '../src/jobs/deliverInbox';
import { INVITE_LINE, variantInviteId, variantInvitesJob } from '../src/jobs/variantInvites';
import { createSqliteClient } from './sqlite';

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const EIMI = 's1-eimi-30';
const NANA = 's1-nana-30';
const silent = { info() {}, error() {} };
const D = '2026-10-05';
const jst = (day: string, h: number, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const NEXT = '2026-10-06';

let app: FastifyInstance;
let repos: Repos;
const clock = (ms: number) => vi.setSystemTime(ms);
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
const put = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'PUT', url, headers, payload });
const get = (url: string, headers: Record<string, string>) => app.inject({ url, headers });

async function member(lang: 'ja' | 'en' = 'ja') {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang }) });
  await metBefore(repos, user.id);
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 30 * 86_400)}` } };
}
/** One tick of the invite job at `ms`, in demo mode unless told otherwise. */
const invite = (ms: number, demo = true) => {
  clock(ms);
  return variantInvitesJob().run({ repos, now: new Date(ms), signal: new AbortController().signal, log: silent, demo });
};
const deliver = (ms: number) => { clock(ms); return deliverInbox.run({ repos, now: new Date(ms), signal: new AbortController().signal, log: silent }); };
const invitesOf = async (userId: string) => (await repos.inbox.withPrefix('vi_', '')).filter((r) => r.userId === userId);
const opened = async (userId: string) => (await repos.events.ofUser(userId, 'variant.scene_opened', '2026-01-01')).map((e) => e.props);

describe.each(BACKENDS)('the variant-card experience (#76, %s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: jst(D, 10) });
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  describe('the draw-night invite', () => {
    it('comes that evening, once: not before, not again the next night, not for a duplicate', async () => {
      const { user } = await member();
      clock(jst(D, 10));
      expect(await repos.owned.grant(user.id, EIMI, false)).toBe(true);

      // Drawn in the morning: nothing until the evening.
      expect(await invite(jst(D, 12))).toEqual({ night: D, open: false });
      expect(await invitesOf(user.id)).toEqual([]);

      expect(await invite(jst(D, VARIANT_RULES.invite.fromHour, 1))).toMatchObject({ night: D, sent: 1 });
      const [row] = await invitesOf(user.id);
      expect(row).toMatchObject({
        id: variantInviteId(user.id, EIMI), star: 'eimi', kind: 'event',
        payload: { text: LINES.eimi.variantInvite[INVITE_LINE].ja, event: 'variant', cardId: EIMI, sceneId: 'variant-eimi-1' }
      });

      // Later ticks the same night, the next night, and a duplicate the next day: nothing more.
      expect(await invite(jst(D, 21))).toMatchObject({ sent: 0 });
      expect(await invite(jst(NEXT, 1))).toMatchObject({ sent: 0 });
      clock(jst(NEXT, 12));
      expect(await repos.owned.grant(user.id, EIMI, false)).toBe(false);
      expect(await invite(jst(NEXT, 19))).toMatchObject({ night: NEXT, candidates: 0, sent: 0 });
      expect(await invitesOf(user.id)).toHaveLength(1);
    });

    it('a card that came late at night is invited at once, in his language; every variant card has its own', async () => {
      const { user } = await member('en');
      clock(jst(D, 20));
      await repos.owned.grant(user.id, EIMI, false);
      clock(jst(NEXT, 1, 30));
      await repos.owned.grant(user.id, NANA, false);
      expect(await invite(jst(NEXT, 1, 35))).toMatchObject({ night: D, sent: 2 });
      const rows = await invitesOf(user.id);
      expect(rows.map((r) => r.star).sort()).toEqual(['eimi', 'nana']);
      expect(rows.find((r) => r.star === 'nana')!.payload.text).toBe(LINES.nana.variantInvite[INVITE_LINE].en);
      // Not the next evening: that was the night they came.
      expect(await invite(jst(NEXT, 19))).toMatchObject({ candidates: 0, sent: 0 });
    });

    it('a night with more new owners than one tick takes reaches every one of them, once each', async () => {
      // A banned owner and a deleted one first in line: they are never candidates, so they cannot hold up the rest.
      const banned = await member();
      const gone = await member();
      clock(jst(D, 19));
      await repos.owned.grant(banned.user.id, EIMI, false);
      await repos.owned.grant(gone.user.id, NANA, false);
      await repos.users.update(banned.user.id, { banned: true });
      await repos.users.anonymise(gone.user.id, new Date().toISOString());
      const owners: string[] = [];
      for (let i = 0; i < 7; i++) {
        const { user } = await member();
        clock(jst(D, 19, 1 + i));
        await repos.owned.grant(user.id, i % 2 ? NANA : EIMI, false);
        owners.push(user.id);
      }
      // Three per tick: each tick moves on to the owners not yet invited, rather than re-reading the first three.
      const one = (ms: number) => { clock(ms); return variantInvitesJob(LINES, 3).run({ repos, now: new Date(ms), signal: new AbortController().signal, log: silent, demo: true }); };
      expect(await one(jst(D, 19, 10))).toMatchObject({ candidates: 3, sent: 3 });
      expect(await one(jst(D, 19, 15))).toMatchObject({ candidates: 3, sent: 3 });
      expect(await one(jst(D, 19, 20))).toMatchObject({ candidates: 1, sent: 1 });
      expect(await one(jst(D, 19, 25))).toMatchObject({ candidates: 0, sent: 0 });
      for (const id of owners) expect(await invitesOf(id)).toHaveLength(1);
      expect([...await invitesOf(banned.user.id), ...await invitesOf(gone.user.id)]).toEqual([]);
    });

    it('is sent in production too, her reveal being playable there (#81\'s clips made), but never to a deleted account', async () => {
      // The publish rule (owner, 2026-09-28): her lines are reviewed and every clip of the reveal exists.
      const { user } = await member();
      const gone = await member();
      await repos.owned.grant(user.id, EIMI, false);
      await repos.owned.grant(gone.user.id, NANA, false);
      await repos.users.anonymise(gone.user.id, new Date().toISOString());
      expect(await invite(jst(D, 19), false)).toMatchObject({ night: D, sent: 1 });
      expect(await invitesOf(user.id)).toHaveLength(1);
      expect(await invitesOf(gone.user.id)).toEqual([]);
    });

    it('opening it offers her reveal, and entering it is written as the variant scene opened (layer 1)', async () => {
      const { user, h } = await member();
      await repos.owned.grant(user.id, EIMI, false);
      await invite(jst(D, 19));
      await deliver(jst(D, 19, 1));
      clock(jst(D, 19, 5));
      const [item] = json(await get('/v1/inbox', h)).items;
      expect(item.payload.sceneId).toBe('variant-eimi-1');
      const { offer } = json(await post('/v1/scene/room', { star: 'eimi', inboxId: item.id }, h));
      expect(offer).toMatchObject({ sceneId: 'variant-eimi-1', source: 'time', star: 'eimi' });
      // #81's clips as written: her home loop in the variant, the empty room, entering in it, close in it.
      expect(offer.media).toEqual(['eimi-variant-home', 'eimi-night', 'eimi-variant-enter', 'eimi-variant-close']);
      const res = await post('/v1/scene/start', { sceneId: 'variant-eimi-1', offerId: offer.id }, h);
      expect(res.statusCode).toBe(200);
      expect(await opened(user.id)).toEqual([{ star: 'eimi', cardId: EIMI, layer: 1 }]);
    });
  });

  describe('her four layers', () => {
    it('open by the variant card\'s own level, 1 / 3 / 6 / 10, and each entry is written with its layer', async () => {
      const { user, h } = await member();
      clock(jst(D, 20));
      await repos.owned.grant(user.id, EIMI, false);
      const start = async (layer: number) => (await post('/v1/scene/start', { sceneId: `variant-eimi-${layer}` }, h)).statusCode;

      expect([await start(1), await start(3), await start(6), await start(10)]).toEqual([200, 403, 403, 403]);
      await repos.cardAffection.add(user.id, EIMI, 'eimi', variantGain(100));
      expect([await start(3), await start(6)]).toEqual([200, 403]);
      await repos.cardAffection.add(user.id, EIMI, 'eimi', variantGain(300));
      expect([await start(6), await start(10)]).toEqual([200, 403]);
      await repos.cardAffection.add(user.id, EIMI, 'eimi', variantGain(600));
      expect(await start(10)).toBe(200);
      expect((await opened(user.id)).map((p) => p.layer)).toEqual([1, 3, 6, 10]);
      // Without her card, not even the reveal; another talent's card opens nothing of hers.
      const other = await member();
      await repos.owned.grant(other.user.id, NANA, false);
      expect((await post('/v1/scene/start', { sceneId: 'variant-eimi-1' }, other.h)).statusCode).toBe(403);
    });

    it('a finished layer pays its variant XP to the card', async () => {
      const { user, h } = await member();
      clock(jst(D, 20));
      await repos.owned.grant(user.id, EIMI, false);
      let run = json(await post('/v1/scene/start', { sceneId: 'variant-eimi-1' }, h)).run;
      while (run.status === 'active') {
        const w = run.waiting;
        const body = w.type === 'choice' ? { choice: w.options[0].id } : { timeout: true };
        clock(Date.now() + 60_000);
        run = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, ...body }, h)).run;
      }
      expect(run.rewards.variantXp).toBe(VARIANT_RULES.sceneEndXp);
      expect(await repos.cardAffection.get(user.id, EIMI)).toMatchObject({ xp: VARIANT_RULES.sceneEndXp, level: 1 });
    });

    it('play in production too now that #81\'s clips exist; the owner\'s preview stays on the test site', async () => {
      const { user, h } = await member();
      clock(jst(D, 20));
      await repos.owned.grant(user.id, EIMI, false);
      const prod = await buildApp({ repos, logger: false, demo: false });
      // The same conditions as anywhere: the reveal opens with the card, layer 3 waits for its level.
      expect((await prod.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'variant-eimi-3' } })).statusCode).toBe(403);
      const started = await prod.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'variant-eimi-1' } });
      expect(started.statusCode).toBe(200);
      expect(await opened(user.id)).toEqual([{ star: 'eimi', cardId: EIMI, layer: 1 }]);
      // The owner's preview (the test site only) plays any layer, and is not counted as him opening it.
      expect(json(await get('/v1/scene/previews', h)).scenes.map((x: { id: string }) => x.id)).toContain('variant-eimi-10');
      expect((await post('/v1/scene/start', { sceneId: 'variant-eimi-10', preview: true }, h)).statusCode).toBe(200);
      expect(await opened(user.id)).toHaveLength(1);
      expect((await prod.inject({ method: 'GET', url: '/v1/scene/preview/variant-eimi-1', headers: h })).statusCode).toBe(404);
    });
  });

  describe('her home look', () => {
    it('may be pinned from level 10 only, for a variant card he owns, and unpinned any time', async () => {
      const { user, h } = await member();
      const pin = (id: string, pinned: boolean) => put(`/v1/cards/${id}/home-pin`, { pinned }, h);
      expect(json(await pin(EIMI, true))).toMatchObject({ error: 'not_owned' });
      await repos.owned.grant(user.id, EIMI, false);
      const low = await pin(EIMI, true);
      expect([low.statusCode, json(low).error]).toEqual([403, 'variant_level']);
      expect((await pin('s1-eimi-01', true)).statusCode).toBe(404);

      await repos.cardAffection.add(user.id, EIMI, 'eimi', variantGain(1000));
      const on = await pin(EIMI, true);
      expect(on.statusCode).toBe(200);
      expect(json(on).variant).toMatchObject({ level: 10, pinned: true });
      const me = json(await get('/v1/auth/me', h));
      expect(me.owned.find((o: { cardId: string }) => o.cardId === EIMI).variant).toMatchObject({ pinned: true });
      // More XP keeps the pin.
      await repos.cardAffection.add(user.id, EIMI, 'eimi', variantGain(30));
      expect((await repos.cardAffection.get(user.id, EIMI))!.homePinned).toBe(true);
      expect(json(await pin(EIMI, false)).variant.pinned).toBe(false);
    });
  });
});
