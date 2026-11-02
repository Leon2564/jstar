import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DATE_RULES, MINIGAME_RULES, VOICE_RULES } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { MAIN_SCENES, pendingMedia } from '@jstar/shared/scenes';
import { VARIANT_SCENES } from '@jstar/shared/scenes/variantScenes';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { secureRandom } from '../src/lib/minigames';
import { createSqliteClient } from './sqlite';

// The persona service has its own suite (apps/agent/tests/test_minigames.py). Here the judge follows its contract by
// keyword: SPECIFIC → a specific praise, SCORE<n> → an ōgiri score, PIANO / PLEASE → a bargaining move, OVER → over
// the line, DOWN → the service failed (null). Anything else: generic praise, greet, "other".
const judged = vi.hoisted(() => ({ inputs: [] as { kind: string; text: string; star: string; lang?: string; context?: string; prompt?: string; scale?: number; callName?: string }[] }));
vi.mock('../src/lib/minigameJudge', () => ({
  judgeMinigame: async (input: { kind: string; text: string; star: string; context?: string; prompt?: string; scale?: number }) => {
    judged.inputs.push(input);
    const t = input.text;
    if (/DOWN/.test(t)) return null;
    switch (input.kind) {
      case 'praise': return { kind: 'praise', tier: /SPECIFIC/.test(t) ? 'specific' : 'generic', reason: /SPECIFIC/.test(t) ? 'detail' : 'generic' };
      case 'ogiri': return { kind: 'ogiri', score: Number(/SCORE(\d+)/.exec(t)?.[1] ?? 5), comment: /SCORE10/.test(t) ? 'ふふっ、満点！' : /LONG/.test(t) ? `ふふっ、やるじゃん。${'キミってほんとに面白い答えを出してくるよね、'.repeat(3)}` : null };
      case 'bargain': return { kind: 'bargain', move: /OVER/.test(t) ? 'over_line' : /PIANO/.test(t) ? 'alternative' : /PLEASE/.test(t) ? 'please' : 'other' };
      default: return { kind: 'danmaku', label: /OVER/.test(t) ? 'over-line' : 'greet' };
    }
  }
}));
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => ({ reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null }),
  streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
  greetPersona: async () => 'hi'
}));

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
/** 2026-11-02 12:00 JST: daytime, when none of the five evening scenes could start — a preview still does. */
const NOON = Date.UTC(2026, 10, 2, 3, 0);

let app: FastifyInstance;
let repos: Repos;
type Beat = { id: string; type: string; agent?: boolean; text?: { ja: string } };
type Run = {
  id: string; seq: number; status: string; outcome: string | null; endsAt: string; startedAt: string; timerEndsAt: string | null;
  beats: Beat[]; waiting: { id: string; type: string; kind?: string } | null; result: Record<string, unknown> | null;
  rewards: { affinity: number; memories: { title: string }[]; promises: { text: string }[] }
};

async function member() {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }) });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>, on = app) => on.inject({ method: 'POST', url, headers, payload });
const get = (url: string, headers: Record<string, string>, on = app) => on.inject({ url, headers });
const said = (r: Run) => r.beats.flatMap((b) => (b.type === 'line' && b.text ? [b.text.ja] : []));

async function preview(h: Record<string, string>, sceneId: string): Promise<Run> {
  const res = await post('/v1/scene/start', { sceneId, preview: true }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res).run;
}
async function step(h: Record<string, string>, run: Run, answer: object): Promise<Run> {
  const res = await post('/v1/scene/step', { runId: run.id, seq: run.seq, ...answer }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res).run;
}
const text = (h: Record<string, string>, run: Run, t: string) => step(h, run, { minigame: { text: t } });

afterEach(() => { vi.useRealTimers(); });

