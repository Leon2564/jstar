import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItemT, PromiseItemT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import { http } from '../../src/services/http';
import * as sound from '../../src/lib/sound';
import { promiseAt, promiseState, promiseWhen } from '../../src/components/promise';

/** The v1.1.3 verification's room items (C-room R1–R6, N10), in the real component. */
beforeAll(async () => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  await ensureLang('zh-Hant');
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function renderAt(patch: Partial<AppState> = {}, path = '/me/home') {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', ...patch } as AppState}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const ready = async () => { const r = await screen.findByTestId('room', {}, { timeout: 8000 }); await screen.findByTestId('room-replies', {}, { timeout: 4000 }); return r; };
const reply = (text: string, more: Record<string, unknown> = {}) => ({ reply: text, affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0, ...more });
/** Her subtitle measured as three 34 px lines of 22 characters (jsdom has no layout). */
function pagedLayout() {
  const style = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, p) => {
    const s = style(el, p);
    return (el as HTMLElement).classList?.contains('room2-measure') ? new Proxy(s, { get: (t, k) => (k === 'lineHeight' ? '34px' : Reflect.get(t, k)) }) : s;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('room2-measure') ? Math.ceil((this.textContent ?? '').length / 22) * 34 : 0;
  });
}

describe('R1: answering her invitation reads that invitation only', { timeout: 20_000 }, () => {
  it('her other messages stay unread — no read of them on 接聽 nor on ✦ 今晚見 — and stay in her room', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const at = new Date('2026-10-05T07:34:00+09:00');
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const due = '2026-10-05T11:00:00.000Z';
    vi.spyOn(http, 'sceneRoom').mockResolvedValue({ offer: null, invite: { sceneId: 'night-greenhouse', title: { ja: '夜の温室と、延長', 'zh-Hant': '夜裡的溫室，和延長', en: 'The greenhouse at night', ko: '밤의 온실' }, ready: false, dueAt: due, tonight: true } });
    const mk = (id: string, text: string, extra: Record<string, unknown>): InboxItemT => ({ id, star: 'alice', kind: 'message', payload: { text, ...extra }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() });
    const invite = mk('inv', '今晚能陪我聊聊金木犀嗎？', { herMessage: 'invite', sceneId: 'night-greenhouse' });
    const dream = mk('dream', '昨晚，你出現在我的夢裡。', { herMessage: 'dream' }), note = mk('note', '中午好。天氣陰陰的。', { herMessage: 'note' });
    const inbox = vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite, dream, note], unread: 3 });
    const fetched = vi.spyOn(globalThis, 'fetch');
    const readOne = vi.spyOn(http, 'inboxRead');
    // She calls from another star's room (the push's address): her room, her call.
    renderAt({ star: 'mahiro', inbox: [invite, dream, note] }, '/me/home?star=alice&inbox=inv');
    const answer = await screen.findByTestId('call-incoming-answer', {}, { timeout: 8000 });
    await act(async () => { fireEvent.click(answer); });
    expect((await screen.findByTestId('room-message-more', {}, { timeout: 4000 })).textContent).toContain('2');
    const tonight = await screen.findByTestId('inbox-tonight', {}, { timeout: 4000 });
    const reads = () => [...readOne.mock.calls.map((c) => String(c[0])), ...fetched.mock.calls.filter((c) => String(c[0]).includes('/inbox/')).map((c) => String(c[1]?.body))];
    expect(reads()).toEqual([]);
    // ✦ 今晚見: the server reads the invitation it answers (promises/tonight), nothing else.
    const promise: PromiseItemT = { id: 'p1', star: 'alice', text: '夜裡的溫室，和延長', kind: 'scene', status: 'open', source: 'proposal', dueAt: due, madeAt: at.toISOString(), keptAt: null, sceneId: 'night-greenhouse' };
    const made = vi.spyOn(http, 'promiseTonight').mockResolvedValue({ promise });
    inbox.mockResolvedValue({ items: [{ ...invite, readAt: at.toISOString() }, dream, note], unread: 2 });
    await act(async () => { fireEvent.click(tonight); });
    await waitFor(() => expect(made).toHaveBeenCalledWith('alice', 'night-greenhouse', 'inv', 'zh-Hant'));
    // Her messages take the floor again, unread: he sees them before they are read.
    expect(await screen.findByTestId('room-away', {}, { timeout: 4000 })).toBeTruthy();
    expect(reads()).toEqual([]);
  });
});

