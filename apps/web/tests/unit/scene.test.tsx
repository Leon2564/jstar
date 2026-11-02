import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SCENE_RULES } from '@jstar/shared/rules';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { useIdle } from '../../src/scene/idle';
import { startScene, stepScene } from '../../src/scene/client';

// Prototype mode (no VITE_API_BASE): the player runs the shared engine against this browser, like the e2e suite.
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

let latest: AppState;
function Spy() { latest = useStore().state; return null; }
const renderScene = (patch: Partial<AppState> = {}) => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, ...patch }}>
    <Spy />
    <MemoryRouter initialEntries={['/me/scene/demo-evening']}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);
const deps = { affinity: 0, freeTalk: async (t: string) => `re:${t}` };

describe('scene player (prototype mode)', () => {
  it('plays to the choice, branches, hands free talk to chat, and ends with a memory card and affinity', async () => {
    renderScene();
    const choices = await screen.findByRole('group', { name: 'なんて答える？' }, { timeout: 4000 });
    expect(screen.getByTestId('scene-sub').textContent).toContain('おかえりなさい');
    fireEvent.click(choices.querySelector('button')!);
    expect((await screen.findByTestId('scene-affinity')).textContent).toBe('親密度 +5');
    const input = await screen.findByLabelText('あなたの言葉', {}, { timeout: 4000 });
    fireEvent.change(input, { target: { value: '今日は雨だった' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    const end = await screen.findByTestId('scene-end', {}, { timeout: 5000 });
    expect(end.textContent).toContain('おかえりの夜');
    expect(end.textContent).toContain('明日も、ここで待ってるね');
    // 5 (choice) + 10 (ending) + the free-talk message's chat XP; the card is kept with her.
    await waitFor(() => expect(latest.affinity.mahiro).toBe(15 + 8));
    expect(latest.memories.map((m) => m.title)).toContain('おかえりの夜');
    expect(latest.chats.mahiro.map((m) => m.text)).toContain('今日は雨だった');
  });

  it('picks choices by number key and keeps subtitles in the live region when hidden', async () => {
    renderScene();
    await screen.findByRole('group', { name: 'なんて答える？' }, { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: '字幕' }));
    expect(screen.getByRole('button', { name: '字幕' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('scene-sub').querySelector('p')!.className).toBe('sr-only');
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(screen.getByTestId('scene-sub').textContent).toContain('甘やかして'), { timeout: 4000 });
  });

  it('resumes after a reload at the waiting step, without replaying or re-paying the start', async () => {
    const first = renderScene();
    fireEvent.click((await screen.findByRole('group', { name: 'なんて答える？' }, { timeout: 4000 })).querySelector('button')!);
    await screen.findByLabelText('あなたの言葉', {}, { timeout: 4000 });
    await waitFor(() => expect(latest.affinity.mahiro).toBe(5));
    const kept = latest;
    first.unmount();
    renderScene(kept);
    expect(await screen.findByLabelText('あなたの言葉', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'なんて答える？' })).toBeNull();
    expect(latest.affinity.mahiro).toBe(5);
  });
});

describe('scene client (prototype mode)', () => {
  it('is idempotent per step and pays rewards once per scene per day', async () => {
    const a = (await startScene('demo-evening', 'ja', deps)).run;
    const once = await stepScene(a, { choice: 'missed' }, 'ja', deps);
    const twice = await stepScene(a, { choice: 'tired' }, 'ja', deps);
    expect(once.replayed).toBe(false);
    expect(twice).toMatchObject({ replayed: true, run: { seq: 1 } });
    const done = (await stepScene(once.run, { input: 'hi' }, 'ja', deps)).run;
    expect(done).toMatchObject({ status: 'ended', rewards: { affinity: 15 } });
    const replay = (await startScene('demo-evening', 'ja', deps)).run;
    expect(replay.rewardable).toBe(false);
  });
});

describe('idle fallback (docs/requirements.md §13.1)', () => {
  it('returns to the idle loop at 30 s, asks at 60 s, ends at 5 min, and any touch starts over', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const { result } = renderHook(() => useIdle(true, onEnd));
    act(() => { vi.advanceTimersByTime(SCENE_RULES.idleLoopMs); });
    expect(result.current[0]).toBe('loop');
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    expect(result.current[0]).toBe('active');
    act(() => { vi.advanceTimersByTime(SCENE_RULES.idlePromptMs); });
    expect(result.current[0]).toBe('prompt');
    act(() => { vi.advanceTimersByTime(SCENE_RULES.idleEndMs - SCENE_RULES.idlePromptMs - 1); });
    expect(onEnd).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('does not run while she is speaking', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const { result } = renderHook(() => useIdle(false, onEnd));
    act(() => { vi.advanceTimersByTime(SCENE_RULES.idleEndMs * 2); });
    expect(result.current[0]).toBe('active');
    expect(onEnd).not.toHaveBeenCalled();
  });
});