describe.each(BACKENDS)('the five scenes\' mini-games (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
    judged.inputs.length = 0;
  });

  it('previews are the test site\'s only (404 in production), where the five play the ordinary way now that #80\'s clips exist', async () => {
    const { user, h } = await member();
    const prod = await buildApp({ repos, logger: false, demo: false });
    expect((await get('/v1/scene/previews', h, prod)).statusCode).toBe(404);
    expect((await get('/v1/scene/preview/welcome-home', h, prod)).statusCode).toBe(404);
    // The publish rule (owner, 2026-09-28): their lines are reviewed and every clip exists, so production has them —
    // with every condition applied, like the test site (noon: locked). Only the owner's preview skips the conditions.
    for (const s of MAIN_SCENES) {
      expect(json(await post('/v1/scene/start', { sceneId: s.meta.id, preview: true }, h, prod))).toEqual({ error: 'scene_not_found' });
      expect(json(await post('/v1/scene/start', { sceneId: s.meta.id }, h, prod)), s.meta.id).toEqual({ error: 'scene_locked' });
      expect(json(await post('/v1/scene/start', { sceneId: s.meta.id }, h)), s.meta.id).toEqual({ error: 'scene_locked' });
    }
    expect(json(await post('/v1/scene/start', { sceneId: 'demo-evening', preview: true }, h))).toEqual({ error: 'scene_not_found' });
    expect(await repos.sceneRuns.active(user.id)).toBeNull();
    expect((await get('/v1/scene/previews', {})).statusCode).toBe(401);
  });

  it('lists the scenes the owner reviews with the clips they wait for (none since #80), and serves each with her real clips', async () => {
    const { h } = await member();
    const list = json(await get('/v1/scene/previews', h)).scenes as { id: string; star: string; pending: string[]; games: string[] }[];
    // The five main scenes (and the rainy reading), then her variant scenes (#76): published, and the owner still
    // tries each on the test site whatever the hour.
    expect(list.map((s) => s.id)).toEqual([...MAIN_SCENES, ...VARIANT_SCENES].map((s) => s.meta.id));
    expect(list.find((s) => s.id === 'welcome-home')).toMatchObject({ star: 'mahiro', games: ['rps'] });
    for (const s of list) expect(s.pending, s.id).toEqual([]);
    const one = json(await get('/v1/scene/preview/night-greenhouse', h));
    expect(pendingMedia([one.script])).toEqual([]);
    // Her #80 clips play as they are: nothing stands in.
    expect(one.standIns).toEqual({});
    expect(JSON.stringify(one.script)).toContain('alice-scene-night-greenhouse-piano');
    expect(json(await get('/v1/scene/preview/demo-evening', h))).toEqual({ error: 'scene_not_found' });
  });

  it('まひろ: her hand is drawn on the server and kept on the run; he cannot send a result (#66)', async () => {
    const { h } = await member();
    let run = await preview(h, 'welcome-home');
    expect(run.beats[0]).toMatchObject({ id: 'wide', type: 'clip' });
    run = await step(h, run, { choice: 'smell' });
    expect(run.waiting).toMatchObject({ id: 'rps', kind: 'rps' });
    expect(json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, minigame: { hand: 'rock', result: 'win' } }, h))).toMatchObject({ error: 'invalid_request' });
    const after = await step(h, run, { minigame: { hand: 'paper' } });
    expect(after.result).toMatchObject({ kind: 'rps', mine: 'paper' });
    const stored = await repos.sceneRuns.byId(run.id);
    expect(stored?.state.last).toEqual(after.result);
    const next = { win: 'win-pick', lose: 'praise', draw: 'rps' }[after.result!.result as 'win' | 'lose' | 'draw'];
    expect(after.waiting?.id).toBe(next);
    // A repeat of the same answer is the same draw, not a new one.
    const again = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, minigame: { hand: 'rock' } }, h));
    expect([again.replayed, again.run.result]).toEqual([true, after.result]);
  });

  it('her hand is fair: the CSPRNG lands on each third about as often', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) counts[Math.floor(secureRandom() * 3)]++;
    for (const c of counts) expect(Math.abs(c / 30_000 - 1 / 3)).toBeLessThan(0.02);
  });

  it('奈々: praise is judged against what she read; specific → +18 and the memory, generic → a second chance (#67)', async () => {
    const a = await member();
    let run = await step(a.h, await preview(a.h, 'read-aloud'), { choice: 'rain-bookshop' });
    expect(run.waiting).toMatchObject({ id: 'praise', kind: 'praise' });
    run = await text(a.h, run, 'SPECIFIC おばあさんの紅茶');
    expect(judged.inputs[0]).toMatchObject({ kind: 'praise', star: 'nana', text: 'SPECIFIC おばあさんの紅茶' });
    expect(judged.inputs[0].context).toContain('黙って紅茶を一杯出してくれる');
    expect(run.result).toEqual({ kind: 'praise', tier: 'specific', reason: 'detail', score: 18, attempt: 1, result: 'win' });
    expect([run.status, run.outcome, run.rewards.affinity, run.rewards.memories.map((m) => m.title)]).toEqual(['ended', 'praised', 18, ['句点の前の息つぎ']]);

    const b = await member();
    run = await step(b.h, await preview(b.h, 'read-aloud'), { choice: 'star-bookmark' });
    run = await text(b.h, run, 'よかった');
    expect([run.waiting?.id, run.rewards.affinity]).toEqual(['praise-again', 1]);
    // The second try still sees the poem.
    run = await text(b.h, run, 'DOWN');
    expect(judged.inputs[2].context).toContain('夜空は　ひらいたままの本');
    expect([run.outcome, run.rewards.affinity, run.rewards.promises.map((p) => p.text)]).toEqual(['gentle', 2, ['明日の朝、お茶を淹れて続きを読む']]);
  });

  it('えいみ: a prompt from her bank, a score with her remark, affinity + score × 0.7, and 8 to pass (#70)', async () => {
    const { h } = await member();
    let run = await step(h, await preview(h, 'ogiri'), { choice: 'gentle' });
    const bank = LINES.eimi.ogiri!;
    const prompt1 = run.beats.find((b) => b.id === 'round-1~prompt')!;
    expect(bank.map((p) => p.text.ja)).toContain(prompt1.text!.ja);
    run = await text(h, run, 'SCORE10 目覚ましがプロポーズ');
    expect(judged.inputs[0]).toMatchObject({ kind: 'ogiri', star: 'eimi', scale: 10, prompt: prompt1.text!.ja });
    expect(run.result).toMatchObject({ kind: 'ogiri', score: 10, pass: null });
    expect(run.beats[0]).toMatchObject({ id: 'round-1~reply', agent: true, text: { ja: 'ふふっ、満点！' } });
    expect(run.rewards.affinity).toBe(Math.round(10 * MINIGAME_RULES.ogiriAffinityPerPoint));
    const prompt2 = run.beats.find((b) => b.id === 'round-2~prompt')!;
    expect(prompt2.text!.ja).not.toBe(prompt1.text!.ja);
    run = await text(h, run, 'SCORE8');
    expect(run.result).toMatchObject({ score: 8, pass: 8, result: 'win' });
    expect(run.waiting?.id).toBe('say');

    const b = await member();
    run = await step(b.h, await preview(b.h, 'ogiri'), { choice: 'gentle' });
    run = await text(b.h, await text(b.h, run, 'SCORE9'), 'DOWN');
    expect(run.result).toMatchObject({ score: Math.round(10 * MINIGAME_RULES.ogiriFallbackShare), result: 'lose' });
    expect(run.outcome).toBe('retry');
  });

  it('M4: her ōgiri remark fits three subtitle lines', async () => {
    const { h } = await member();
    const run = await text(h, await step(h, await preview(h, 'ogiri'), { choice: 'gentle' }), 'SCORE7 LONG');
    expect(run.beats[0]).toMatchObject({ id: 'round-1~reply', agent: true, text: { ja: 'ふふっ、やるじゃん。' } });
  });

  it('H2: her ōgiri remark knows what she calls him, in his language — his name verbatim (ケンタ, never 健太)', async () => {
    const { user, h } = await member();
    await repos.bond.setName(user.id, 'ケンタ', new Date().toISOString());
    let run = await step(h, await preview(h, 'ogiri'), { choice: 'gentle' });
    run = await step(h, run, { minigame: { text: 'SCORE7 雨傘' }, lang: 'zh-Hant' });
    expect(judged.inputs[0]).toMatchObject({ kind: 'ogiri', lang: 'zh-Hant', callName: 'ケンタ' });
    await step(h, run, { minigame: { text: 'SCORE7 傘' }, lang: 'ja' });
    expect(judged.inputs[1]).toMatchObject({ lang: 'ja', callName: 'ケンタくん' });
    // No name: none sent (she names nobody); the other games never need it.
    const b = await member();
    await text(b.h, await step(b.h, await preview(b.h, 'ogiri'), { choice: 'gentle' }), 'SCORE5');
    expect(judged.inputs[2]).not.toHaveProperty('callName');
    await text(b.h, await preview(b.h, 'private-stream'), 'こんばんは');
    expect(judged.inputs[3]).toMatchObject({ kind: 'danmaku' });
    expect(judged.inputs[3]).not.toHaveProperty('callName');
  });

  it('うんぱい: each comment read out, quoting it; a comment over the line is never read back (#68)', async () => {
    const { h } = await member();
    let run = await preview(h, 'private-stream');
    expect(run.waiting).toMatchObject({ id: 'c1', kind: 'danmaku' });
    run = await text(h, run, 'こんばんは〜');
    expect(said(run)[0]).toContain('こんばんは〜');
    expect(run.result).toEqual({ kind: 'danmaku', label: 'greet', read: true, result: 'win' });
    run = await text(h, run, 'OVER ひみつの言葉');
    expect(JSON.stringify(run.beats)).not.toContain('ひみつの言葉');
    expect(run.result).toMatchObject({ label: 'over-line', read: false });
    run = await text(h, run, 'DOWN なにか');
    expect(JSON.stringify(run.beats)).not.toContain('なにか');
    expect(run.waiting?.id).toBe('gift');
  });

  it('アリス: in a heatwave she refuses because of the heat (#63); the piano is the way through; the date runs 40 minutes (#69)', async () => {
    const { h } = await member();
    expect((await app.inject({ method: 'PUT', url: '/v1/world/demo', headers: h, payload: { star: 'alice', weather: 'clear', alert: 'heat' } })).statusCode).toBe(200);
    let run = await preview(h, 'night-greenhouse');
    expect(run.timerEndsAt).toBe(new Date(NOON + DATE_RULES.minutes * 60_000).toISOString());
    expect(run.endsAt).toBe(new Date(NOON + DATE_RULES.minutes * 60_000 + DATE_RULES.afterTimerMs).toISOString());
    run = await step(h, run, { choice: 'dance' });
    expect(said(run)[0]).toBe(LINES.alice.bargain!.refuse.hot.ja);
    run = await step(h, await step(h, run, { choice: 'icecream' }), { minigame: { text: 'PIANO 一曲だけ' } });
    expect(run.result).toEqual({ kind: 'bargain', move: 'alternative', result: 'win' });
    expect(run.beats.map((b) => b.id).slice(0, 2)).toEqual(['piano-1', 'piano-yes']);
    // 35 minutes in the run is still open: its date is.
    vi.setSystemTime(NOON + 35 * 60_000);
    expect(json(await get(`/v1/scene/runs/${run.id}`, h)).run.status).toBe('active');
    run = await step(h, run, { choice: 'only-you' });
    run = await step(h, run, { choice: 'extend' });
    expect(run.timerEndsAt).toBe(new Date(NOON + (DATE_RULES.minutes + DATE_RULES.extendMinutes) * 60_000).toISOString());
    expect(run.outcome).toBe('extended');
  });

  it('アリス: the extension is paid in points through the voice ledger, once, and adds voice minutes too (#69, #74)', async () => {
    const { user, h } = await member();
    const before = (await repos.users.byId(user.id))!.points;
    let run = await step(h, await preview(h, 'night-greenhouse'), { choice: 'talk' });
    run = await step(h, run, { choice: 'only-you' });
    expect(run.waiting?.id).toBe('extend');
    const answer = { runId: run.id, seq: run.seq, choice: 'extend' };
    const first = json(await post('/v1/scene/step', answer, h));
    // The same answer again (a retry, a double tap) is the same step: no second charge.
    const again = json(await post('/v1/scene/step', answer, h));
    expect([first.run.outcome, again.replayed]).toEqual(['extended', true]);
    expect((await repos.users.byId(user.id))!.points).toBe(before - VOICE_RULES.extendCostPoints);
    const voice = json(await get('/v1/voice', h));
    expect([voice.extensions, voice.leftSeconds]).toEqual([1, (VOICE_RULES.freeMinutesPerDay + VOICE_RULES.extendMinutes) * 60]);
  });

  it('アリス: when the 40 minutes are up her plea comes at once — on the next read — and the paid +30 is charged once (#69 AC)', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    const { user, h } = await member();
    const before = (await repos.users.byId(user.id))!.points;
    const run = await step(h, await preview(h, 'night-greenhouse'), { choice: 'dance' });
    expect(run.waiting?.id).toBe('offer');
    const ends = Date.parse(run.timerEndsAt!);
    vi.setSystemTime(ends - 1000);
    expect(json(await get(`/v1/scene/runs/${run.id}`, h)).run.waiting.id).toBe('offer');
    vi.setSystemTime(ends + 500);
    const plea = json(await get(`/v1/scene/runs/${run.id}`, h)).run;
    expect([plea.status, plea.waiting.id, plea.seq]).toEqual(['active', 'extend', run.seq + 1]);
    expect(plea.beats.map((b: { id: string }) => b.id).slice(0, 2)).toEqual(['closing', 'stay']);
    // His late answer to the old step changes nothing: it is told where the run is now.
    const late = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'please' }, h));
    expect([late.replayed, late.run.waiting.id]).toEqual([true, 'extend']);
    // The extension, twice (a double tap): paid once, +30 minutes once, and no second plea when they run out.
    const answer = { runId: plea.id, seq: plea.seq, choice: 'extend' };
    const first = json(await post('/v1/scene/step', answer, h));
    const again = json(await post('/v1/scene/step', answer, h));
    expect([first.run.outcome, again.replayed]).toEqual(['extended', true]);
    expect((await repos.users.byId(user.id))!.points).toBe(before - VOICE_RULES.extendCostPoints);
  });

  it('アリス: without the points the extension is refused and nothing moves; 「今日はここまで」 still ends the date', async () => {
    const { user, h } = await member();
    await repos.users.adjustWallet(user.id, { points: -(await repos.users.byId(user.id))!.points + VOICE_RULES.extendCostPoints - 1 });
    let run = await step(h, await preview(h, 'night-greenhouse'), { choice: 'talk' });
    run = await step(h, run, { choice: 'lovely' });
    const refused = await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'extend' }, h);
    expect([refused.statusCode, json(refused).error]).toEqual([402, 'insufficient_points']);
    expect(json(await get(`/v1/scene/runs/${run.id}`, h)).run.waiting.id).toBe('extend');
    expect((await repos.users.byId(user.id))!.points).toBe(VOICE_RULES.extendCostPoints - 1);
    run = await step(h, run, { choice: 'tomorrow' });
    expect(run.outcome).toBe('tomorrow');
    expect(json(await get('/v1/voice', h)).extensions).toBe(0);
  });

  it('アリス: an extension that loses its step to another answer (a timeout, a second tab) is not paid for', async () => {
    const { user, h } = await member();
    const before = (await repos.users.byId(user.id))!.points;
    let run = await step(h, await preview(h, 'night-greenhouse'), { choice: 'talk' });
    run = await step(h, run, { choice: 'only-you' });
    // The other tab's 「今日はここまで」 moves the same step just before the paid answer is written.
    const advance = repos.sceneRuns.advance.bind(repos.sceneRuns);
    repos.sceneRuns.advance = async (row, expectSeq, grant, extension) => {
      if (extension) {
        repos.sceneRuns.advance = advance;
        await step(h, run, { choice: 'tomorrow' });
      }
      return advance(row, expectSeq, grant, extension);
    };
    const lost = await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'extend' }, h);
    expect(lost.statusCode).toBe(200);
    expect([json(lost).replayed, json(lost).run.outcome]).toEqual([true, 'tomorrow']);
    expect((await repos.users.byId(user.id))!.points).toBe(before);
    expect(json(await get('/v1/voice', h)).extensions).toBe(0);
  });

  it('アリス: points spent between the check and the step: refused, nothing paid, the run still waits', async () => {
    const { user, h } = await member();
    let run = await step(h, await preview(h, 'night-greenhouse'), { choice: 'talk' });
    run = await step(h, run, { choice: 'only-you' });
    const advance = repos.sceneRuns.advance.bind(repos.sceneRuns);
    repos.sceneRuns.advance = async (row, expectSeq, grant, extension) => {
      repos.sceneRuns.advance = advance;
      await repos.users.adjustWallet(user.id, { points: -(await repos.users.byId(user.id))!.points + 1 });
      return advance(row, expectSeq, grant, extension);
    };
    const refused = await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'extend' }, h);
    expect([refused.statusCode, json(refused).error]).toEqual([402, 'insufficient_points']);
    expect(json(await get(`/v1/scene/runs/${run.id}`, h)).run).toMatchObject({ seq: run.seq, waiting: { id: 'extend' } });
    expect((await repos.users.byId(user.id))!.points).toBe(1);
    expect(json(await get('/v1/voice', h)).extensions).toBe(0);
  });

  it('アリス: without the heat, her ordinary refusal; asking again gets her answer and the counter-offer', async () => {
    const { h } = await member();
    let run = await step(h, await preview(h, 'night-greenhouse'), { choice: 'dance' });
    expect(said(run)[0]).toBe(LINES.alice.bargain!.refuse.normal.ja);
    run = await step(h, await step(h, run, { choice: 'please' }), { minigame: { text: 'PLEASE お願い' } });
    expect(said(run).slice(0, 2)).toEqual([LINES.alice.bargain!.branches[0].reply[0].ja, LINES.alice.bargain!.counter[0].ja]);
    expect(run.waiting?.id).toBe('answer');
  });

  it('a judged answer is judged once: a repeat returns the run as it is, and a wrong kind of answer never reaches the judge', async () => {
    const { h } = await member();
    const run = await step(h, await preview(h, 'read-aloud'), { choice: 'last-page' });
    expect(json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, minigame: { hand: 'rock' } }, h))).toEqual({ error: 'invalid_submission' });
    expect(json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'x' }, h))).toEqual({ error: 'invalid_submission' });
    expect(judged.inputs).toHaveLength(0);
    const after = await text(h, run, 'SPECIFIC 句点の前の息');
    const again = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, minigame: { text: 'よかった' } }, h));
    expect([again.replayed, again.run.outcome, again.run.seq]).toEqual([true, after.outcome, after.seq]);
    expect(judged.inputs).toHaveLength(1);
  });
});

