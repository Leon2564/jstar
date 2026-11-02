import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SceneRunViewT } from '@jstar/shared/contracts';
import type { SceneScript } from '@jstar/shared/scenes';
import { GIFTS } from '@jstar/shared/gifts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { stallLines } from '../../src/scene/player';
import { momentLines } from '../../src/scene/wake';
import { AlarmProposal, alarmCovers } from '../../src/components/alarmProposal';
import { DICTS, ensureLang, LANGS } from '../../src/i18n';
import { ja } from '../../src/i18n/ja';
import { SCENE_MEDIA } from '../../src/data/media.scene.gen';

// The stream (#68), her variant footage (#70), memory stills (#51), the stall line (#64), the alarm proposal (#57/#66),
// and her recorded wake-up line (#57), as the player shows them. The API is mocked; it decides.
const api = vi.hoisted(() => ({
  server: true, demo: true, scenePreview: vi.fn(), sceneStart: vi.fn(), sceneStep: vi.fn(), sceneCurrent: vi.fn(), sceneRun: vi.fn(),
  gifts: vi.fn(), alarm: vi.fn(), alarmSet: vi.fn()
}));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => api.server,
  http: {
    scenePreview: api.scenePreview, sceneStart: api.sceneStart, sceneStep: api.sceneStep, sceneCurrent: api.sceneCurrent, sceneRun: api.sceneRun,
    gifts: api.gifts, alarm: api.alarm, alarmSet: api.alarmSet
  }
}));
vi.mock('../../src/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api')>()),
  serverMode: () => api.server,
  isDemo: () => api.demo,
  bootstrap: async () => ({ kind: 'guest' })
}));

const w = window as unknown as { __E2E__: boolean };

beforeAll(() => { w.__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); api.server = true; api.demo = true; });

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
const STREAM = {
  meta: { id: 'private-stream', star: 'unpai', title: T('あなただけの配信'), trigger: { slots: ['night'] }, idle: 'unpai-hero', draft: true },
  steps: [
    { id: 'wide', type: 'clip', shot: 'wide', media: 'unpai-hero', hold: 0 },
    { id: 'on-air', type: 'effect', live: true },
    { id: 'live', type: 'line', text: T('はじまってる？') },
    { id: 'c1', type: 'minigame', kind: 'danmaku', config: {}, next: 'gift' },
    { id: 'gift', type: 'choice', options: [{ id: 'gift', label: T('ギフトを贈る'), next: 'off', gift: 'pick' }, { id: 'clap', label: T('拍手を送る'), next: 'off' }] },
    { id: 'off', type: 'line', text: T('はい、配信おわり。') },
    { id: 'off-air', type: 'effect', live: false },
    { id: 'close', type: 'clip', shot: 'close', media: 'unpai-breath', hold: 0 },
    { id: 'ask', type: 'choice', options: [{ id: 'a', label: T('A'), next: 'end' }, { id: 'b', label: T('B'), next: 'end' }] },
    { id: 'end', type: 'end', outcome: 'complete' }
  ]
} as unknown as SceneScript;
const step = (id: string) => STREAM.steps.find((s) => s.id === id)!;
const view = (patch: Partial<SceneRunViewT> = {}): SceneRunViewT => ({
  id: 'scn_1', sceneId: 'private-stream', star: 'unpai', seq: 0, status: 'active', outcome: null,
  startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString(), endedAt: null,
  beats: STREAM.steps.slice(0, 4) as SceneRunViewT['beats'], waiting: step('c1') as SceneRunViewT['waiting'], waitingSince: new Date().toISOString(),
  upcoming: [], timerEndsAt: null, rewardable: true, rewards: { affinity: 0, variantXp: 0, memories: [], promises: [] }, result: null, affinityXp: 0,
  live: true, ...patch
});
const renderAt = (path: string, patch: Partial<ReturnType<typeof initialState>> = {}) => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'unpai', points: 5000, ...patch }}>
    <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);
const T4 = 4000;

