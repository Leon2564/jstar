import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { routineMatches, type StarId } from '@jstar/shared';
import { wokenLine } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { agentRoutine } from '../src/lib/herWorld';
import { triggerContext } from '../src/lib/sceneTriggers';
import { createSqliteClient } from './sqlite';

/**
 * Five lives on their own clocks (#60), as the API uses them: her greeting when he wakes her, what the persona service
 * is told each turn, and the routine a scene trigger is checked against. Every read goes through world.ts `routineNow`.
 */
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[] }));
vi.mock('../src/lib/agent', () => {
  const answer = (input: Record<string, unknown>) => {
    agent.inputs.push(input);
    return { reply: `echo:${String(input.text)}`, blocked: false, boundary: null, memory: null, cardTitle: null };
  };
  return {
    askPersona: async (input: Record<string, unknown>) => answer(input),
    streamPersona: async function* (input: Record<string, unknown>) {
      const r = answer(input);
      yield { type: 'delta', text: r.reply };
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null };
    },
    greetPersona: async (input: Record<string, unknown>) => {
      agent.greetings.push(input);
      return `greet:${String(input.status)}:${agent.greetings.length}`;
    }
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const json = (res: { payload: string }) => JSON.parse(res.payload);
/** A JST wall-clock moment, whatever zone the test machine is in. */
const jst = (hhmm: string, day = '2026-10-14') => Date.parse(`${day}T${hhmm}:00+09:00`);

describe.each(BACKENDS)('her routine (%s store)', (_name, makeRepos) => {
  let repos: Repos;
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: jst('21:00') });
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: false });
    agent.inputs.length = 0;
    agent.greetings.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  async function member(lang: 'ja' | 'en' | 'zh-Hant' = 'ja') {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang }));
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
  }
  const greet = async (h: Record<string, string>, star: StarId, lang = 'ja') => json(await app.inject({ url: `/v1/chat/greeting?star=${star}&lang=${lang}`, headers: h }));

  it('at 03:00 JST 奈々 is asleep: her room opens on her woken line, never the model, and she can still be talked to', async () => {
    const { h } = await member();
    vi.setSystemTime(jst('03:00'));
    const first = await greet(h, 'nana');
    // Snapshot of the acceptance line (#60): her own words, in her voice, never a system message.
    expect(first).toEqual({ text: 'ふぁ……びっくりした。本読みながら寝ちゃってたみたい。……起こしてくれて、ありがと。', cached: false });
    expect(first.text).toBe(wokenLine('nana', '2026-10-14').ja);
    expect((await greet(h, 'nana', 'en')).text).toBe(wokenLine('nana', '2026-10-14').en);
    expect(agent.greetings).toHaveLength(0);
    // Her room is open all the same: she answers — sleepily, as the persona service is told.
    const res = await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'nana', text: 'おきてる？', lang: 'ja' } });
    expect(res.statusCode).toBe(200);
    expect(agent.inputs[0]).toMatchObject({ presence: 'asleep', status: 'Already asleep' });
    // Awake in the same hour: まひろ greets with the model, told what she is doing.
    expect(await greet(h, 'mahiro')).toEqual({ text: 'greet:At home:1', cached: false });
    expect(agent.greetings[0]).toMatchObject({ presence: 'home', status: 'At home' });
  });

  it('tells the persona service what she is doing now, in every turn and for visitors too', async () => {
    const { h } = await member();
    await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'unpai', text: 'hi', lang: 'ja' } });
    expect(agent.inputs[0]).toMatchObject({ presence: 'out', status: 'Streaming a late-night walk' });
    vi.setSystemTime(jst('07:30'));
    await app.inject({ method: 'POST', url: '/v1/chat/trial', headers: { 'x-device-id': 'dev-routine-1' }, payload: { star: 'eimi', text: 'hi', lang: 'ja' } });
    expect(agent.inputs[1]).toMatchObject({ presence: 'out', status: 'Working out' });
    expect(agentRoutine('alice', new Date(jst('07:30')))).toEqual({ presence: 'asleep', status: 'Fast asleep' });
  });

  it('keeps one greeting per part of her day: tonight she is not doing what she did this morning', async () => {
    const { user, h } = await member();
    vi.setSystemTime(jst('08:00'));
    expect(await greet(h, 'eimi')).toEqual({ text: 'greet:Working out:1', cached: false });
    expect(await greet(h, 'eimi')).toEqual({ text: 'greet:Working out:1', cached: true });
    vi.setSystemTime(jst('19:00'));
    expect(await greet(h, 'eimi')).toEqual({ text: 'greet:Ōgiri time:2', cached: false });
    expect((await repos.chatMemory.get(user.id, 'eimi'))?.greeting?.lang).toBe('ja@evening~sky-unknown~first');
  });

  it('checks a scene trigger against her routine now', async () => {
    const { user } = await member();
    const at = async (hhmm: string) => (await triggerContext(app, user, 'unpai', jst(hhmm))).routine!;
    expect(routineMatches('walk-stream', await at('21:30'))).toBe(true);
    expect(routineMatches('walk-stream', await at('01:00'))).toBe(false);
    expect(await at('01:00')).toMatchObject({ presence: 'home', activity: 'chat' });
    expect(await at('09:00')).toMatchObject({ presence: 'asleep' });
  });
});
