import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VOICE_RULES } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos, UserRow } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { TtsError, relaySynthesizer, type Synthesize } from '../src/lib/tts';
import { localTts } from '../src/lib/localTts';
import { createSqliteClient } from './sqlite';
import { signLine } from '../src/lib/voiceLines';
import { FIRST_CJK, TTS_SENTENCE_CJK, splitSentences, type StarId } from '@jstar/shared';
import { readFileSync } from 'node:fs';
import {
  BYTEPLUS_TTS_RESOURCE, FISH_TTS_MODEL, FISH_ZH_HINT, mandarinPauses, QWEN_TTS_MODEL, TTS_ADAPTERS, byteplusAdapter, fishAdapter, mp3Seconds, jsonObjects, keyFor, qwenAdapter, synthesizeRelay, ttsProvider, ttsStars,
  voiceFor, wavFromPcm, wavSeconds, type TtsAdapter
} from '../../../infra/cloudflare/src/tts';
import { toSimplified } from '../../../infra/cloudflare/src/hans';

// The scene's bargaining judge is the persona service's (apps/agent); here it cannot answer, so the scene takes its
// conservative default — this suite only counts the seconds he talked.
vi.mock('../src/lib/minigameJudge', () => ({ judgeMinigame: async () => null }));

/**
 * Voice minutes (#74) and her runtime voice (#73): the ledger, the JST-midnight reset, the paid extension (capped,
 * idempotent) and the TTS gate with its subtitle fallback — on both stores.
 */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
/** 2026-11-02 12:00 JST. */
const NOON = Date.UTC(2026, 10, 2, 3, 0);
const FREE = VOICE_RULES.freeMinutesPerDay * 60;

let app: FastifyInstance;
let repos: Repos;
let synth: { calls: { star: string; text: string; lang: string }[]; answer: () => Promise<{ audio: Buffer; mime: string; seconds: number }> };
const fakeSynth: Synthesize = async (r) => { synth.calls.push(r); return synth.answer(); };