describe('うんぱい\'s stream in the player (#68)', () => {
  beforeEach(() => {
    api.scenePreview.mockResolvedValue({ script: STREAM, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view(), replayed: false });
    api.gifts.mockResolvedValue({ star: 'unpai', gifts: GIFTS.map((g) => ({ id: g.id, price: g.price, known: false })), sentToday: 0, perDay: 5, points: 5000 });
  });

  it('is live with one viewer, and his comment flows across the stream', async () => {
    api.sceneStep.mockResolvedValue({ run: view({ seq: 1, beats: [step('gift')] as SceneRunViewT['beats'], waiting: step('gift') as SceneRunViewT['waiting'] }), replayed: false });
    renderAt('/me/scene/private-stream?preview=1');
    const layer = await screen.findByTestId('stream-layer', {}, { timeout: T4 });
    expect(layer.textContent).toContain('LIVE');
    expect(layer.textContent).toContain('視聴者 1人');
    expect(screen.getByTestId('scene').hasAttribute('data-live')).toBe(true);
    const input = await screen.findByPlaceholderText('コメントする', {}, { timeout: T4 });
    fireEvent.change(input, { target: { value: 'こんばんは〜' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(layer.querySelector('.scn-dm')?.textContent).toContain('こんばんは〜'));
  });

  it('a gift: the sheet picks it, the step buys it, she thanks him; then off air and the layer is gone', async () => {
    api.sceneStart.mockResolvedValue({ run: view({ beats: [step('gift')] as SceneRunViewT['beats'], waiting: step('gift') as SceneRunViewT['waiting'] }), replayed: false });
    const thanks = { id: 'gift~gift', type: 'line', text: T('え、花束！') };
    api.sceneStep.mockResolvedValue({
      run: view({ seq: 1, beats: [thanks, step('off'), step('off-air'), step('close'), step('ask')] as SceneRunViewT['beats'], waiting: step('ask') as SceneRunViewT['waiting'],
        result: { kind: 'gift', giftId: 'bouquet', taste: 'plain', xp: 6, result: 'win' }, live: undefined }),
      replayed: false
    });
    renderAt('/me/scene/private-stream?preview=1');
    fireEvent.click(await screen.findByTestId('scene-choice-gift', {}, { timeout: T4 }));
    fireEvent.click(await screen.findByTestId('gift-bouquet', {}, { timeout: T4 }));
    await waitFor(() => expect((screen.getByTestId('gift-send') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('gift-send'));
    await waitFor(() => expect(api.sceneStep).toHaveBeenCalledWith(expect.objectContaining({ seq: 0, choice: 'gift', gift: 'bouquet' })));
    expect(screen.queryByTestId('gift-sheet')).toBeNull();
    expect(await screen.findByText('花束を贈りました（120 pt）'.replace('120', String(GIFTS.find((g) => g.id === 'bouquet')!.price)), {}, { timeout: T4 })).toBeTruthy();
    expect(await screen.findByTestId('stream-off-air', {}, { timeout: T4 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('stream-layer')).toBeNull(), { timeout: T4 });
    expect(screen.getByTestId('scene').hasAttribute('data-live')).toBe(false);
  });

  it('without the points the sheet says so, and the scene waits: applause still goes', async () => {
    api.sceneStart.mockResolvedValue({ run: view({ beats: [step('gift')] as SceneRunViewT['beats'], waiting: step('gift') as SceneRunViewT['waiting'] }), replayed: false });
    renderAt('/me/scene/private-stream?preview=1', { points: 0 });
    fireEvent.click(await screen.findByTestId('scene-choice-gift', {}, { timeout: T4 }));
    fireEvent.click(await screen.findByTestId('gift-bouquet', {}, { timeout: T4 }));
    expect((await screen.findByTestId('gift-send')).textContent).toBe(ja['gift.noPoints']);
    expect((screen.getByTestId('gift-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(api.sceneStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('scene-choice-clap'));
    await waitFor(() => expect(api.sceneStep).toHaveBeenCalledWith(expect.objectContaining({ choice: 'clap' })));
  });
});

describe('a game waits for her question (QA #25)', () => {
  it('the ōgiri answer bar comes with its step, not while she is still on her way to the topic', async () => {
    const OGIRI = {
      meta: { id: 'ogiri', star: 'eimi', title: T('大喜利'), trigger: { slots: ['night'] }, idle: 'eimi-hero', draft: true },
      steps: [
        { id: 'wide', type: 'clip', shot: 'wide', media: 'eimi-hero', hold: 0 },
        { id: 'rules', type: 'line', text: T('規則很簡單。') },
        { id: 'dare', type: 'choice', options: [{ id: 'bring', label: T('放馬過來'), next: 'sure' }, { id: 'easy', label: T('手下留情'), next: 'sure' }] },
        { id: 'sure', type: 'line', text: T('哦～，很有自信嘛。我不討厭這種的喔？') },
        { id: 'first', type: 'line', text: T('那麼第一題。……要來囉？') },
        { id: 'topic', type: 'line', text: T('山頂上的自動販賣機。裡面賣什麼？') },
        { id: 'q1', type: 'minigame', kind: 'ogiri', config: {}, next: 'end' },
        { id: 'end', type: 'end', outcome: 'complete' }
      ]
    } as unknown as SceneScript;
    const at = (id: string) => OGIRI.steps.find((x) => x.id === id)! as SceneRunViewT['waiting'];
    api.scenePreview.mockResolvedValue({ script: OGIRI, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view({ sceneId: 'ogiri', star: 'eimi', live: undefined, beats: OGIRI.steps.slice(0, 3) as SceneRunViewT['beats'], waiting: at('dare') }), replayed: false });
    api.sceneStep.mockResolvedValue({ run: view({ sceneId: 'ogiri', star: 'eimi', live: undefined, seq: 1, beats: OGIRI.steps.slice(3, 7) as SceneRunViewT['beats'], waiting: at('q1') }), replayed: false });
    renderAt('/me/scene/ogiri?preview=1', { star: 'eimi' });
    fireEvent.click(await screen.findByTestId('scene-choice-bring', {}, { timeout: T4 }));
    // When the answer bar first appears, what is she saying? (Watched as it happens: her lines play fast in tests.)
    let shownAfter: string | null = null;
    const watch = new MutationObserver(() => {
      if (shownAfter === null && document.querySelector('[data-testid="scene-input"]')) shownAfter = document.querySelector('[data-testid="scene-sub"]')?.textContent ?? '';
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true });
    expect(await screen.findByTestId('scene-input', {}, { timeout: T4 })).toBeTruthy();
    watch.disconnect();
    // Not while she was on her way to the topic: only once she had asked it.
    expect(shownAfter).toContain('山頂上的自動販賣機');
  });
});

describe('her variant footage and the late clip (#70, #64)', () => {
  /** えいみ's twirl as the server sends it to a card owner (#70): her variant card's close shot, the shot as written its fallback. */
  const playTwirl = async () => {
    const script = { ...STREAM, meta: { ...STREAM.meta, id: 'ogiri', star: 'eimi', idle: 'eimi-hero' } } as unknown as SceneScript;
    const twirl = { id: 'twirl', type: 'clip', shot: 'close', media: 'eimi-variant-close', fallback: 'eimi-breath', hold: 0 };
    const ask = { id: 'ask', type: 'choice', options: [{ id: 'a', label: T('A'), next: 'end' }, { id: 'b', label: T('B'), next: 'end' }] };
    api.scenePreview.mockResolvedValue({ script, standIns: {} });
    api.sceneCurrent.mockResolvedValue({ run: null });
    api.sceneStart.mockResolvedValue({ run: view({ sceneId: 'ogiri', star: 'eimi', live: undefined, beats: [twirl, ask] as SceneRunViewT['beats'], waiting: ask as SceneRunViewT['waiting'] }), replayed: false });
    renderAt('/me/scene/ogiri?preview=1', { star: 'eimi' });
    await screen.findByTestId('scene-choice-a', {}, { timeout: T4 });
    expect(screen.getByTestId('scene').dataset.shot).toBe('close');
    return document.querySelector('.scn-layer.on')?.getAttribute('data-clip');
  };

  it('plays her variant card\'s footage when he owns it (#81 made the clip)', async () => {
    expect(SCENE_MEDIA['eimi-variant-close-9x16']).toBeDefined();
    expect(await playTwirl()).toBe('eimi-variant-close-9x16');
  });

  it('cuts to the shot as written when this build has no footage for the variant', async () => {
    // The clip exists since #81: take it away for this check.
    const made = SCENE_MEDIA['eimi-variant-close-9x16'];
    delete SCENE_MEDIA['eimi-variant-close-9x16'];
    try {
      expect(await playTwirl()).toBe('eimi-breath-9x16');
    } finally {
      SCENE_MEDIA['eimi-variant-close-9x16'] = made;
    }
  });

  it('her stall lines are hers, three each, in every language', async () => {
    for (const lang of LANGS) await ensureLang(lang);
    for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const) {
      for (const lang of LANGS) {
        const lines = stallLines(DICTS[lang]![`scene.stall.${star}` as keyof typeof ja]);
        expect(lines, `${star} ${lang}`).toHaveLength(3);
      }
    }
    expect(stallLines(ja['scene.stall.mahiro'])[0]).toBe('ちょっと待ってて！');
  });
});

describe('memory stills (#51)', () => {
  it('思い出 shows a scene card with the shot it was made on; a chat card shows her home poster (N-34: never a blank tile)', async () => {
    api.server = false;
    renderAt('/me/cards?tab=memory', {
      memories: [{ id: 'm1', star: 'unpai', title: '片耳ずつのヘッドホン', date: '9/28', still: 'unpai-breath' }, { id: 'm2', star: 'nana', title: 'おしゃべり', date: '9/27' }]
    });
    const card = await screen.findByRole('img', { name: /片耳ずつのヘッドホン/ }, { timeout: T4 });
    expect(card.dataset.still).toBe('unpai-breath');
    expect(card.querySelector('img.art')?.getAttribute('src')).toContain('/media/unpai-breath-9x16/');
    const chat = screen.getByRole('img', { name: /おしゃべり/ });
    expect(chat.dataset.still).toBe('nana-hero');
    expect(chat.querySelector('img.art')).not.toBeNull();
  });
});

describe('her 「明日の朝、起こしてあげる」 (#57, #66)', () => {
  const promise = { text: '明日の朝、起こしてあげる', dueAt: new Date(Date.now() + 12 * 3_600_000).toISOString() };
  const alarm = (patch = {}) => ({ star: 'mahiro', time: '06:45', days: [1, 2, 3, 4, 5], enabled: true, tz: 'Asia/Tokyo', nextAt: new Date(Date.now() + 9 * 3_600_000).toISOString(), updatedAt: '', ...patch });
  const show = () => render(<StoreProvider initial={{ ...initialState(), ageOk: true }}><MemoryRouter><AlarmProposal star="mahiro" first="まひろ" promise={promise} /></MemoryRouter></StoreProvider>);

  it('proposes the alarm with her; yes sets it at his time, every day when he had none', async () => {
    api.alarm.mockResolvedValue({ alarm: null });
    api.alarmSet.mockResolvedValue({ alarm: alarm({ time: '07:15', days: [0, 1, 2, 3, 4, 5, 6] }) });
    show();
    const form = await screen.findByTestId('alarm-proposal');
    expect(form.textContent).toContain('まひろに朝起こしてもらう');
    fireEvent.change(screen.getByTestId('alarm-proposal-time'), { target: { value: '07:15' } });
    fireEvent.click(screen.getByTestId('alarm-proposal-yes'));
    await waitFor(() => expect(api.alarmSet).toHaveBeenCalledWith(expect.objectContaining({ star: 'mahiro', time: '07:15', days: [0, 1, 2, 3, 4, 5, 6], enabled: true })));
    expect((await screen.findByTestId('alarm-proposal-set')).textContent).toContain('まひろが起こしに来るよ');
  });

  it('keeps his days and offers his time; says when it replaces someone else; nothing to propose when she already wakes him', async () => {
    api.alarm.mockResolvedValue({ alarm: alarm({ star: 'nana' }) });
    show();
    expect(((await screen.findByTestId('alarm-proposal-time')) as HTMLInputElement).value).toBe('06:45');
    expect(screen.getByTestId('alarm-proposal').textContent).toContain('目覚ましをまひろに替える');
    cleanup();
    api.alarm.mockResolvedValue({ alarm: alarm() });
    show();
    expect(await screen.findByTestId('alarm-proposal-set')).toBeTruthy();
    expect(alarmCovers(alarm(), 'mahiro', promise.dueAt)).toBe(true);
    expect(alarmCovers(alarm({ enabled: false }), 'mahiro', promise.dueAt)).toBe(false);
  });

  it('the swap row\'s 「セット」 and time field read clearly, also while it is being set (N-43: WCAG AA)', async () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const hex = (rgb: string) => '#' + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    const CARD = '#1b1e3d';
    api.alarm.mockResolvedValue({ alarm: alarm({ star: 'nana' }) });
    let done: (v: unknown) => void = () => undefined;
    api.alarmSet.mockReturnValue(new Promise((r) => { done = r; }));
    show();
    const set = await screen.findByTestId('alarm-proposal-yes');
    const time = screen.getByTestId('alarm-proposal-time');
    const check = () => {
      expect(ratio(hex(set.style.color), hex(set.style.background))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(hex(time.style.color), CARD)).toBeGreaterThanOrEqual(4.5);
      expect(set.style.opacity).toBe('1');
    };
    check();
    fireEvent.click(set);
    await waitFor(() => expect((set as HTMLButtonElement).disabled).toBe(true));
    check();
    done({ alarm: alarm() });
  });

  it('her wake-up line speaks in her recorded voice when #83 made it', () => {
    expect(momentLines('nana', 'ja', 'おはよ！', 'weekday-1', '/voice/scene/nana/wake-weekday-1.mp3')[1]).toEqual({ text: 'おはよ！', voice: '/voice/scene/nana/wake-weekday-1.mp3' });
    expect(momentLines('nana', 'ja', 'おはよ！', 'weekday-1', null)[1]).toEqual({ text: 'おはよ！', voice: null });
  });
});
