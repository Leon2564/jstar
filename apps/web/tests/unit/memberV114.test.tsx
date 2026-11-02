/**
 * The v1.1.3 verification's member-page items (B-R1–R3, L7, P2) in the real components.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { jstDay } from '@jstar/shared/rules';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import { http, setToken } from '../../src/services/http';
import * as push from '../../src/lib/push';
import { PushOffer, REPLIED_EVENT, REPLIED_WAIT_MS } from '../../src/components/pushOffer';
import { oneLine } from '../../src/pages/flows';

beforeAll(async () => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  await ensureLang('zh-Hant');
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); setToken(null); });

const member = { ageOk: true, birthdayOk: true, lang: 'zh-Hant', user: { via: 'email' as const, nickname: 'kenta' }, star: 'mahiro' as const };
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ...member, ...patch } as AppState}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const me = (left: number | null) => ({ chat: { left, passUntil: null } }) as never;

describe('B-R1: 「沒有送出 再送一次」 on her chat\'s night', { timeout: 20_000 }, () => {
  it('reads in the room\'s rose-glow (AA on navy), never rose-text', async () => {
    vi.spyOn(api, 'chat').mockRejectedValue(new Error('boom'));
    renderAt('/me/chat');
    fireEvent.change(await screen.findByPlaceholderText(/./, { selector: '#chat-input' }), { target: { value: '在嗎' } });
    fireEvent.submit(document.getElementById('chat-input')!.closest('form')!);
    const failed = await screen.findByTestId('chat-failed', {}, { timeout: 6000 });
    expect(failed.style.color).toBe('var(--rose-glow)');
    expect(failed.querySelector('button')!.style.color).toBe('inherit');
  });
});

describe('B-L7: at the chat limit, no mic', { timeout: 20_000 }, () => {
  it('her chat page shows the limit and no mic, as her room does', async () => {
    const real = (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = function Fake() { /* a mic that could listen */ };
    try {
      renderAt('/me/chat', { chatDay: jstDay(), chatUsed: 999, passUntil: null });
      expect(await screen.findByTestId('chat-limit', {}, { timeout: 8000 })).toBeTruthy();
      expect(screen.queryByTestId('mic')).toBeNull();
    } finally {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
      if (real) (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = real;
    }
  });
});

describe('B-R2: today\'s count is the server\'s, without a reload', { timeout: 20_000 }, () => {
  it('asked as her chat opens, and again when he comes back to the tab (focus, visibilitychange)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    setToken('t');
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const ask = vi.spyOn(http, 'me').mockResolvedValue(me(12));
    renderAt('/me/chat', { chatDay: jstDay(), chatUsed: 0 });
    await waitFor(() => expect(screen.getByTestId('chat-left').textContent).toContain('12'), { timeout: 6000 });
    expect(ask).toHaveBeenCalledTimes(1);
    // He used some on his phone; back on this tab (after the few seconds one ask serves), the count follows.
    ask.mockResolvedValue(me(3));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6_000 });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('chat-left').textContent).toContain('3'));
    ask.mockResolvedValue(me(0));
    vi.setSystemTime(Date.now() + 6_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByTestId('chat-limit', {}, { timeout: 4000 })).toBeTruthy();
  });

  it('asked as her room opens too', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    setToken('t');
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    vi.spyOn(http, 'me').mockResolvedValue(me(0));
    renderAt('/me/home', { chatDay: jstDay(), chatUsed: 0 });
    expect(await screen.findByTestId('room-limit', {}, { timeout: 8000 })).toBeTruthy();
  });
});

describe('B-R3: her notifications wait for him to read his choices', () => {
  it('a few seconds after her reply — and a tap in that time is him answering: the offer waits for her next reply', async () => {
    vi.useFakeTimers();
    vi.spyOn(push, 'pushStatus').mockResolvedValue('off');
    render(<StoreProvider initial={{ ...initialState(), ...member } as AppState}><PushOffer /></StoreProvider>);
    act(() => { window.dispatchEvent(new Event(REPLIED_EVENT)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByTestId('push-offer')).toBeNull();
    // He taps one of his choices: not now.
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLIED_WAIT_MS + 500); });
    expect(screen.queryByTestId('push-offer')).toBeNull();
    // Her next reply, and he reads his choices: the offer.
    act(() => { window.dispatchEvent(new Event(REPLIED_EVENT)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLIED_WAIT_MS - 200); });
    expect(screen.queryByTestId('push-offer')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByTestId('push-offer')).toBeTruthy();
  });
});

describe('B-P2: her trial greeting as one line', () => {
  it('no half-width space after a full-width stop; one between Latin sentences', () => {
    expect(oneLine('你來了呀。\n我等了你一下下喔。')).toBe('你來了呀。我等了你一下下喔。');
    expect(oneLine('おかえり。\n今日もおつかれさま。')).toBe('おかえり。今日もおつかれさま。');
    expect(oneLine('You came.\nI waited a little.')).toBe('You came. I waited a little.');
  });
});
