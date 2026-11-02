import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SceneRunViewT } from '@jstar/shared/contracts';
import type { SceneScript } from '@jstar/shared/scenes';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';

// Draft scene previews (#66–#70): the test site's server serves the script and judges the games; the web only plays.
const api = vi.hoisted(() => ({ server: true, demo: true, scenePreviews: vi.fn(), scenePreview: vi.fn(), sceneStart: vi.fn(), sceneStep: vi.fn(), sceneCurrent: vi.fn(), sceneRun: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => api.server,
  http: {
    scenePreviews: api.scenePreviews, scenePreview: api.scenePreview, sceneStart: api.sceneStart, sceneStep: api.sceneStep,
    sceneCurrent: api.sceneCurrent, sceneRun: api.sceneRun
  }
}));
vi.mock('../../src/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api')>()),
  serverMode: () => api.server,
  isDemo: () => api.demo
}));

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); api.server = true; api.demo = true; });

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
/** A draft as the API serves it: うんぱい's stream, her pending clip already replaced by her own. */
const SCRIPT = {
  meta: { id: 'private-stream', star: 'unpai', title: T('あなただけの配信'), trigger: { slots: ['night'] }, idle: 'unpai-hero', draft: true },
  steps: [
    { id: 'wide', type: 'clip', shot: 'wide', media: 'unpai-hero', hold: 0 },
    { id: 'live', type: 'line', text: T('はじまってる？') },
    { id: 'c1', type: 'minigame', kind: 'danmaku', config: {}, next: 'end' },
    { id: 'end', type: 'end', outcome: 'complete' }
  ]
} as unknown as SceneScript;
const view = (patch: Partial<SceneRunViewT> = {}): SceneRunViewT => ({
  id: 'scn_1', sceneId: 'private-stream', star: 'unpai', seq: 0, status: 'active', outcome: null,
  startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString(), endedAt: null,
  beats: SCRIPT.steps.slice(0, 3), waiting: SCRIPT.steps[2], waitingSince: new Date().toISOString(), upcoming: [], timerEndsAt: null,
  rewardable: true, rewards: { affinity: 0, variantXp: 0, memories: [], promises: [] }, result: null, affinityXp: 0, ...patch
});
const renderAt = (path: string) => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'unpai' }}>
    <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);