describe('R2: the message that uses the last free one', { timeout: 20_000 }, () => {
  const LONG = '說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。 那就不用說了。現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。';
  it('her reply plays and pages in full; the limit panel comes only after her last page', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue(reply(LONG, { chatLeft: 0 }));
    pagedLayout();
    renderAt();
    await ready();
    fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    await waitFor(() => expect(document.querySelector('.room2-bottom .js-more')).not.toBeNull(), { timeout: 4000 });
    // Page 1 of 2, and no panel over her words however long he stays on it.
    expect(document.querySelectorAll('.room2-pages .js-rules i')).toHaveLength(2);
    await act(async () => { await new Promise((r) => setTimeout(r, 2000)); });
    expect(screen.queryByTestId('room-limit')).toBeNull();
    expect(screen.getByTestId('room').hasAttribute('data-choose')).toBe(false);
    // His input is already closed (nothing more can go today).
    expect((document.getElementById('room-input') as HTMLInputElement).disabled).toBe(true);
    // ▼: her last page, still no panel while it is on screen.
    fireEvent.click(screen.getByTestId('room-cap').querySelector('.js-line')!);
    await waitFor(() => expect(screen.getByTestId('room-cap').querySelector('.js-line')!.textContent).toContain('泡著一杯呢。」'), { timeout: 4000 });
    expect(screen.queryByTestId('room-limit')).toBeNull();
    // ▼ on her last page: the panel, in his choices' place, under her last words.
    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByTestId('room-limit')).toBeTruthy();
    expect(document.querySelector('.room2-echo')!.textContent).toContain('泡著一杯呢');
  });

  it('a short reply: the panel follows once her words are typed out (not over them)', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue(reply('嗯，晚安。', { chatLeft: 0 }));
    renderAt();
    await ready();
    fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    expect(await screen.findByTestId('room-limit', {}, { timeout: 6000 })).toBeTruthy();
  });
});

describe('R4: her call rings, her room says nothing over it', { timeout: 20_000 }, () => {
  it('her second call (再睡5分鐘) from her 「來電 ›」 line in another\'s room: her ring, never her room\'s greeting voice on top', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: new Date('2026-10-03T08:00:00+09:00'), shouldAdvanceTime: true });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const played = vi.spyOn(sound, 'playVoice').mockResolvedValue(true);
    const at = Date.now();
    const wake: InboxItemT = { id: 'w4', star: 'nana', kind: 'wakeup', payload: { text: '起床囉', lineId: 'x', day: '2026-10-03' }, deliveredAt: new Date(at - 60_000).toISOString(), readAt: null, createdAt: new Date(at).toISOString() };
    const next: InboxItemT = { id: 'w5', star: 'nana', kind: 'wakeup', payload: { text: '再五分鐘到了喔！', lineId: 'y', day: '2026-10-03', snooze: true }, deliveredAt: new Date(at + 300_000).toISOString(), readAt: null, createdAt: new Date(at).toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake], unread: 1 });
    vi.spyOn(http, 'wakeSnooze').mockResolvedValue({ dueAt: new Date(at + 300_000).toISOString(), snoozeLeft: 0, next });
    vi.spyOn(http, 'wakeRing').mockResolvedValue({ item: next });
    renderAt({ star: 'nana', inbox: [wake] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    await act(async () => { fireEvent.click(screen.getByTestId('call-incoming-later')); });
    await waitFor(() => expect(screen.queryByTestId('call-incoming')).toBeNull());
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.click(await screen.findByTestId('star-rule-mahiro'));
    await waitFor(() => expect(screen.getByTestId('room').getAttribute('data-star')).toBe('mahiro'));
    await act(async () => { vi.advanceTimersByTime(301_000); });
    const line = await screen.findByTestId('call-elsewhere', {}, { timeout: 4000 });
    played.mockClear();
    fireEvent.click(line);
    await screen.findByTestId('call-incoming-line', {}, { timeout: 8000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(played.mock.calls.map((c) => c[0]).filter((u) => u.includes('/voice/greet/'))).toEqual([]);
  });
});

