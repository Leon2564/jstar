import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SceneRunViewT } from '@jstar/shared/contracts';
import type { SceneScript } from '@jstar/shared/scenes';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { ApiError } from '../../src/services/http';
import { answerTarget, answeredAt, leftOver, tookIt } from '../../src/scene/client';

// D-M3 / D-N2 (area D re-test of v1.1.2): his answer given over her lines (#72) to the step she is on her way to.
// The API is mocked; it decides, and each call is checked for the step and the seq it names.
const api = vi.hoisted(() => ({ scenePreview: vi.fn(), sceneStart: vi.fn(), sceneStep: vi.fn(), sceneCurrent: vi.fn(), sceneRun: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => true,
  http: { scenePreview: api.scenePreview, sceneStart: api.sceneStart, sceneStep: api.sceneStep, sceneCurrent: api.sceneCurrent, sceneRun: api.sceneRun }
}));
vi.mock('../../src/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api')>()),
  serverMode: () => true,
  isDemo: () => true,
  bondOf: async () => null,
  bootstrap: async () => ({ kind: 'guest' })
}));

const w = window as unknown as { __E2E__: boolean; __SCENE_TIME_SCALE__?: number };
beforeAll(() => { w.__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); w.__SCENE_TIME_SCALE__ = 0.05; });
afterEach(() => { cleanup(); vi.clearAllMocks(); delete w.__SCENE_TIME_SCALE__; });

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
const SAY = '想對姐姐說什麼？';
/** ōgiri's last steps, as in sig-ogiri: her lines on the way to 「say」 (free, 8 s), her reply, then 「scent」 (30 s). */
const OGIRI = {
  meta: { id: 'ogiri-steps', star: 'eimi', title: T('大喜利'), trigger: { slots: ['night'] }, idle: 'eimi-hero', draft: true },
  steps: [
    { id: 'wide', type: 'clip', shot: 'wide', media: 'eimi-hero', hold: 0 },
    { id: 'passed', type: 'line', text: T('……不錯嘛。及格了。') },
    { id: 'change', type: 'line', text: T('我去換個衣服，等我一下。') },
    { id: 'peek', type: 'line', text: T('……你真的沒有偷看吧？') },
    { id: 'how', type: 'line', text: T('……怎麼樣？這可是獎勵，要好好看著。') },
    { id: 'say', type: 'input', mode: 'free', prompt: T(SAY), timeout: 8, next: 'said', onTimeout: 'said' },
    { id: 'said', type: 'line', text: T('呵呵，謝謝。') },
    { id: 'perfume', type: 'line', text: T('……欸，你發現了嗎？我換了香水。') },
    { id: 'scent', type: 'choice', timeout: 30, onTimeout: 'hug', options: [{ id: 'nice', label: T('好香'), next: 'hug' }, { id: 'suits', label: T('很適合妳'), next: 'hug' }] },
    { id: 'hug', type: 'line', text: T('……過來。') },
    { id: 'end-hug', type: 'end', outcome: 'hug' }
  ]
} as unknown as SceneScript;
const st = (id: string) => OGIRI.steps.find((s) => s.id === id)! as SceneRunViewT['beats'][number];
const beats = (...ids: string[]) => ids.map(st) as SceneRunViewT['beats'];
const view = (patch: Partial<SceneRunViewT> = {}): SceneRunViewT => ({
  id: 'scn_1', sceneId: 'ogiri-steps', star: 'eimi', seq: 0, status: 'active', outcome: null,
  startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString(), endedAt: null,
  beats: beats('wide', 'passed', 'change', 'peek', 'how', 'say'), waiting: st('say') as SceneRunViewT['waiting'], waitingSince: new Date().toISOString(),
  upcoming: [], timerEndsAt: null, rewardable: true, rewards: { affinity: 0, variantXp: 0, memories: [], promises: [] }, result: null, affinityXp: 0,
  ...patch
});
const reply = { id: 'say~reply', type: 'line', text: T('呵呵，被你這樣說，我會害羞的。'), agent: true } as unknown as SceneRunViewT['beats'][number];
const afterSay = () => view({ seq: 1, beats: [reply, ...beats('said', 'perfume', 'scent')], waiting: st('scent') as SceneRunViewT['waiting'] });
const ended = () => view({ seq: 2, status: 'ended', outcome: 'hug', endedAt: new Date().toISOString(), beats: beats('hug', 'end-hug'), waiting: null });