describe('the judge client never throws', () => {
  it('reads a well-formed answer and turns anything else into null (the safe reading)', async () => {
    const { judgeMinigame } = await vi.importActual<typeof import('../src/lib/minigameJudge')>('../src/lib/minigameJudge');
    const input = { star: 'eimi' as const, lang: 'ja' as const, kind: 'ogiri' as const, text: 'x', scale: 10 };
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await judgeMinigame(input, reply(200, { kind: 'ogiri', label: 'scored', score: 8, comment: 'ふふっ', source: 'model' }))).toEqual({ kind: 'ogiri', score: 8, comment: 'ふふっ' });
    expect(await judgeMinigame(input, reply(200, { kind: 'ogiri', label: null, score: null, source: 'fallback' }))).toBeNull();
    expect(await judgeMinigame(input, reply(200, { kind: 'praise', label: 'specific' }))).toBeNull();
    expect(await judgeMinigame(input, reply(200, { kind: 'ogiri', score: 42 }))).toBeNull();
    expect(await judgeMinigame(input, reply(503, {}))).toBeNull();
    expect(await judgeMinigame(input, (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await judgeMinigame(input, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).toBeNull();
    const praise = { ...input, kind: 'praise' as const };
    expect(await judgeMinigame(praise, reply(200, { kind: 'praise', label: 'over_line', reason: 'over_line' }))).toEqual({ kind: 'praise', tier: 'generic', reason: 'over_line' });
    let sent: { url: string; body: unknown } | null = null;
    await judgeMinigame({ ...praise, context: 'she read' }, (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    expect(sent).toEqual({ url: `${env.AGENT_BASE_URL}/v1/scene/judge`, body: { ...praise, context: 'she read' } });
  });
});