describe('draft scene previews (#66–#70)', () => {
  it('lists the drafts on the test site, each opening its preview', async () => {
    api.scenePreviews.mockResolvedValue({ scenes: [{ id: 'private-stream', star: 'unpai', title: T('あなただけの配信'), pending: ['unpai-scene-private-stream-run'], games: ['danmaku'] }] });
    renderAt('/me/preview');
    const link = await screen.findByTestId('preview-private-stream');
    expect(link.getAttribute('href')).toBe('/me/scene/private-stream?preview=1');
    expect(link.textContent).toContain('あなただけの配信');
    // N-27: the game by its name, not its id.
    expect(link.textContent).toContain('コメント');
    expect(link.textContent).not.toContain('danmaku');
    expect(screen.getByTestId('scene-previews').textContent).toContain('テストサイト専用');
  });

  it('says 「撮影待ち」 and 「仮の映像」 only where a clip is really stood in (N-18)', async () => {
    api.scenePreviews.mockResolvedValue({ scenes: [{ id: 'private-stream', star: 'unpai', title: T('あなただけの配信'), pending: [], games: ['danmaku'] }] });
    renderAt('/me/preview');
    await screen.findByTestId('preview-private-stream');
    expect(document.querySelector('.hdr')!.textContent).toContain('シーンのプレビュー');
    expect(document.querySelector('.hdr')!.textContent).not.toContain('撮影待ち');
    expect(screen.queryByTestId('preview-pending-private-stream')).toBeNull();
    cleanup();
    api.scenePreview.mockResolvedValue({ script: SCRIPT, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view(), replayed: false });
    renderAt('/me/scene/private-stream?preview=1');
    const badge = await screen.findByTestId('scene-preview');
    expect(badge.textContent).toBe('プレビュー');
    expect(badge.dataset.standIn).toBe('false');
  });

  it('a list with a scene still waiting keeps 「撮影待ち」 and says how many clips stand in', async () => {
    api.scenePreviews.mockResolvedValue({ scenes: [{ id: 'private-stream', star: 'unpai', title: T('あなただけの配信'), pending: ['a', 'b'], games: [] }] });
    renderAt('/me/preview');
    expect((await screen.findByTestId('preview-pending-private-stream')).textContent).toBe('撮影待ち 2本（仮の映像）');
    expect(document.querySelector('.hdr')!.textContent).toContain('撮影待ちシーンのプレビュー');
  });

  it('is not there without the test site: nothing is asked, and a preview link does not open', async () => {
    api.server = false;
    renderAt('/me/preview');
    expect(await screen.findByTestId('scene-previews-off')).toBeTruthy();
    cleanup();
    api.server = true;
    api.demo = false;
    renderAt('/me/scene/private-stream?preview=1');
    expect((await screen.findByTestId('scene-error')).dataset.code).toBe('scene_not_found');
    expect(api.scenePreviews).not.toHaveBeenCalled();
    expect(api.scenePreview).not.toHaveBeenCalled();
  });

  it('plays the server\'s script, starts it as a preview, says so, and sends his comment to be judged', async () => {
    api.scenePreview.mockResolvedValue({ script: SCRIPT, standIns: { 'unpai-scene-private-stream-run': 'unpai-hero' } });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view(), replayed: false });
    const reply = { id: 'c1~reply', type: 'line', text: T('『こんばんは』……ん、こんばんは。'), agent: true };
    api.sceneStep.mockResolvedValue({
      run: view({ seq: 1, status: 'ended', outcome: 'complete', beats: [reply, SCRIPT.steps[3]] as SceneRunViewT['beats'], waiting: null,
        result: { kind: 'danmaku', label: 'greet', read: true, result: 'win' } }),
      replayed: false
    });
    renderAt('/me/scene/private-stream?preview=1');
    expect((await screen.findByTestId('scene-preview')).textContent).toBe('プレビュー・仮の映像');
    await waitFor(() => expect(api.sceneStart).toHaveBeenCalledWith('private-stream', 'ja', undefined, true));
    const input = await screen.findByPlaceholderText('コメントする', {}, { timeout: 4000 });
    fireEvent.change(input, { target: { value: 'こんばんは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(api.sceneStep).toHaveBeenCalledWith(expect.objectContaining({ runId: 'scn_1', seq: 0, minigame: { text: 'こんばんは' } })));
    expect(await screen.findByText(/ん、こんばんは/, {}, { timeout: 4000 })).toBeTruthy();
  });

  it('a second run today opens without 「受け取り済み」; only its end says today\'s memory is already his (N-07)', async () => {
    api.scenePreview.mockResolvedValue({ script: SCRIPT, standIns: { 'unpai-scene-private-stream-run': 'unpai-hero' } });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view({ rewardable: false }), replayed: false });
    api.sceneStep.mockResolvedValue({
      run: view({ seq: 1, rewardable: false, status: 'ended', outcome: 'complete', beats: [SCRIPT.steps[3]] as SceneRunViewT['beats'], waiting: null }),
      replayed: false
    });
    renderAt('/me/scene/private-stream?preview=1');
    const input = await screen.findByPlaceholderText('コメントする', {}, { timeout: 4000 });
    expect(screen.getByTestId('scene').textContent).not.toMatch(/受け取/);
    fireEvent.change(input, { target: { value: 'こんばんは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect((await screen.findByTestId('scene-end', {}, { timeout: 4000 })).textContent).toContain('今日の思い出はもう受け取っています');
  });

  it('while her answer comes: her quiet typing dots first, 「えっと……」 only when it takes a while (N-40)', async () => {
    (window as unknown as { __SCENE_TIME_SCALE__?: number }).__SCENE_TIME_SCALE__ = 0.05; // dots at 35 ms, 「えっと」 at 200 ms
    try {
      api.scenePreview.mockResolvedValue({ script: SCRIPT, standIns: {} });
      api.sceneCurrent.mockResolvedValue({ run: null });
      api.sceneStart.mockResolvedValue({ run: view(), replayed: false });
      let answer: (v: unknown) => void = () => undefined;
      api.sceneStep.mockReturnValue(new Promise((r) => { answer = r; }));
      renderAt('/me/scene/private-stream?preview=1');
      const input = await screen.findByPlaceholderText('コメントする', {}, { timeout: 4000 });
      fireEvent.change(input, { target: { value: 'こんばんは' } });
      fireEvent.click(screen.getByRole('button', { name: '送信' }));
      expect(await screen.findByTestId('scene-thinking')).toBeTruthy();
      expect(screen.getByTestId('scene').textContent).not.toContain('えっと');
      await waitFor(() => expect(screen.getByTestId('scene').textContent).toContain('えっと……'));
      expect(screen.queryByTestId('scene-thinking')).toBeNull();
      answer({ run: view({ seq: 1, status: 'ended', outcome: 'complete', beats: [SCRIPT.steps[3]] as SceneRunViewT['beats'], waiting: null }), replayed: false });
    } finally {
      delete (window as unknown as { __SCENE_TIME_SCALE__?: number }).__SCENE_TIME_SCALE__;
    }
  });

  it('shows えいみ\'s score for an ōgiri answer (#70)', async () => {
    const ogiri = {
      ...SCRIPT, meta: { ...SCRIPT.meta, id: 'ogiri', star: 'eimi', idle: 'eimi-hero' },
      steps: [
        { id: 'wide', type: 'clip', shot: 'wide', media: 'eimi-hero', hold: 0 },
        { id: 'round-1', type: 'minigame', kind: 'ogiri', config: {}, next: 'q2' },
        { id: 'q2', type: 'line', text: T('じゃあ二問目') },
        { id: 'round-2', type: 'minigame', kind: 'ogiri', config: {}, next: 'end' },
        { id: 'end', type: 'end' }
      ]
    } as unknown as SceneScript;
    api.scenePreview.mockResolvedValue({ script: ogiri, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    const prompt = { id: 'round-1~prompt', type: 'line', text: T('こんな目覚まし時計はイヤだ') };
    api.sceneStart.mockResolvedValue({ run: view({ sceneId: 'ogiri', star: 'eimi', beats: [ogiri.steps[0], prompt, ogiri.steps[1]] as SceneRunViewT['beats'], waiting: ogiri.steps[1] }), replayed: false });
    api.sceneStep.mockResolvedValue({
      run: view({ sceneId: 'ogiri', star: 'eimi', seq: 1, beats: [ogiri.steps[2], ogiri.steps[3]] as SceneRunViewT['beats'], waiting: ogiri.steps[3],
        result: { kind: 'ogiri', score: 7, of: 10, pass: null, result: 'draw' } }),
      replayed: false
    });
    renderAt('/me/scene/ogiri?preview=1');
    // Her words are subtitled in 「」 (A2), as in her room.
    expect(await screen.findByText('「こんな目覚まし時計はイヤだ」', {}, { timeout: 4000 })).toBeTruthy();
    const input = await screen.findByLabelText('あなたの言葉', {}, { timeout: 4000 });
    fireEvent.change(input, { target: { value: '毎朝プロポーズしてくる' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect((await screen.findByTestId('scene-score', {}, { timeout: 4000 })).textContent).toBe('7点（10点満点）');
  });
});

describe('his answer to her confession (N-49)', () => {
  it('once he has answered, the answer box and the keep-my-voice box leave the stage — never over the hug', async () => {
    const { confessionSceneById } = await import('@jstar/shared/scenes/confession');
    const script = confessionSceneById('confession-mahiro')!;
    const at = (id: string) => script.steps.find((st) => st.id === id)!;
    const upTo = script.steps.slice(0, script.steps.findIndex((st) => st.id === 'answer') + 1);
    api.scenePreview.mockResolvedValue({ script, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view({ sceneId: 'confession-mahiro', star: 'mahiro', beats: upTo as SceneRunViewT['beats'], waiting: at('answer') as SceneRunViewT['waiting'] }), replayed: false });
    // The server's answer while the hug plays: the run still active and still naming the answer step it came from.
    api.sceneStep.mockResolvedValue({ run: view({ sceneId: 'confession-mahiro', star: 'mahiro', seq: 1, beats: [at('yes'), at('yes-0')] as SceneRunViewT['beats'], waiting: at('answer') as SceneRunViewT['waiting'] }), replayed: false });
    renderAt('/me/scene/confession-mahiro?preview=1');
    const input = await screen.findByLabelText('あなたの言葉', {}, { timeout: 6000 });
    fireEvent.change(input, { target: { value: 'はい、よろしくお願いします' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(screen.getByTestId('scene').dataset.played).toMatch(/yes-0/));
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByLabelText('あなたの言葉')).toBeNull();
    expect(screen.queryByTestId('confession-keep')).toBeNull();
  });
});

describe('mini-game names (N-27)', () => {
  it('every mini-game has a name in all four languages', async () => {
    const { ja } = await import('../../src/i18n/ja');
    const { en } = await import('../../src/i18n/en');
    const { ko } = await import('../../src/i18n/ko');
    const { zhHant } = await import('../../src/i18n/zhHant');
    for (const g of ['rps', 'praise', 'danmaku', 'bargain', 'ogiri']) {
      const names = [ja, en, ko, zhHant].map((d) => (d as Record<string, string>)[`scene.game.${g}`]);
      expect(names.every((n) => !!n && n !== g), g).toBe(true);
    }
  });
});

describe('アリス\'s date: her plea when the countdown runs out (#69)', () => {
  const DATE = {
    meta: { id: 'night-greenhouse', star: 'alice', title: T('夜の温室と、延長'), trigger: { slots: ['night'] }, idle: 'alice-hero', draft: true },
    steps: [
      { id: 'wide', type: 'clip', shot: 'wide', media: 'alice-hero', hold: 0 },
      { id: 'clock', type: 'effect', timer: { seconds: 2400, onEnd: 'closing' } },
      { id: 'want', type: 'choice', options: [{ id: 'dance', next: 'closing', label: T('一緒に踊ってほしい') }, { id: 'talk', next: 'closing', label: T('花の話を聞かせて') }] },
      { id: 'closing', type: 'line', text: T('……もう、閉館の時間みたいです。') },
      { id: 'extend', type: 'choice', options: [{ id: 'extend', next: 'end', pay: 'extend', label: T('30分延長する') }, { id: 'tomorrow', next: 'end', label: T('今日はここまで') }] },
      { id: 'end', type: 'end', outcome: 'tomorrow' }
    ]
  } as unknown as SceneScript;

  it('the moment the time is up, her plea and the extend choice come — wherever he was (fake timers)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const ends = Date.now() + 60_000;
      const at = (seq: number, beats: number[], waiting: number) => ({
        id: 'scn_d', sceneId: 'night-greenhouse', star: 'alice', seq, status: 'active', outcome: null, startedAt: new Date().toISOString(),
        endsAt: new Date(ends + 300_000).toISOString(), endedAt: null, beats: beats.map((i) => DATE.steps[i]), waiting: DATE.steps[waiting],
        waitingSince: new Date().toISOString(), upcoming: [], timerEndsAt: new Date(ends).toISOString(), rewardable: true,
        rewards: { affinity: 0, variantXp: 0, memories: [], promises: [] }, result: null, affinityXp: 0
      }) as unknown as SceneRunViewT;
      api.scenePreview.mockResolvedValue({ script: DATE, standIns: {} });
      api.sceneCurrent.mockResolvedValue({ run: null });
      api.sceneStart.mockResolvedValue({ run: at(0, [0, 1, 2], 2), replayed: false });
      api.sceneRun.mockResolvedValue({ run: at(1, [3, 4], 4) });
      renderAt('/me/scene/night-greenhouse?preview=1');
      expect(await screen.findByRole('button', { name: /一緒に踊ってほしい/ }, { timeout: 4000 })).toBeTruthy();
      expect(api.sceneRun).not.toHaveBeenCalled();
      // Not yet: nothing is asked of the server before the countdown's end.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(api.sceneRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(api.sceneRun).toHaveBeenCalledWith('scn_d');
      expect(await screen.findByRole('button', { name: /30分延長する/ }, { timeout: 4000 })).toBeTruthy();
      expect(screen.getByRole('button', { name: /今日はここまで/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /一緒に踊ってほしい/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