/** Each test account's id by its Authorization header (to sign her lines for it, as the server does). */
const ids = new Map<string, string>();
async function member(patch: Partial<UserRow> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'ken', via: 'email', lang: 'ja' }), ...patch });
  const h = { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 86_400)}` };
  ids.set(h.authorization, user.id);
  return { user, h };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, h: Record<string, string>, on = app) => on.inject({ method: 'POST', url, headers: h, payload });
const voice = async (h: Record<string, string>, on = app) => json(await on.inject({ url: '/v1/voice', headers: h }));
const extend = (h: Record<string, string>, requestId: string) => post('/v1/voice/extend', { requestId }, h);
/** Her line, signed for this account as the server signs her replies, and its first sentence asked for. */
const sayAs = (star: StarId, h: Record<string, string>, line: string, requestId: string, on = app, index = 0) =>
  post('/v1/tts', { star, line, sig: signLine(ids.get(h.authorization) ?? 'nobody', star, line), index, requestId }, h, on);
const say = (h: Record<string, string>, text: string, requestId: string, on = app) => sayAs('alice', h, text, requestId, on);
const points = async (id: string) => (await repos.users.byId(id))!.points;

afterEach(() => { vi.useRealTimers(); });

describe.each(BACKENDS)('voice minutes (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    repos = makeRepos();
    synth = { calls: [], answer: async () => ({ audio: Buffer.from('ID3-audio'), mime: 'audio/mpeg', seconds: 2.3 }) };
    app = await buildApp({ repos, logger: false, demo: true, synthesize: fakeSynth });
  });

  it('/v1/auth/me: the free minutes, or the pass minutes, and her voice for every member once a vendor is set', async () => {
    const { h } = await member();
    const me = json(await app.inject({ url: '/v1/auth/me', headers: h }));
    expect(me.voiceLeft).toBe(FREE);
    expect(me.voice).toMatchObject({ day: '2026-11-02', leftSeconds: FREE, usedSeconds: 0, extensions: 0, extensionsLeft: VOICE_RULES.extendsPerDay, extendCost: VOICE_RULES.extendCostPoints, tts: true });
    const pass = await member({ passUntil: new Date(NOON + 86_400_000).toISOString() });
    expect(json(await app.inject({ url: '/v1/auth/me', headers: pass.h })).voiceLeft).toBe(VOICE_RULES.passMinutesPerDay * 60);
    const admin = await member({ role: 'admin' });
    const mod = await member({ role: 'moderator' });
    expect((await voice(admin.h)).tts).toBe(true);
    expect((await voice(mod.h)).tts).toBe(true);
    // No provider configured: nobody hears her runtime voice, operators included.
    const off = await buildApp({ repos, logger: false, demo: true, synthesize: null });
    expect([(await voice(admin.h, off)).tts, (await voice(h, off)).tts]).toEqual([false, false]);
    expect((await app.inject({ url: '/v1/voice' })).statusCode).toBe(401);
  });

  it('seconds add up over the day and reset at 0:00 JST', async () => {
    const { user, h } = await member({ role: 'admin' });
    // 2.3 s of her voice is charged as 3; a request id sent again is refused, neither synthesized nor charged again.
    for (const id of ['line-0001:0', 'line-0001:1']) expect(json(await say(h, 'こんばんは。', id)).mode).toBe('voice');
    expect((await say(h, 'こんばんは。', 'line-0001:1')).statusCode).toBe(409);
    expect(synth.calls).toHaveLength(2);
    await repos.voice.use({ userId: user.id, requestId: 'scene:x:1:input', day: '2026-11-02', kind: 'input', seconds: 7, nonce: 'n', createdAt: new Date().toISOString() });
    expect((await voice(h)).usedSeconds).toBe(3 + 3 + 7);
    expect((await voice(h)).leftSeconds).toBe(FREE - 13);
    // 23:59:59 JST still today; one second later the day is fresh.
    vi.setSystemTime(Date.UTC(2026, 10, 2, 14, 59, 59));
    expect((await voice(h)).usedSeconds).toBe(13);
    vi.setSystemTime(Date.UTC(2026, 10, 2, 15, 0, 0));
    expect(await voice(h)).toMatchObject({ day: '2026-11-03', usedSeconds: 0, leftSeconds: FREE, extensions: 0 });
  });

  it('his voice input in a scene is charged once per answer', async () => {
    const { h } = await member();
    let run = json(await post('/v1/scene/start', { sceneId: 'night-greenhouse', preview: true }, h)).run;
    run = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'dance' }, h)).run;
    run = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'please' }, h)).run;
    expect(run.waiting.id).toBe('plea');
    const answer = { runId: run.id, seq: run.seq, minigame: { text: 'お願い、一曲だけ' }, voiceMs: 4200 };
    expect((await post('/v1/scene/step', answer, h)).statusCode).toBe(200);
    expect(json(await post('/v1/scene/step', answer, h)).replayed).toBe(true);
    expect((await voice(h)).usedSeconds).toBe(5);
  });

  it('an extension costs points once per request id, adds the minutes for today, and stops at the daily cap', async () => {
    const { user, h } = await member();
    const start = await points(user.id);
    const first = json(await extend(h, 'ext-request-1'));
    expect(first).toMatchObject({ replayed: false, points: start - VOICE_RULES.extendCostPoints });
    expect(first.voice).toMatchObject({ extensions: 1, leftSeconds: FREE + VOICE_RULES.extendMinutes * 60 });
    const again = json(await extend(h, 'ext-request-1'));
    expect(again).toMatchObject({ replayed: true, points: start - VOICE_RULES.extendCostPoints });
    expect(await points(user.id)).toBe(start - VOICE_RULES.extendCostPoints);
    for (let i = 2; i <= VOICE_RULES.extendsPerDay; i++) expect((await extend(h, `ext-request-${i}`)).statusCode).toBe(200);
    const capped = await extend(h, 'ext-request-over');
    expect([capped.statusCode, json(capped).error]).toEqual([409, 'extend_limit']);
    expect(await points(user.id)).toBe(start - VOICE_RULES.extendsPerDay * VOICE_RULES.extendCostPoints);
    expect((await voice(h)).extensionsLeft).toBe(0);
    // A new JST day: extensions start over, yesterday's are gone.
    vi.setSystemTime(Date.UTC(2026, 10, 2, 15, 0, 0));
    expect((await voice(h))).toMatchObject({ extensions: 0, extensionsLeft: VOICE_RULES.extendsPerDay, leftSeconds: FREE });
    expect((await extend(h, 'ext-request-next-day')).statusCode).toBe(200);
  });

  it('without the points nothing is written; a request id used for something else is a conflict', async () => {
    const { user, h } = await member();
    await repos.users.adjustWallet(user.id, { points: -(await points(user.id)) + VOICE_RULES.extendCostPoints - 1 });
    const poor = await extend(h, 'ext-request-poor');
    expect([poor.statusCode, json(poor).error]).toEqual([402, 'insufficient_points']);
    expect((await voice(h)).extensions).toBe(0);
    // Once he has the points, the same id goes through: a refusal never burned it.
    await repos.users.adjustWallet(user.id, { points: 1 });
    expect((await extend(h, 'ext-request-poor')).statusCode).toBe(200);
    await repos.voice.use({ userId: user.id, requestId: 'ext:taken-by-tts', day: '2026-11-02', kind: 'tts', seconds: 1, nonce: 'n', createdAt: new Date().toISOString() });
    const clash = await extend(h, 'taken-by-tts');
    expect([clash.statusCode, json(clash).error]).toEqual([409, 'request_conflict']);
    expect((await extend(h, 'bad')).statusCode).toBe(400);
  });

  it('parallel extensions with one request id are charged once', async () => {
    const { user, h } = await member();
    const start = await points(user.id);
    const all = await Promise.all([1, 2, 3].map(() => extend(h, 'ext-parallel-1')));
    expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await points(user.id)).toBe(start - VOICE_RULES.extendCostPoints);
    expect((await voice(h)).extensions).toBe(1);
  });

  it('account deletion takes his voice ledger with it', async () => {
    const { user, h } = await member();
    expect((await extend(h, 'ext-request-1')).statusCode).toBe(200);
    await repos.users.anonymise(user.id, new Date().toISOString());
    expect(await repos.voice.day(user.id, '2026-11-02')).toEqual({ day: '2026-11-02', usedSeconds: 0, extensions: 0 });
  });
});

describe.each(BACKENDS)('her runtime voice: POST /v1/tts (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    repos = makeRepos();
    synth = { calls: [], answer: async () => ({ audio: Buffer.from('ID3-audio'), mime: 'audio/mpeg', seconds: 1.5 }) };
    app = await buildApp({ repos, logger: false, demo: true, synthesize: fakeSynth });
  });

  it('every member hears her own words, charged to his minutes; the pass gives more minutes, the provider is asked once per sentence', async () => {
    const { h } = await member();
    const r = json(await say(h, '……聴いていて、くださいね。', 'line-abcd:0'));
    expect(r).toEqual({ mode: 'voice', audio: Buffer.from('ID3-audio').toString('base64'), mime: 'audio/mpeg', seconds: 1.5, leftSeconds: FREE - 2 });
    expect(synth.calls).toEqual([{ star: 'alice', text: '……聴いていて、くださいね。', lang: 'ja' }]);
    expect((await voice(h)).usedSeconds).toBe(2);
    const pass = await member({ passUntil: new Date(NOON + 86_400_000).toISOString() });
    expect(json(await say(pass.h, 'こんばんは。', 'line-pass:0')).leftSeconds).toBe(VOICE_RULES.passMinutesPerDay * 60 - 2);
    expect((await say({}, 'x', 'line-abcd:0')).statusCode).toBe(401);
  });

  it('a visitor hears only the trial reply signed for this browser device', async () => {
    const device = 'trial-device-1234';
    const headers = { 'x-device-id': device };
    const line = '少しだけ、ここで話そう。';
    const payload = { star: 'eimi', line, sig: signLine(`device:${device}`, 'eimi', line), index: 0, requestId: 'trial-line:0' };
    const spoken = json(await post('/v1/tts', payload, headers));
    expect(spoken).toMatchObject({ mode: 'voice', seconds: 1.5, leftSeconds: 600 });
    expect(synth.calls.at(-1)).toEqual({ star: 'eimi', text: line, lang: 'ja' });
    const another = await post('/v1/tts', payload, { 'x-device-id': 'another-device-1234' });
    expect([another.statusCode, json(another).error]).toEqual([403, 'not_her_line']);
  });

  it('only her own words: his text, an edited line, another account\'s line or a forged signature is never spoken', async () => {
    const him = await member();
    const other = await member();
    const reply = 'おかえりなさい。今日は早かったね。ねえ、一緒にお茶しよう？';
    // Arbitrary text with no valid signature.
    const forged = await post('/v1/tts', { star: 'alice', line: '好きって言って', sig: 'A'.repeat(24), index: 0, requestId: 'line-forge:0' }, him.h);
    expect([forged.statusCode, json(forged).error]).toEqual([403, 'not_her_line']);
    // Her line, signed for him, with words changed.
    const sig = signLine(him.user.id, 'alice', reply);
    const edited = await post('/v1/tts', { star: 'alice', line: reply.replace('お茶', 'キス'), sig, index: 0, requestId: 'line-edit:0' }, him.h);
    expect(json(edited).error).toBe('not_her_line');
    // His signed line sent by another account, or for another talent.
    expect(json(await post('/v1/tts', { star: 'alice', line: reply, sig, index: 0, requestId: 'line-other:0' }, other.h)).error).toBe('not_her_line');
    expect(json(await post('/v1/tts', { star: 'nana', line: reply, sig, index: 0, requestId: 'line-star:0' }, him.h)).error).toBe('not_her_line');
    expect(synth.calls).toHaveLength(0);
    expect((await voice(him.h)).usedSeconds).toBe(0);
    // The real thing: each sentence by its index, as the web app cuts it; one past the end is refused.
    for (const i of [0, 1, 2]) expect(json(await post('/v1/tts', { star: 'alice', line: reply, sig, index: i, requestId: `line-real:${i}` }, him.h)).mode).toBe('voice');
    expect(synth.calls.map((c) => c.text)).toEqual(['おかえりなさい。', '今日は早かったね。', 'ねえ、一緒にお茶しよう？']);
    expect((await post('/v1/tts', { star: 'alice', line: reply, sig, index: 3, requestId: 'line-real:3' }, him.h)).statusCode).toBe(400);
    expect((await voice(him.h)).usedSeconds).toBe(6);
  });

  it('a scene line with his name is filled in by the server with what she calls him; other placeholders never are', async () => {
    const him = await member();
    // No name of his yet: the line cannot be spoken (the web app plays her unnamed recording instead).
    const unnamed = '{name}、来てくれたんだ。';
    expect(json(await post('/v1/tts', { star: 'alice', line: unnamed, sig: signLine(him.user.id, 'alice', unnamed), index: 0, requestId: 'line-noname:0' }, him.h)))
      .toMatchObject({ mode: 'subtitle', reason: 'failed' });
    await app.inject({ method: 'PUT', url: '/v1/bond/name', headers: him.h, payload: { name: 'ケンタ' } });
    // What her scene shows him as his name (the web player reads the same: GET /v1/bond).
    const { callName } = json(await app.inject({ url: '/v1/bond?star=alice&lang=ja', headers: him.h }));
    expect(callName).toContain('ケンタ');
    const line = '{name}、来てくれたんだ。';
    const sig = signLine(him.user.id, 'alice', line);
    expect(json(await post('/v1/tts', { star: 'alice', line, sig, index: 0, requestId: 'line-name:0' }, him.h)).mode).toBe('voice');
    expect(synth.calls.at(-1)!.text).toBe(`${callName}、来てくれたんだ。`);
    const danmaku = '{danmaku}って言われた！';
    const d = json(await post('/v1/tts', { star: 'alice', line: danmaku, sig: signLine(him.user.id, 'alice', danmaku), index: 0, requestId: 'line-dm:0' }, him.h));
    expect(d).toMatchObject({ mode: 'subtitle', reason: 'failed' });
    expect(synth.calls.every((c) => !c.text.includes('{'))).toBe(true);
  });

  it('her message as a voice note (#13): signed for him on demand, spoken by /v1/tts and charged then — never before', async () => {
    const him = await member();
    const other = await member();
    const at = new Date(NOON).toISOString();
    const text = '今日はね、お花屋さんで新しい鉢を見つけたの。';
    await repos.inbox.add({ id: 'inb_note', userId: him.user.id, star: 'alice', kind: 'message', payload: { text, herMessage: 'daily' }, dueAt: at, deliveredAt: at, readAt: null, createdAt: at });
    // Asking for it synthesizes nothing and costs nothing.
    const note = json(await post('/v1/inbox/inb_note/voice', {}, him.h));
    expect(note).toEqual({ mode: 'voice', line: text, sig: signLine(him.user.id, 'alice', text) });
    expect(synth.calls).toHaveLength(0);
    expect((await voice(him.h)).usedSeconds).toBe(0);
    // Played: her own words, in her voice, charged to his minutes.
    expect(json(await post('/v1/tts', { star: 'alice', line: note.line, sig: note.sig, index: 0, requestId: 'line-note:0' }, him.h)).mode).toBe('voice');
    expect(synth.calls.map((c) => c.text)).toEqual(['今日はね、']);
    expect((await voice(him.h)).usedSeconds).toBe(2);
    // Not his message, not one at all: 404.
    expect((await post('/v1/inbox/inb_note/voice', {}, other.h)).statusCode).toBe(404);
    expect((await post('/v1/inbox/inb_none/voice', {}, him.h)).statusCode).toBe(404);
    // Her runtime voice off: no voice note.
    const off = await buildApp({ repos, logger: false, demo: true, synthesize: null });
    expect(json(await off.inject({ method: 'POST', url: '/v1/inbox/inb_note/voice', headers: him.h, payload: {} }))).toEqual({ mode: 'subtitle' });
  });

  it('too many sentences a minute from one account is 429', async () => {
    const { h } = await member({ passUntil: new Date(NOON + 86_400_000).toISOString() });
    const codes: number[] = [];
    for (let i = 0; i < 42; i++) codes.push((await say(h, 'うん。', `line-burst-${i}:0`)).statusCode);
    expect(codes.slice(0, 40).every((c) => c === 200)).toBe(true);
    expect(codes.slice(40)).toEqual([429, 429]);
  });

  it('a request id is synthesized once: sent again, at once or later, it is 409 and the provider is not asked', async () => {
    const admin = await member({ role: 'admin' });
    const all = await Promise.all([1, 2, 3].map(() => say(admin.h, 'こんばんは', 'line-same:0')));
    expect(all.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const later = await say(admin.h, 'もう一度', 'line-same:0');
    expect([later.statusCode, json(later).error]).toEqual([409, 'request_conflict']);
    expect(synth.calls).toHaveLength(1);
    expect((await voice(admin.h)).usedSeconds).toBe(2);
    // A failed synthesis takes its claim back: the same id may be tried again, and is charged once when it works.
    synth.answer = async () => { throw new TtsError('tts_failed'); };
    expect(json(await say(admin.h, 'a', 'line-retry:0'))).toMatchObject({ mode: 'subtitle', reason: 'failed' });
    synth.answer = async () => ({ audio: Buffer.from('ID3-audio'), mime: 'audio/mpeg', seconds: 1.5 });
    expect(json(await say(admin.h, 'a', 'line-retry:0')).mode).toBe('voice');
    expect((await voice(admin.h)).usedSeconds).toBe(4);
  });

  it('no provider = provider `none`: subtitles for everyone', async () => {
    const off = await buildApp({ repos, logger: false, demo: true, synthesize: null });
    const admin = await member({ role: 'admin' });
    expect(json(await say(admin.h, 'こんばんは', 'line-abcd:0', off))).toMatchObject({ mode: 'subtitle', reason: 'off' });
  });

  it('out of minutes, a failed provider, or no cloned voice of hers: subtitles, never an error, never charged', async () => {
    const { user, h } = await member({ role: 'moderator' });
    synth.answer = async () => { throw new TtsError('tts_failed'); };
    expect(json(await say(h, 'a', 'line-abcd:1'))).toEqual({ mode: 'subtitle', reason: 'failed', leftSeconds: FREE });
    synth.answer = async () => { throw new TtsError('tts_no_voice'); };
    expect(json(await say(h, 'a', 'line-abcd:2'))).toEqual({ mode: 'subtitle', reason: 'no_voice', leftSeconds: FREE });
    expect((await voice(h)).usedSeconds).toBe(0);
    await repos.voice.use({ userId: user.id, requestId: 'scene:x:1:input', day: '2026-11-02', kind: 'input', seconds: FREE, nonce: 'n', createdAt: new Date().toISOString() });
    synth.calls.length = 0;
    expect(json(await say(h, 'a', 'line-abcd:3'))).toEqual({ mode: 'subtitle', reason: 'no_minutes', leftSeconds: 0 });
    expect(synth.calls).toHaveLength(0);
  });

  it('refuses a line too long to be hers, and asks the provider for at most one request\'s worth of text', async () => {
    const admin = await member({ role: 'admin' });
    expect((await say(admin.h, 'あ'.repeat(2001), 'line-abcd:0')).statusCode).toBe(400);
    expect(json(await say(admin.h, 'あ'.repeat(450), 'line-long:0')).mode).toBe('voice');
    // Sentence 0 is her first breath (16 CJK characters); the next one breath (≤ 70); none past one request.
    expect([...synth.calls.at(-1)!.text].length).toBe(FIRST_CJK);
    expect(json(await sayAs('alice', admin.h, 'あ'.repeat(450), 'line-long:1', app, 1)).mode).toBe('voice');
    // (No pause in it: within 2.5× her first breath, cut at that limit.)
    expect([...synth.calls.at(-1)!.text].length).toBe(splitSentences('あ'.repeat(450))[1].length);
    expect(splitSentences('あ'.repeat(450))[1].length).toBeLessThanOrEqual(TTS_SENTENCE_CJK);
    expect(TTS_SENTENCE_CJK).toBeLessThanOrEqual(VOICE_RULES.ttsMaxChars);
  });
});

describe('the TTS relay (tts.internal)', () => {
  it('posts her line and reads the audio with its measured length', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg', 'x-tts-seconds': '1.25' } });
    }) as unknown as typeof fetch;
    const s = relaySynthesizer('http://tts.internal', f)!;
    const out = await s({ star: 'nana', text: 'ねえねえ！', lang: 'ja' });
    expect([out.mime, out.seconds, out.audio.length]).toEqual(['audio/mpeg', 1.25, 3]);
    expect(seen).toEqual([{ url: 'http://tts.internal/synthesize', body: { star: 'nana', text: 'ねえねえ！', lang: 'ja' } }]);
  });

  it('empty relay is provider none; 404 is no provider (or no voice of hers); unmeasured or odd audio is a failure', async () => {
    expect(relaySynthesizer('')).toBeNull();
    const reply = (res: () => Response) => relaySynthesizer('http://tts.internal', (async () => res()) as unknown as typeof fetch)!;
    const req = { star: 'nana' as const, text: 'x', lang: 'ja' as const };
    await expect(reply(() => new Response('', { status: 404 }))(req)).rejects.toMatchObject({ code: 'tts_unavailable' });
    await expect(reply(() => Response.json({ error: 'no_voice' }, { status: 404 }))(req)).rejects.toMatchObject({ code: 'tts_no_voice' });
    await expect(reply(() => new Response('x', { status: 502 }))(req)).rejects.toMatchObject({ code: 'tts_failed' });
    await expect(reply(() => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }))(req)).rejects.toMatchObject({ code: 'tts_failed' });
    await expect(reply(() => new Response('<html>', { headers: { 'content-type': 'text/html', 'x-tts-seconds': '1' } }))(req)).rejects.toMatchObject({ code: 'tts_failed' });
    const down = relaySynthesizer('http://tts.internal', (async () => { throw new Error('refused'); }) as unknown as typeof fetch)!;
    await expect(down(req)).rejects.toMatchObject({ code: 'tts_unavailable' });
  });
});

describe('the Worker\'s TTS relay handler (infra/cloudflare/src/tts.ts)', () => {
  const ask = (body: unknown) => new Request('http://tts.internal/synthesize', { method: 'POST', body: JSON.stringify(body) });
  const line = { star: 'alice', text: '……聴いていて、くださいね。', lang: 'ja' };
  const voices = JSON.stringify({ alice: 'voice-alice-clone' });

  it('is provider none unless a known vendor and its key are both set', () => {
    expect(ttsProvider({})).toBe('none');
    expect(ttsProvider({ TTS_PROVIDER: 'fish' })).toBe('none');
    expect(ttsProvider({ TTS_PROVIDER: 'fish', FISH_API_KEY: 'fk' })).toBe('fish');
    expect(ttsProvider({ TTS_PROVIDER: 'fish', TTS_API_KEY: 'g' })).toBe('fish');
    expect(ttsProvider({ TTS_PROVIDER: 'melotts', TTS_API_KEY: 'k' })).toBe('none');
    expect(ttsProvider({ TTS_PROVIDER: 'ElevenLabs', TTS_API_KEY: 'k' })).toBe('elevenlabs');
    // Each implemented vendor has its own secret; the generic key only counts for the vendor named in TTS_PROVIDER.
    expect(ttsProvider({ TTS_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'dk' })).toBe('qwen');
    expect(ttsProvider({ TTS_PROVIDER: 'qwen', BYTEPLUS_VOICE_API_KEY: 'bk' })).toBe('none');
    expect(keyFor({ TTS_PROVIDER: 'byteplus', TTS_API_KEY: 'g' }, 'byteplus')).toBe('g');
    expect(keyFor({ TTS_PROVIDER: 'byteplus', TTS_API_KEY: 'g' }, 'qwen')).toBeUndefined();
  });

  it('her voice per talent: the default vendor, another vendor for one of them, nothing without that vendor\'s key', () => {
    const env = {
      TTS_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'dk', BYTEPLUS_VOICE_API_KEY: 'bk',
      TTS_VOICES: JSON.stringify({ mahiro: 'qwen-tts-vc-mahiro', nana: { provider: 'byteplus', voice: 'S_nana' }, unpai: { provider: 'melotts', voice: 'x' }, alice: '' })
    };
    expect(voiceFor(env, 'mahiro')).toEqual({ provider: 'qwen', voiceId: 'qwen-tts-vc-mahiro', apiKey: 'dk' });
    expect(voiceFor(env, 'nana')).toEqual({ provider: 'byteplus', voiceId: 'S_nana', apiKey: 'bk' });
    expect([voiceFor(env, 'unpai'), voiceFor(env, 'alice'), voiceFor(env, 'eimi')]).toEqual([null, null, null]);
    expect(ttsStars(env)).toEqual(['mahiro', 'nana']);
    expect(ttsStars({ ...env, BYTEPLUS_VOICE_API_KEY: undefined })).toEqual(['mahiro']);
    expect(ttsStars({ TTS_VOICES: '{not json' })).toEqual([]);
  });

  it('no provider, no voice of hers, an empty vendor slot: nothing is synthesized', async () => {
    expect((await synthesizeRelay(ask(line), {})).status).toBe(404);
    const noVoice = await synthesizeRelay(ask({ ...line, star: 'nana' }), { TTS_PROVIDER: 'fish', TTS_API_KEY: 'k', TTS_VOICES: voices });
    expect([noVoice.status, (await noVoice.json() as { error: string }).error]).toEqual([404, 'no_voice']);
    // Fish Audio / MiniMax / ElevenLabs stay empty slots: 501, and the API shows subtitles.
    expect([TTS_ADAPTERS.minimax, TTS_ADAPTERS.elevenlabs]).toEqual([null, null]);
    expect((await synthesizeRelay(ask(line), { TTS_PROVIDER: 'minimax', TTS_API_KEY: 'k', TTS_VOICES: voices })).status).toBe(501);
    expect((await synthesizeRelay(ask({ ...line, text: 'あ'.repeat(201) }), { TTS_PROVIDER: 'minimax', TTS_API_KEY: 'k', TTS_VOICES: voices })).status).toBe(400);
  });

  it('with an adapter, her cloned voice answers with its length, and the API client reads it', async () => {
    const seen: Parameters<TtsAdapter>[0][] = [];
    const fake: TtsAdapter = async (input) => { seen.push(input); return { audio: new Uint8Array([7, 7, 7]).buffer, mime: 'audio/mpeg', seconds: 1.75 }; };
    const env = { TTS_PROVIDER: 'minimax', TTS_API_KEY: 'secret', TTS_VOICES: voices };
    const viaWorker = (async (url: string, init: RequestInit) => synthesizeRelay(new Request(url, init), env, { ...TTS_ADAPTERS, minimax: fake })) as unknown as typeof fetch;
    const out = await relaySynthesizer('http://tts.internal', viaWorker)!({ star: 'alice', text: line.text, lang: 'ja' });
    expect([out.mime, out.seconds, [...out.audio]]).toEqual(['audio/mpeg', 1.75, [7, 7, 7]]);
    expect(seen.map((s) => [s.voiceId, s.text, s.lang, s.apiKey])).toEqual([['voice-alice-clone', line.text, 'ja', 'secret']]);
  });

  it('PCM becomes a WAV whose length is measured from its samples; a WAV header is read back', () => {
    const { audio, seconds } = wavFromPcm(new Uint8Array(24_000 * 2 * 1.5));
    expect([seconds, audio.byteLength, wavSeconds(audio)]).toEqual([1.5, 44 + 72_000, 1.5]);
    expect(wavSeconds(new TextEncoder().encode('ID3 not a wav').buffer)).toBeNull();
    expect(jsonObjects('{"a":1}\n{"b":"}{"}{"c":{"d":2}} trailing')).toEqual([{ a: 1 }, { b: '}{' }, { c: { d: 2 } }]);
  });

  it('the configured models are the ones in config/models.json', () => {
    const models = JSON.parse(readFileSync(new URL('../../../config/models.json', import.meta.url), 'utf8')) as { voice: Record<string, { model: string }> };
    expect([models.voice.runtimeFish.model, models.voice.runtimeQwen.model, models.voice.runtimeByteplus.model]).toEqual([FISH_TTS_MODEL, QWEN_TTS_MODEL, BYTEPLUS_TTS_RESOURCE]);
  });
});

/** `n` samples of a 440 Hz tone, 24 kHz mono 16-bit little-endian: what both vendors send when asked for PCM. */
function pcm(n: number): Uint8Array {
  const v = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)), true);
  return new Uint8Array(v.buffer);
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
type Call = { url: string; headers: Record<string, string>; body: unknown };
function vendor(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return answer(c);
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe('Qwen3-TTS-VC (Alibaba Cloud Model Studio, international)', () => {
  const audio = pcm(36_000); // 1.5 s
  /**
   * A recorded-shape SSE answer (docs/tts.md): DashScope's `id` / `event:result` / `:HTTP_STATUS/200` / `data:` events,
   * each `data` the documented response object; PCM pieces in `output.audio.data`, the last event `finish_reason:
   * "stop"` with empty data and the whole file's URL.
   */
  const sse = (pieces: Uint8Array[], last: object = {}) => [
    ...pieces.map((p, i) => `id:${i + 1}\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify({
      output: { text: null, finish_reason: null, choices: null, audio: { data: b64(p), url: '', id: 'audio_f4e8139b', expires_at: 0 } },
      usage: { input_tokens: 0, output_tokens: 0, characters: 0 }, request_id: 'f4e8139b-3203-4887-92cb'
    })}\n\n`),
    `id:${pieces.length + 1}\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify({
      output: { text: null, finish_reason: 'stop', choices: null, audio: { data: '', url: 'http://dashscope-result.oss.example/x.wav?Expires=1', id: 'audio_f4e8139b', expires_at: 1766116806 }, ...last },
      usage: { input_tokens: 76, output_tokens: 1045, characters: 0, input_tokens_details: { text_tokens: 76 }, output_tokens_details: { audio_tokens: 1045, text_tokens: 0 }, total_tokens: 1121 },
      request_id: 'f4e8139b-3203-4887-92cb'
    })}\n\n`
  ].join('');

  it('asks for her cloned voice over SSE and returns the PCM as a measured WAV', async () => {
    const v = vendor(() => new Response(sse([audio.subarray(0, 30_000), audio.subarray(30_000)]), { headers: { 'content-type': 'text/event-stream' } }));
    const out = await qwenAdapter({ voiceId: 'qwen-tts-vc-alice-voice-20261002', text: '今晚給我一點時間好嗎？', lang: 'zh-Hant', apiKey: 'sk-test', fetch: v.f });
    expect(v.calls).toEqual([{
      url: 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json', 'x-dashscope-sse': 'enable' },
      body: { model: 'qwen3-tts-vc-2026-01-22', input: { text: '今晚給我一點時間好嗎？', voice: 'qwen-tts-vc-alice-voice-20261002', language_type: 'Chinese' } }
    }]);
    expect([out.mime, out.seconds, out.audio.byteLength, wavSeconds(out.audio)]).toEqual(['audio/wav', 1.5, 44 + audio.length, 1.5]);
    expect(new Uint8Array(out.audio, 44)).toEqual(audio);
    for (const [lang, type] of [['ja', 'Japanese'], ['en', 'English'], ['ko', 'Korean']]) {
      await qwenAdapter({ voiceId: 'v', text: 'x', lang, apiKey: 'k', fetch: v.f, env: { QWEN_TTS_MODEL: 'qwen3-tts-vc-test', DASHSCOPE_BASE_URL: 'https://example.test/api/v1/' } });
      expect(v.calls.at(-1)).toMatchObject({ url: 'https://example.test/api/v1/services/aigc/multimodal-generation/generation', body: { model: 'qwen3-tts-vc-test', input: { language_type: type } } });
    }
  });

  it('an error event, an HTTP error or no audio at all is a failure; a stream without pieces falls back to the measured file', async () => {
    const err = vendor(() => new Response(`id:1\nevent:error\n:HTTP_STATUS/400\ndata:{"code":"InvalidParameter","message":"voice not found","request_id":"r"}\n\n`));
    await expect(qwenAdapter({ voiceId: 'v', text: 'x', lang: 'ja', apiKey: 'k', fetch: err.f })).rejects.toThrow('qwen InvalidParameter');
    const http = vendor(() => Response.json({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, { status: 401 }));
    await expect(qwenAdapter({ voiceId: 'v', text: 'x', lang: 'ja', apiKey: 'k', fetch: http.f })).rejects.toThrow('qwen 401');
    const file = wavFromPcm(pcm(12_000));
    const viaUrl = vendor((c) => (c.url.includes('oss.example') ? new Response(file.audio, { headers: { 'content-type': 'audio/wav' } }) : new Response(sse([]))));
    const out = await qwenAdapter({ voiceId: 'v', text: 'x', lang: 'ja', apiKey: 'k', fetch: viaUrl.f });
    expect([out.seconds, viaUrl.calls.map((c) => c.url.split('?')[0])]).toEqual([0.5, ['https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', 'http://dashscope-result.oss.example/x.wav']]);
  });

  it('through the relay and the API client: her seconds arrive measured, and a vendor failure is a 502 that becomes subtitles', async () => {
    const env = { TTS_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'sk-test', TTS_VOICES: voicesJson };
    const ok = vendor(() => new Response(sse([audio])));
    const viaWorker = (async (url: string, init: RequestInit) => synthesizeRelay(new Request(url, init), env, TTS_ADAPTERS, ok.f)) as unknown as typeof fetch;
    const out = await relaySynthesizer('http://tts.internal', viaWorker)!({ star: 'mahiro', text: 'ただいま。', lang: 'ja' });
    expect([out.mime, out.seconds, out.audio.length]).toEqual(['audio/wav', 1.5, 44 + audio.length]);
    const bad = vendor(() => new Response('', { status: 500 }));
    const failing = (async (url: string, init: RequestInit) => synthesizeRelay(new Request(url, init), env, TTS_ADAPTERS, bad.f)) as unknown as typeof fetch;
    await expect(relaySynthesizer('http://tts.internal', failing)!({ star: 'mahiro', text: 'ただいま。', lang: 'ja' })).rejects.toMatchObject({ code: 'tts_failed' });
    // Her words never reach a log line.
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await synthesizeRelay(ask({ star: 'mahiro', text: 'ひみつの言葉', lang: 'ja' }), env, TTS_ADAPTERS, bad.f);
    expect(logged.mock.calls.flat().join(' ')).not.toContain('ひみつ');
    logged.mockRestore();
  });
});
const voicesJson = JSON.stringify({ mahiro: 'qwen-tts-vc-mahiro-voice-20261002' });
const ask = (body: unknown) => new Request('http://tts.internal/synthesize', { method: 'POST', body: JSON.stringify(body) });

describe('Seed Speech Voice Replication 2.0 (BytePlus)', () => {
  const audio = pcm(48_000); // 2 s
  /** The documented stream: `{code: 0, data: <base64>}` objects, then `{code: 20000000, message: "ok", data: null}`. */
  const stream = (pieces: Uint8Array[], end: object = { code: 20000000, message: 'ok', data: null }) =>
    [...pieces.map((p) => JSON.stringify({ code: 0, message: '', data: b64(p) })), JSON.stringify(end)].join('\n');

  it('asks for her SpeakerID on seed-icl-2.0 and returns the PCM as a measured WAV', async () => {
    const v = vendor(() => new Response(stream([audio.subarray(0, 50_000), audio.subarray(50_000)]), { headers: { 'x-tt-logid': '202407261553070FACFE6D19421815D605' } }));
    const out = await byteplusAdapter({ voiceId: 'S_alice01', text: '오늘 밤, 잠깐만 시간 내 줘.', lang: 'ko', apiKey: 'bp-test', fetch: v.f });
    expect(v.calls).toHaveLength(1);
    const c = v.calls[0];
    expect(c.url).toBe('https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional');
    expect(c.headers).toMatchObject({ 'x-api-key': 'bp-test', 'x-api-resource-id': 'seed-icl-2.0', 'x-api-app-key': 'aGjiRDfUWi', 'content-type': 'application/json' });
    expect(c.headers['x-api-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const req = (c.body as { req_params: { text: string; speaker: string; audio_params: object; additions: string } }).req_params;
    expect([req.text, req.speaker, req.audio_params]).toEqual(['오늘 밤, 잠깐만 시간 내 줘.', 'S_alice01', { format: 'pcm', sample_rate: 24_000 }]);
    expect(JSON.parse(req.additions)).toEqual({ explicit_language: 'ko', disable_markdown_filter: true });
    expect([out.mime, out.seconds, wavSeconds(out.audio)]).toEqual(['audio/wav', 2, 2]);
    expect(new Uint8Array(out.audio, 44)).toEqual(audio);
  });

  it('maps her languages and fails on an error code or a stream that never ends', async () => {
    for (const [lang, code] of [['ja', 'ja'], ['zh-Hant', 'zh-cn'], ['en', 'en']]) {
      const v = vendor(() => new Response(stream([audio])));
      await byteplusAdapter({ voiceId: 'S_x', text: 'x', lang, apiKey: 'k', fetch: v.f });
      expect(JSON.parse((v.calls[0].body as { req_params: { additions: string } }).req_params.additions).explicit_language).toBe(code);
    }
    const denied = vendor(() => new Response(stream([], { code: 45000000, message: 'speaker permission denied: get resource id: access denied', data: null })));
    await expect(byteplusAdapter({ voiceId: 'S_x', text: 'x', lang: 'ja', apiKey: 'k', fetch: denied.f })).rejects.toThrow('byteplus 45000000');
    const cut = vendor(() => new Response(JSON.stringify({ code: 0, message: '', data: b64(audio) })));
    await expect(byteplusAdapter({ voiceId: 'S_x', text: 'x', lang: 'ja', apiKey: 'k', fetch: cut.f })).rejects.toThrow('incomplete');
    const http = vendor(() => new Response('{"code":45000010}', { status: 401 }));
    await expect(byteplusAdapter({ voiceId: 'S_x', text: 'x', lang: 'ja', apiKey: 'k', fetch: http.f })).rejects.toThrow('byteplus 401');
  });
});

describe('Traditional → Simplified (what a vendor may read for zh-Hant)', () => {
  it('converts character by character and leaves everything else alone', () => {
    expect(toSimplified('這一個星期，每天晚上聽你說「我回來了」。OK?')).toBe('这一个星期，每天晚上听你说「我回来了」。OK?');
    expect(toSimplified('ただいま、まひろ')).toBe('ただいま、まひろ');
  });
});

describe('who has a runtime voice (TTS_STARS, /v1/config)', () => {
  beforeEach(() => {
    repos = createMemoryRepos({ cards: SEED_CARDS });
    synth = { calls: [], answer: async () => ({ audio: Buffer.from('RIFF-audio'), mime: 'audio/wav', seconds: 1.2 }) };
  });

  it('/v1/config says whether her runtime voice exists here and for whom; off reports nothing', async () => {
    const on = await buildApp({ repos, logger: false, demo: true, synthesize: fakeSynth, ttsStars: ['mahiro', 'nana'] });
    expect(json(await on.inject({ url: '/v1/config' }))).toMatchObject({ voice: true, voiceStars: ['mahiro', 'nana'] });
    const off = await buildApp({ repos, logger: false, demo: true, synthesize: null });
    expect(json(await off.inject({ url: '/v1/config' }))).toMatchObject({ voice: false, voiceStars: [] });
  });

  it('he hears only the talents with a voice; one without is never asked for nor charged', async () => {
    app = await buildApp({ repos, logger: false, demo: true, synthesize: fakeSynth, ttsStars: ['mahiro'] });
    const admin = await member({ role: 'admin' });
    expect(await voice(admin.h)).toMatchObject({ tts: true, ttsStars: ['mahiro'] });
    const user = await member();
    expect(await voice(user.h)).toMatchObject({ tts: true, ttsStars: ['mahiro'] });
    expect(json(await say(admin.h, 'こんばんは', 'line-nostar:0'))).toEqual({ mode: 'subtitle', reason: 'no_voice', leftSeconds: FREE });
    expect(synth.calls).toHaveLength(0);
    expect(json(await sayAs('mahiro', admin.h, 'おかえり', 'line-mahiro:0')).mode).toBe('voice');
    expect(synth.calls).toEqual([{ star: 'mahiro', text: 'おかえり', lang: 'ja' }]);
    expect((await voice(admin.h)).usedSeconds).toBe(2);
    // A relay with no talent configured is no runtime voice at all.
    const none = await buildApp({ repos, logger: false, demo: true, synthesize: fakeSynth, ttsStars: [] });
    expect((await voice(admin.h, none)).tts).toBe(false);
  });
});

/**
 * `n` MPEG-1 Layer III frames, 44.1 kHz mono 64 kbps (what Fish sends for format mp3, mp3_bitrate 64): 4-byte headers
 * (FF FB 50 C4, padding bit set on every third frame) and zeroed payloads. Optionally an ID3v2 tag and an Info frame
 * in front, as encoders write them.
 */
function mp3(n: number, o: { id3?: boolean; info?: boolean } = {}): Uint8Array {
  const parts: number[] = [];
  if (o.id3) parts.push(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0));
  const frame = (pad: number, info = false) => {
    const len = 208 + pad;
    const f = new Array(len).fill(0);
    f[0] = 0xff; f[1] = 0xfb; f[2] = 0x50 | (pad << 1); f[3] = 0xc4;
    if (info) 'Info'.split('').forEach((c, i) => { f[4 + 17 + i] = c.charCodeAt(0); });
    return f;
  };
  if (o.info) parts.push(...frame(0, true));
  for (let i = 0; i < n; i++) parts.push(...frame(i % 3 === 2 ? 1 : 0));
  return new Uint8Array(parts);
}

describe('Fish Audio (s2.1-pro)', () => {
  const take = mp3(100, { id3: true, info: true }); // 100 × 1152 / 44100 s
  const secs = (100 * 1152) / 44100;

  it('MP3 duration is counted from its frames; a tag and the Info frame carry no sound', () => {
    expect(mp3Seconds(take.buffer as ArrayBuffer)).toBeCloseTo(secs, 6);
    expect(mp3Seconds(mp3(38).buffer as ArrayBuffer)).toBeCloseTo((38 * 1152) / 44100, 6);
    expect(mp3Seconds(new TextEncoder().encode('{"status":402,"message":"Insufficient balance"}').buffer)).toBeNull();
  });

  it('asks for her voice model in MP3 and measures what came back (a chunked body)', async () => {
    const v = vendor(() => new Response(new ReadableStream({
      start(c) { c.enqueue(take.subarray(0, 1000)); c.enqueue(take.subarray(1000)); c.close(); }
    }), { headers: { 'content-type': 'audio/mpeg', 'transfer-encoding': 'chunked' } }));
    const out = await fishAdapter({ voiceId: 'b1c4f2d0e9a8', text: 'Give me a little time tonight?', lang: 'en', apiKey: 'fish-test', fetch: v.f });
    expect(v.calls).toEqual([{
      url: 'https://api.fish.audio/v1/tts',
      headers: { authorization: 'Bearer fish-test', 'content-type': 'application/json', model: 's2.1-pro' },
      body: { text: 'Give me a little time tonight?', reference_id: 'b1c4f2d0e9a8', format: 'mp3', mp3_bitrate: 64, latency: 'balanced', normalize: true }
    }]);
    expect([out.mime, out.audio.byteLength]).toEqual(['audio/mpeg', take.length]);
    expect(out.seconds).toBeCloseTo(secs, 6);
    await fishAdapter({ voiceId: 'v', text: '今晚給我一點時間好嗎？', lang: 'zh-Hant', apiKey: 'k', fetch: v.f, env: { FISH_TTS_MODEL: 's2.1-pro-free', FISH_TTS_LATENCY: 'low', FISH_ZH_HINT: 'off' } });
    expect(v.calls.at(-1)).toMatchObject({ headers: { model: 's2.1-pro-free' }, body: { text: '今晚給我一點時間好嗎？', latency: 'low' } });
  });

  it('no API credit (402), a bad key or an empty answer is a failure, and the relay turns it into subtitles', async () => {
    const broke = vendor(() => Response.json({ status: 402, message: 'Insufficient balance' }, { status: 402 }));
    await expect(fishAdapter({ voiceId: 'v', text: 'x', lang: 'ja', apiKey: 'k', fetch: broke.f })).rejects.toThrow('fish 402');
    const empty = vendor(() => new Response(new Uint8Array(0), { headers: { 'content-type': 'audio/mpeg' } }));
    await expect(fishAdapter({ voiceId: 'v', text: 'x', lang: 'ja', apiKey: 'k', fetch: empty.f })).rejects.toThrow('no audio');
    const env = { TTS_PROVIDER: 'fish', FISH_API_KEY: 'fish-test', TTS_VOICES: JSON.stringify({ eimi: 'b1c4f2d0e9a8' }) };
    const ok = vendor(() => new Response(take));
    const viaWorker = (async (url: string, init: RequestInit) => synthesizeRelay(new Request(url, init), env, TTS_ADAPTERS, ok.f)) as unknown as typeof fetch;
    const out = await relaySynthesizer('http://tts.internal', viaWorker)!({ star: 'eimi', text: 'おかえり。', lang: 'ja' });
    expect([out.mime, Math.abs(out.seconds - secs) < 0.001]).toEqual(['audio/mpeg', true]);
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = (async (url: string, init: RequestInit) => synthesizeRelay(new Request(url, init), env, TTS_ADAPTERS, broke.f)) as unknown as typeof fetch;
    await expect(relaySynthesizer('http://tts.internal', failing)!({ star: 'eimi', text: 'おかえり。', lang: 'ja' })).rejects.toMatchObject({ code: 'tts_failed' });
    expect(logged.mock.calls.flat().join(' ')).toContain('fish 402');
    logged.mockRestore();
  });
});

describe('her Mandarin on Fish (zh-Hant experiments, docs/tts.md)', () => {
  it('drawn-out marks and ellipses become plain pauses; her words stay as written', () => {
    expect(mandarinPauses('早～安～！……起床了嗎？起來了就回我一聲！')).toBe('早安！起床了嗎？起來了就回我一聲！');
    expect(mandarinPauses('……就算你用那種表情拜託，也不行。……不行，是不行……可是。')).toBe('就算你用那種表情拜託，也不行。不行，是不行，可是。');
    expect(mandarinPauses('欸，今晚……我有件事想好好跟你說。')).toBe('欸，今晚，我有件事想好好跟你說。');
    expect(mandarinPauses('……')).toBe('……');
  });

  it('Fish gets the Mandarin cue before a zh-Hant line (unless FISH_ZH_HINT=off); other languages and vendors as written', async () => {
    const v = vendor(() => new Response(mp3(10)));
    await fishAdapter({ voiceId: 'v', text: '早～安～！……起床了嗎？', lang: 'zh-Hant', apiKey: 'k', fetch: v.f });
    expect((v.calls[0].body as { text: string }).text).toBe(`${FISH_ZH_HINT}早安！起床了嗎？`);
    await fishAdapter({ voiceId: 'v', text: 'おはよう……', lang: 'ja', apiKey: 'k', fetch: v.f });
    expect((v.calls[1].body as { text: string }).text).toBe('おはよう……');
    const q = vendor(() => new Response(''));
    await qwenAdapter({ voiceId: 'v', text: '早～安～！', lang: 'zh-Hant', apiKey: 'k', fetch: q.f }).catch(() => undefined);
    expect((q.calls[0].body as { input: { text: string } }).input.text).toBe('早～安～！');
  });

  it('a "<star>:<lang>" voice wins for that language: her Mandarin on another voice or vendor', async () => {
    const env = {
      TTS_PROVIDER: 'fish', FISH_API_KEY: 'fk', DASHSCOPE_API_KEY: 'dk',
      TTS_VOICES: JSON.stringify({ mahiro: 'fish-mahiro', 'mahiro:zh-Hant': { provider: 'qwen', voice: 'qwen-mahiro' }, 'nana:zh-Hant': 'fish-nana-zh' })
    };
    expect(voiceFor(env, 'mahiro', 'zh-Hant')).toEqual({ provider: 'qwen', voiceId: 'qwen-mahiro', apiKey: 'dk' });
    expect(voiceFor(env, 'mahiro', 'ja')).toEqual({ provider: 'fish', voiceId: 'fish-mahiro', apiKey: 'fk' });
    // A language-only entry does not give her a voice in the others.
    expect([voiceFor(env, 'nana', 'zh-Hant')?.voiceId, voiceFor(env, 'nana', 'ja')]).toEqual(['fish-nana-zh', null]);
    expect(ttsStars(env)).toEqual(['mahiro']);
    // Through the relay: the zh-Hant request goes to Qwen with Qwen's key, the Japanese one to Fish.
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(String(url));
      return String(url).includes('fish') ? new Response(mp3(10)) : new Response(`data:${JSON.stringify({ output: { audio: { data: Buffer.from(pcm(2400)).toString('base64') } } })}\n\n`);
    }) as unknown as typeof fetch;
    for (const lang of ['zh-Hant', 'ja']) expect((await synthesizeRelay(ask({ star: 'mahiro', text: '早安。', lang }), env, TTS_ADAPTERS, f)).status).toBe(200);
    expect(seen.map((u) => (u.includes('fish') ? 'fish' : 'qwen'))).toEqual(['qwen', 'fish']);
  });
});

describe('the Worker relay streams Fish through (POST /stream, first sound)', () => {
  it('pipes Fish\'s chunked MP3 untouched for a Fish voice; another vendor cannot stream (501); bad requests are refused', async () => {
    const body = mp3(30);
    const v = vendor(() => new Response(new ReadableStream({ start(c) { c.enqueue(body.subarray(0, 100)); c.enqueue(body.subarray(100)); c.close(); } }), { headers: { 'content-type': 'audio/mpeg' } }));
    const env = { TTS_PROVIDER: 'fish', FISH_API_KEY: 'fk', DASHSCOPE_API_KEY: 'dk', TTS_VOICES: JSON.stringify({ eimi: 'fish-eimi', alice: { provider: 'qwen', voice: 'q' } }) };
    const streamReq = (b: unknown) => new Request('http://tts.internal/stream', { method: 'POST', body: JSON.stringify(b) });
    const res = await synthesizeRelay(streamReq({ star: 'eimi', text: 'おかえり。', lang: 'ja' }), env, TTS_ADAPTERS, v.f);
    expect([res.status, res.headers.get('content-type'), res.headers.get('x-tts-seconds')]).toEqual([200, 'audio/mpeg', null]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    expect(v.calls[0]).toMatchObject({ url: 'https://api.fish.audio/v1/tts', body: { text: 'おかえり。', reference_id: 'fish-eimi', format: 'mp3' } });
    expect((await synthesizeRelay(streamReq({ star: 'alice', text: 'x', lang: 'ja' }), env, TTS_ADAPTERS, v.f)).status).toBe(501);
    expect((await synthesizeRelay(streamReq({ star: 'nana', text: 'x', lang: 'ja' }), env, TTS_ADAPTERS, v.f)).status).toBe(404);
    expect((await synthesizeRelay(streamReq({ star: 'eimi', text: 'あ'.repeat(201), lang: 'ja' }), env, TTS_ADAPTERS, v.f)).status).toBe(400);
    const broke = vendor(() => Response.json({ status: 402, message: 'Insufficient balance' }, { status: 402 }));
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await synthesizeRelay(streamReq({ star: 'eimi', text: 'x', lang: 'ja' }), env, TTS_ADAPTERS, broke.f)).status).toBe(502);
    logged.mockRestore();
  });
});

describe('local preview uses the production Fish adapter without exposing its key', () => {
  it('stays off without an authorized voice and streams a configured talent through the API bridge', async () => {
    expect(localTts({})).toEqual({ synthesize: null, streamSynthesize: null, stars: [] });
    const body = mp3(4);
    const vendorFetch = (async () => new Response(body, { headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch;
    const voice = localTts({ TTS_PROVIDER: 'fish', FISH_API_KEY: 'server-only', TTS_VOICES: JSON.stringify({ eimi: 'fish-eimi' }) }, vendorFetch);
    expect(voice.stars).toEqual(['eimi']);
    expect(voice.synthesize).toBeTypeOf('function');
    expect(voice.streamSynthesize).toBeTypeOf('function');
    const stream = await voice.streamSynthesize!({ star: 'eimi', text: 'おかえり。', lang: 'ja' }, new AbortController().signal);
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(body);
  });
});