const renderScene = () => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, lang: 'ja', user: { via: 'email', nickname: 'kenta' }, star: 'eimi' }}>
    <MemoryRouter initialEntries={['/me/scene/ogiri-steps?preview=1']}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);
const deferred = <V,>() => { let resolve!: (v: V) => void; const p = new Promise<V>((r) => { resolve = r; }); return { p, resolve }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the seq bookkeeping (D-N2)', () => {
  const run = { seq: 3, waiting: { id: 'scent' } } as Pick<SceneRunViewT, 'seq' | 'waiting'>;
  it('an answer is for the wait on screen at the seq the scene came to it, else for the run\'s next wait at its seq', () => {
    expect(answerTarget({ id: 'say', seq: 2 }, run)).toEqual({ id: 'say', seq: 2 });
    expect(answerTarget(null, run)).toEqual({ id: 'scent', seq: 3 });
    expect(answerTarget(null, { seq: 4, waiting: null })).toBeNull();
  });
  it('a wait he answered over her lines is not put up again at that seq — only at a new one (free talk goes on)', () => {
    expect(answeredAt({ id: 'say', seq: 2 }, 'say', 2)).toBe(true);
    expect(answeredAt({ id: 'say', seq: 2 }, 'say', 3)).toBe(false);
    expect(answeredAt({ id: 'say', seq: 2 }, 'scent', 2)).toBe(false);
    expect(answeredAt(null, 'say', 2)).toBe(false);
  });
  it('an answer to a step the run is past is a leftover; a 409 with the run past the step means it was taken', () => {
    expect(leftOver({ id: 'say', seq: 2 }, run)).toBe(true);
    expect(leftOver({ id: 'scent', seq: 3 }, run)).toBe(false);
    expect(tookIt({ id: 'say', seq: 2 }, { seq: 3 })).toBe(true);
    expect(tookIt({ id: 'scent', seq: 3 }, { seq: 3 })).toBe(false);
    expect(tookIt({ id: 'scent', seq: 3 }, null)).toBe(false);
  });
});

