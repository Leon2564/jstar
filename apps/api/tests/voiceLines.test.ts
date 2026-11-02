import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { localText, splitSentences } from '@jstar/shared';
import type { LineStep } from '@jstar/shared/scenes/schema';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { lineSigned, signLine } from '../src/lib/voiceLines';
import type { Synthesize } from '../src/lib/tts';

/**
 * Only her own words in her voice (#73, docs/requirements.md §13.6): the server signs the lines it gives her — her chat
 * reply, her scene lines a runtime voice may say — and /v1/tts speaks those and nothing else.
 */
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => ({ reply: `うん、${input.text.slice(0, 10)}だね。また話そう？`, blocked: false, boundary: null, memory: null, cardTitle: null }),
  streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
  greetPersona: async () => 'hi'
}));
vi.mock('../src/lib/minigameJudge', () => ({ judgeMinigame: async () => null }));

let app: FastifyInstance;
let repos: Repos;
const spoken: string[] = [];
const synth: Synthesize = async (r) => { spoken.push(r.text); return { audio: Buffer.from('ID3'), mime: 'audio/mpeg', seconds: 1.1 }; };
const json = (res: { payload: string }) => JSON.parse(res.payload);

async function member() {
  const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'ken', via: 'email', lang: 'ja' }));
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 86_400)}` } };
}

beforeEach(async () => {
  repos = createMemoryRepos({ cards: SEED_CARDS });
  spoken.length = 0;
  app = await buildApp({ repos, logger: false, demo: true, synthesize: synth, ttsStars: ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] });
});
afterEach(async () => { await app.close(); });

describe('her own words, signed (#73)', () => {
  it('her chat reply comes with its signature, and that reply — only that — is spoken, sentence by sentence', async () => {
    const { h } = await member();
    const r = json(await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'mahiro', text: '今日は雨だった' } }));
    expect(r.voiceSig).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const n = splitSentences(r.reply).length;
    expect(n).toBe(2);
    for (let i = 0; i < n; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/tts', headers: h, payload: { star: 'mahiro', line: r.reply, sig: r.voiceSig, index: i, requestId: `line-chat:${i}` } });
      expect(json(res).mode).toBe('voice');
    }
    expect(spoken).toEqual(splitSentences(r.reply).map((s) => s.trim()));
    // His own words with her reply's signature: refused.
    const his = await app.inject({ method: 'POST', url: '/v1/tts', headers: h, payload: { star: 'mahiro', line: '今日は雨だった', sig: r.voiceSig, index: 0, requestId: 'line-his:0' } });
    expect([his.statusCode, json(his).error]).toEqual([403, 'not_her_line']);
  });

  it('an English reply is spoken sentence by sentence too, cut exactly as the web app cuts it', async () => {
    const { user, h } = await member();
    const line = "Hey… tonight, there's something I want to tell you properly. Will you come back this evening? Mr. Tanaka says hi.";
    const sig = signLine(user.id, 'alice', line);
    const want = splitSentences(line);
    expect(want).toEqual(['Hey… tonight,', "there's something I want to tell you properly.", 'Will you come back this evening?', 'Mr. Tanaka says hi.']);
    for (let i = 0; i < want.length; i++) {
      expect(json(await app.inject({ method: 'POST', url: '/v1/tts', headers: h, payload: { star: 'alice', line, sig, index: i, lang: 'en', requestId: `line-en:${i}` } })).mode).toBe('voice');
    }
    expect(spoken).toEqual(want);
  });

  it('no runtime voice on the server: her reply carries no signature', async () => {
    const off = await buildApp({ repos, logger: false, demo: true, synthesize: null });
    const { h } = await member();
    const r = json(await off.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'mahiro', text: 'ただいま' } }));
    expect(r.voiceSig).toBeUndefined();
    await off.close();
  });

  it('a scene run signs the lines her runtime voice may say, per language, for him only', async () => {
    const { user, h } = await member();
    const step = async (payload: object) => {
      const res = await app.inject({ method: 'POST', url: '/v1/scene/step', headers: h, payload });
      expect(res.statusCode, res.payload).toBe(200);
      return json(res).run;
    };
    // mahiro's demo evening, up to her free talk (choices answered with their first option), then one free turn.
    const started = await app.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'demo-evening' } });
    expect(started.statusCode, started.payload).toBe(200);
    let run = json(started).run;
    const seen: { beat: LineStep; sigs: Record<string, string> }[] = [];
    const collect = (v: { beats: LineStep[]; voiceSigs?: Record<string, Record<string, string>> }) => {
      for (const b of v.beats) if (v.voiceSigs?.[b.id]) seen.push({ beat: b, sigs: v.voiceSigs[b.id] });
    };
    collect(run);
    for (let n = 0; n < 12 && run.waiting && !(run.waiting.type === 'input' && run.waiting.mode === 'free'); n++) {
      run = await step({ runId: run.id, seq: run.seq, choice: run.waiting.options[0].id });
      collect(run);
    }
    expect(run.waiting).toMatchObject({ type: 'input', mode: 'free' });
    run = await step({ runId: run.id, seq: run.seq, input: 'こんばんは、今日は何してた？' });
    collect(run);
    expect(seen.some((x) => x.beat.agent)).toBe(true);
    for (const { beat, sigs } of seen) {
      expect(beat.tts || beat.agent || /\{(name|danmaku)\}/.test(beat.text.ja)).toBeTruthy();
      for (const lang of ['ja', 'zh-Hant', 'en', 'ko']) expect(lineSigned(user.id, 'mahiro', localText(beat.text, lang).trim(), sigs[lang])).toBe(true);
    }
    const other = await member();
    expect(lineSigned(other.user.id, 'mahiro', localText(seen[0].beat.text, 'ja').trim(), seen[0].sigs.ja)).toBe(false);
  });
});