describe('R3 and R5: 目錄 says what it knows', { timeout: 20_000 }, () => {
  it('R3: 鬧鐘 reads 「…」 while his alarm is read, then his alarm (never 「未設定」 for a moment)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    let answer: (v: unknown) => void = () => {};
    vi.spyOn(http, 'alarm').mockReturnValue(new Promise((ok) => { answer = ok; }) as never);
    renderAt();
    await screen.findByTestId('room', {}, { timeout: 8000 });
    fireEvent.keyDown(window, { key: 'm' });
    const cell = await screen.findByTestId('alarm-chip');
    expect(cell.querySelector('small')!.textContent).toBe('…');
    await act(async () => { answer({ alarm: { star: 'mahiro', time: '07:30', days: [1, 2, 3, 4, 5], enabled: true, tz: 'Asia/Tokyo', nextAt: null, updatedAt: '' } }); });
    await waitFor(() => expect(screen.getByTestId('alarm-chip').querySelector('small')!.textContent).toBe('07:30 真尋'));
  });

  it('R5: a wake-up promise whose morning is over is the next morning she can keep it on — else missed, never 「她在等你」', () => {
    const p = { kind: 'wakeup' as const, star: 'mahiro' as const, dueAt: new Date(2026, 9, 5, 14, 32).toISOString(), status: 'open' as const, keptAt: null };
    // 11:14: this morning's 07:00 is over — tomorrow 07:00 (within her keeping window of its time).
    const late = new Date(2026, 9, 5, 11, 14).getTime();
    expect(promiseState(p, null, late)).toEqual({ at: new Date(2026, 9, 6, 7, 0).toISOString(), state: 'open' });
    expect(promiseAt(p, 'zh-Hant', null, late)).toBe(promiseWhen(new Date(2026, 9, 6, 7, 0).toISOString(), 'zh-Hant', late));
    // Still within her ring this morning: this morning.
    expect(promiseState(p, null, new Date(2026, 9, 5, 7, 20).getTime()).at).toBe(new Date(2026, 9, 5, 7, 0).toISOString());
    // Past every morning she could keep it on: missed.
    expect(promiseState(p, null, new Date(2026, 9, 6, 9, 0).getTime()).state).toBe('missed');
    // Kept or missed by the server: said so.
    expect(promiseState({ ...p, status: 'kept', keptAt: new Date(2026, 9, 5, 7, 1).toISOString() }, null, late).state).toBe('kept');
    expect(promiseState({ ...p, status: 'missed' }, null, late).state).toBe('missed');
    // His alarm with her, still to ring: its ring.
    const alarm = { star: 'mahiro' as const, enabled: true, nextAt: new Date(2026, 9, 6, 6, 45).toISOString() };
    expect(promiseState(p, alarm, late)).toEqual({ at: alarm.nextAt, state: 'open' });
  });

  it('R5: in 目錄 and its sheet, a missed wake-up promise reads 這次錯過了', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const now = new Date(2026, 9, 6, 9, 0);
    vi.useFakeTimers({ toFake: ['Date'], now });
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    vi.spyOn(http, 'alarm').mockResolvedValue({ alarm: null } as never);
    const promise: PromiseItemT = { id: 'p1', star: 'mahiro', text: '明天早上叫你起床', kind: 'wakeup', status: 'open', source: 'proposal', dueAt: new Date(2026, 9, 5, 14, 32).toISOString(), madeAt: new Date(2026, 9, 5, 2, 32).toISOString(), keptAt: null, sceneId: null };
    vi.spyOn(api, 'promises').mockResolvedValue({ promises: [promise], proposal: null });
    renderAt();
    await screen.findByTestId('room', {}, { timeout: 8000 });
    fireEvent.keyDown(window, { key: 'm' });
    const cell = await screen.findByTestId('next-promise', {}, { timeout: 4000 });
    await waitFor(() => expect(cell.querySelector('small')!.textContent).toBe('這次錯過了'));
    fireEvent.click(cell);
    const sheet = await screen.findByTestId('room-promise-item');
    expect(sheet.textContent).toContain('這次錯過了');
    expect(sheet.textContent).not.toContain('她在等你');
  });
});

describe('N10: the status line keeps both clocks', () => {
  it('her city and her sky are their own spans after the clocks; the sky gives way first', async () => {
    renderAt();
    const status = await screen.findByTestId('room-status', {}, { timeout: 8000 });
    const kids = [...status.children].map((c) => c.className);
    expect(kids[0]).toBe('room2-clocks');
    expect(kids).toContain('room2-days');
    const css = (await import('node:fs')).readFileSync('src/pages/room.css', 'utf8');
    expect(css).toMatch(/\.room2-status > \.room2-clocks, \.room2-status > \.room2-days \{ flex-shrink: 0; \}/);
    expect(css).toMatch(/\.room2-place > \.room2-sky \{ flex-shrink: 99; \}/);
  });
});