describe('his answer over her lines (D-M3, D-N2)', () => {
  // Her reply comes before her 8 s on 「say」 (× 0.05) would have run out — as in sig-ogiri, 回覆倒數 2 — or after.
  it.each([['before', 300], ['after', 800]])('clears her question, countdown and bar at once, never puts them back, and sends no leftover timeout (no 409): reply %s her countdown', async (_when, replyMs) => {
    api.scenePreview.mockResolvedValue({ script: OGIRI, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view(), replayed: false });
    api.sceneRun.mockResolvedValue({ run: afterSay() });
    const first = deferred<{ run: SceneRunViewT; replayed: boolean }>();
    api.sceneStep.mockImplementation(async (body: { timeout?: boolean; seq: number; step?: string }) => {
      if (body.step === 'say') return first.p;
      // What the API does with a timeout that names no step, or names 「scent」 before its 30 s (D-N2's 409).
      if (body.timeout && (body.seq !== 1 || body.step !== 'scent')) throw new ApiError('too_early', 409);
      return { run: ended(), replayed: false };
    });
    renderScene();
    // The bar is there while she is still on her way to her question (#72): he answers over her lines.
    const box = await screen.findByLabelText('あなたの言葉', {}, { timeout: 4000 }) as HTMLInputElement;
    expect(document.querySelector('.scn-prompt')?.textContent ?? '').not.toContain(SAY);
    fireEvent.change(box, { target: { value: '詠美姐姐換上這件禮服，整個夜景都輸給妳了' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(api.sceneStep).toHaveBeenCalledWith(expect.objectContaining({ runId: 'scn_1', seq: 0, step: 'say', input: '詠美姐姐換上這件禮服，整個夜景都輸給妳了' }));

    // From his answer on: her question, her countdown and the bar for 「say」 never show again.
    const seen = { prompt: false, countdown: false, bar: false, failed: false };
    const look = () => {
      if ((document.querySelector('.scn-prompt')?.textContent ?? '').includes(SAY)) seen.prompt = true;
      if (screen.queryByTestId('scene-countdown') && !screen.queryByTestId('scene-choices')) seen.countdown = true;
      if (screen.queryByTestId('scene-input')) seen.bar = true;
      if (screen.queryByTestId('scene-step-failed')) seen.failed = true;
    };
    const watch = new MutationObserver(look);
    watch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    look();
    // Her lines run on to 「say」 (the one playing ends, the rest are cut: he spoke over them, ~150 ms in tests) while
    // his answer is on its way; her countdown on it would have run out ~550 ms in.
    await sleep(replyMs);
    first.resolve({ run: afterSay(), replayed: false });
    // Her reply plays, then 「scent」 waits with its own countdown.
    expect(await screen.findByTestId('scene-choices', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByTestId('scene-countdown')).toBeTruthy();
    // Nothing was sent for 「say」 after his answer: no timeout of it, named or not.
    expect(api.sceneStep).toHaveBeenCalledTimes(1);
    // 「scent」's countdown (30 s × 0.05) runs out: its own timeout, at its own seq, and the hug.
    expect(await screen.findByTestId('scene-end', {}, { timeout: 5000 })).toBeTruthy();
    watch.disconnect();
    expect(api.sceneStep).toHaveBeenCalledTimes(2);
    expect(api.sceneStep).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 1, step: 'scent', timeout: true }));
    expect(seen).toEqual({ prompt: false, countdown: false, bar: false, failed: false });
  });

  it('a 409 for a step the server already took counts as sent: no 「沒有送達。」, the scene plays on', async () => {
    api.scenePreview.mockResolvedValue({ script: OGIRI, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view({ seq: 1, beats: beats('perfume', 'scent'), waiting: st('scent') as SceneRunViewT['waiting'] }), replayed: false });
    // His tap lost the race (a second tab, her countdown): the run is already past 「scent」.
    api.sceneStep.mockRejectedValue(new ApiError('request_conflict', 409));
    api.sceneRun.mockResolvedValue({ run: ended() });
    renderScene();
    fireEvent.click(await screen.findByTestId('scene-choice-nice', {}, { timeout: 4000 }));
    await waitFor(() => expect(api.sceneStep).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, step: 'scent', choice: 'nice' })));
    expect(await screen.findByTestId('scene-end', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('scene-step-failed')).toBeNull();
    expect(screen.getByTestId('scene').getAttribute('data-played')).toBe('hug end-hug');
  });

  it('a refusal while the run is still at the step is still his to retry (M14)', async () => {
    api.scenePreview.mockResolvedValue({ script: OGIRI, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    const at = view({ seq: 1, beats: beats('perfume', 'scent'), waiting: st('scent') as SceneRunViewT['waiting'] });
    api.sceneStart.mockResolvedValue({ run: at, replayed: false });
    api.sceneStep.mockRejectedValueOnce(new ApiError('internal', 500)).mockResolvedValueOnce({ run: ended(), replayed: false });
    renderScene();
    fireEvent.click(await screen.findByTestId('scene-choice-nice', {}, { timeout: 4000 }));
    const failed = await screen.findByTestId('scene-step-failed', {}, { timeout: 4000 });
    expect(screen.getByTestId('scene-choices')).toBeTruthy();
    fireEvent.click(failed.querySelector('button')!);
    expect(await screen.findByTestId('scene-end', {}, { timeout: 4000 })).toBeTruthy();
    expect(api.sceneStep).toHaveBeenNthCalledWith(2, expect.objectContaining({ seq: 1, step: 'scent', choice: 'nice' }));
  });
});
