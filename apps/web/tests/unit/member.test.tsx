import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { jstDay, RULES } from '@jstar/shared/rules';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let latest: AppState;
function Spy() { latest = useStore().state; return null; }

function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, ...patch }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const future = () => new Date(Date.now() + 5 * 86_400_000).toISOString();

describe('daily chat allowance (docs/requirements.md §3)', () => {
  it('counts down and stops at the limit with a monthly pass offer', async () => {
    renderAt('/me/chat', { chatDay: jstDay(), chatUsed: RULES.dailyFreeMessages - 1 });
    expect((await screen.findByTestId('chat-left')).textContent).toBe('今日あと1通');
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'last one' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByTestId('chat-limit')).toBeTruthy();
    expect(screen.getByTestId('chat-left').textContent).toBe('今日あと0通');
    expect((screen.getByLabelText('メッセージ') as HTMLInputElement).disabled).toBe(true);
  });

  it('resets on a new JST day', async () => {
    renderAt('/me/chat', { chatDay: '2020-01-01', chatUsed: RULES.dailyFreeMessages });
    expect((await screen.findByTestId('chat-left')).textContent).toBe(`今日あと${RULES.dailyFreeMessages}通`);
  });

  it('is unlimited while the monthly pass is active', async () => {
    renderAt('/me/chat', { chatDay: jstDay(), chatUsed: RULES.dailyFreeMessages, passUntil: future() });
    expect((await screen.findByTestId('chat-left')).textContent).toBe('話し放題');
    expect(screen.queryByTestId('chat-limit')).toBeNull();
  });

  it('shows an error instead of hanging when the service fails', async () => {
    vi.spyOn(api, 'chat').mockRejectedValue(new api.ApiError('network', 0));
    renderAt('/me/chat');
    await screen.findByTestId('chat-left');
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    // N-58: tried once more by itself, then his bubble says it did not go (with a resend), not a passing toast.
    expect((await screen.findByTestId('chat-failed', {}, { timeout: 6000 })).textContent).toContain('送れませんでした');
    await waitFor(() => expect(screen.queryByRole('status', { name: /入力中/ })).toBeNull());
  });

  it('a rate-limited send is tried once more by itself and goes (N-58)', async () => {
    const send = vi.spyOn(api, 'chat')
      .mockRejectedValueOnce(new api.ApiError('rate_limited', 429, 50))
      .mockResolvedValueOnce({ reply: 'おかえり', memoryCard: null, chatUsed: 1, chatDay: jstDay() } as never);
    renderAt('/me/chat');
    await screen.findByTestId('chat-left');
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText('おかえり')).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('chat-failed')).toBeNull();
  });
});

describe('shop', () => {
  it('shows the four configured Star Stone tiers in the compact top-up dialog', async () => {
    renderAt('/me/shop');
    expect(await screen.findByRole('dialog', { name: '星石をチャージ' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByText('¥1,400')).toBeTruthy();
    expect(screen.getByText('星石はギフトとガチャに使えます')).toBeTruthy();
  });
});

describe('her room at 375 px (N-01)', () => {
  it('her room shows her and her words only; the five and his voice time live in 目錄', async () => {
    renderAt('/me/home', {
      voice: { day: jstDay(), leftSeconds: 600, usedSeconds: 0, allowanceSeconds: 600, extensions: 0, extensionsLeft: 3, extendCost: 150, extendMinutes: 30, tts: false }
    });
    fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
    const index = screen.getByTestId('room-index');
    const row = screen.getByRole('group', { name: '交代' });
    expect(row.querySelectorAll('button')).toHaveLength(5);
    const meter = screen.getByTestId('voice-meter');
    expect(index.contains(meter)).toBe(true);
    expect(row.contains(meter)).toBe(false);
    expect(meter.textContent).toContain('10');
  });
});

describe('memory cards (N-20)', () => {
  it('a scene\'s card reads in the language of the moment, whatever language it was made in', async () => {
    const { ensureLang } = await import('../../src/i18n');
    await ensureLang('en');
    renderAt('/me/cards?tab=memory', { lang: 'en', memories: [
      { id: 'm1', star: 'mahiro', title: 'おかえりの夜', date: '2026-10-01', sceneId: 'demo-evening' },
      { id: 'm2', star: 'mahiro', title: '寒い夜のおかえり', date: '2026-10-02' }
    ] });
    expect(await screen.findByRole('img', { name: /A Night Back Home/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /寒い夜のおかえり/ })).toBeTruthy();
  });
});

describe('her chat header (N-24)', () => {
  it('shows her face, the same still as the home\'s partner row, not an empty circle', async () => {
    renderAt('/me/chat', { star: 'nana' });
    const avatar = await screen.findByTestId('star-avatar');
    const img = avatar.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/nana-(hero|breath)-9x16/);
  });
});

describe('promise and confession cards (N-25)', () => {
  it('read in the language of the moment, and a promise card has her picture', async () => {
    const { ensureLang } = await import('../../src/i18n');
    await ensureLang('en');
    renderAt('/me/cards?tab=memory', { lang: 'en', memories: [
      { id: 'p1', star: 'mahiro', title: '明日の夜、おかえりを言う', date: '2026-09-28', kind: 'promise' },
      { id: 'c1', star: 'mahiro', title: '告白', date: '2026-09-28', kind: 'confession', sceneId: 'confession-mahiro', still: 'mahiro-breath' }
    ] });
    const card = await screen.findByRole('img', { name: /Tomorrow night: welcome home/ });
    expect(card.dataset.still).toBe('mahiro-hero');
    expect(card.querySelector('img.art')).not.toBeNull();
    expect(screen.getByRole('img', { name: /The confession/ })).toBeTruthy();
  });
});

describe('memory cards after the voice merge (N-34)', () => {
  it('birthday, variant, older and stale-still cards: in the language of the moment, each with a picture', async () => {
    const { ensureLang } = await import('../../src/i18n');
    await ensureLang('en');
    renderAt('/me/cards?tab=memory', { lang: 'en', memories: [
      { id: 'b1', star: 'mahiro', title: '一緒に祝った誕生日', date: '2026-09-29', kind: 'scene', sceneId: 'her-birthday-mahiro' },
      { id: 'b2', star: 'mahiro', title: '祝ってもらった誕生日', date: '2026-09-29', kind: 'scene', sceneId: 'his-birthday-mahiro' },
      { id: 'v1', star: 'eimi', title: '新しい服と、キミの顔', date: '2026-09-29', kind: 'scene', sceneId: 'variant-eimi-1', still: 'eimi-no-such-clip' },
      // Older cards: made before the kind and the scene were sent.
      { id: 'o1', star: 'mahiro', title: 'おそろいのマグカップ', date: '2026-09-28' },
      { id: 'o2', star: 'mahiro', title: '告白', date: '2026-09-28' },
      { id: 'o3', star: 'mahiro', title: '明日の夜、おかえりを言う', date: '2026-09-28' }
    ] });
    for (const name of ['The birthday we celebrated', 'The birthday she celebrated with you', 'New Outfit, Your Face', 'A Matching Pair of Mugs', 'The confession', 'Tomorrow night: welcome home']) {
      const card = await screen.findByRole('img', { name: new RegExp(name) });
      expect(card.querySelector('img.art'), name).not.toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/[\u3041-\u3096]/);
  });
});
