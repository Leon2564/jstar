import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItemT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import { ApiError } from '../../src/services/http';
import { answerReplies, cameFromApp, lastWords, roomClock, wakeReplies } from '../../src/pages/roomV2';

/** The C-room acceptance of 47b0fcb (v1.1.0): her room's High and Medium items, in the real component. */
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
const choices = () => [...screen.getByTestId('room-replies').querySelectorAll('button')].map((b) => b.textContent!.replace(/^\d/, ''));
const OPENING = ['我回來了', '有點累', '早安', '剛起床', '午安', '在休息中'];
const reply = (text: string, more: Record<string, unknown> = {}) => ({ reply: text, affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0, ...more });

describe('C-room fixes (47b0fcb)', { timeout: 20_000 }, () => {
  it('H1: he came from the app only when the router\'s history index says so (a star switch replaces, keeping 0)', () => {
    window.history.replaceState({ usr: null, key: 'a', idx: 0 }, '');
    expect(cameFromApp()).toBe(false);
    window.history.replaceState({ usr: null, key: 'b', idx: 2 }, '');
    expect(cameFromApp()).toBe(true);
    window.history.replaceState(null, '');
    expect(cameFromApp()).toBe(false);
  });

  it('M4: the status line labels her clock (Japan) and adds his when it differs', () => {
    const at = new Date('2026-10-04T19:05:00Z'); // 04:05 on 10/5 in Japan
    const line = roomClock(at, 'zh-Hant');
    expect(line.startsWith('10/5　日本 04:05')).toBe(true);
    if (at.getTimezoneOffset() !== -540) expect(line).toMatch(/ · 你 \d\d:\d\d$/);
    expect(roomClock(at, 'en')).toContain('Japan 04:05');
  });

  it('M1: without her own suggestions, his choices answer her LAST sentence, not her whole reply', async () => {
    const offer = '下次放假的時候，我們要不要一起去那個很遠很遠的海邊，看看日出好不好？';
    const said = '今天先好好休息吧，晚安。';
    expect(lastWords(offer + said)).toBe(said);
    vi.spyOn(api, 'chat').mockResolvedValue(reply(offer + said));
    renderAt();
    await ready();
    fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    await waitFor(() => expect(screen.queryByTestId('room-replies')).not.toBeNull(), { timeout: 8000 });
    const shown = choices();
    expect(shown).toEqual(answerReplies(said, 'zh-Hant'));
    // The said set (真的嗎？ / 然後呢？ …), never the offer set (好啊，就這麼說定 / 下次吧 …).
    for (const r of shown) expect(['真的嗎？', '然後呢？', '謝謝你', '我懂', '好可愛']).toContain(r);
  });

  it('M2: after 接聽 her wake-up call, his choices answer her wake-up line — never the opening set', async () => {
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    const wake: InboxItemT = { id: 'w9', star: 'nana', kind: 'wakeup', payload: { text: '起床囉！今天也一起加油吧。' }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake], unread: 1 });
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...wake, readAt: at.toISOString() }, unread: 0 });
    renderAt({ star: 'nana' });
    fireEvent.click(await screen.findByTestId('call-incoming-answer', {}, { timeout: 8000 }));
    await waitFor(() => expect(screen.queryByTestId('room-replies')).not.toBeNull(), { timeout: 8000 });
    expect(choices()).toEqual(wakeReplies('zh-Hant'));
    for (const r of choices()) expect(OPENING).not.toContain(r);
  });

  it('M2 / M7: his answer to her naming question brings answer replies; a question offering his own name is never asked', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    const bond = vi.spyOn(api, 'bondOf').mockResolvedValue({ star: 'mahiro', callName: 'ケンタさん', callStage: 'new', ask: { to: 'familiar', text: '……ねえ、これからはケンタくんって呼んでもいい？' }, praise: {} } as never);
    vi.spyOn(api, 'answerCallName').mockResolvedValue({ reply: 'ふふ、ありがとう。ケンタくん。', callName: 'ケンタくん' } as never);
    renderAt();
    fireEvent.click(await screen.findByTestId('call-yes', {}, { timeout: 8000 }));
    await waitFor(() => expect(screen.getByTestId('greeting').textContent).toBe('ふふ、ありがとう。ケンタくん。'));
    await waitFor(() => expect(screen.queryByTestId('room-replies')).not.toBeNull(), { timeout: 8000 });
    expect(choices()).toEqual(answerReplies(lastWords('ふふ、ありがとう。ケンタくん。'), 'zh-Hant'));
    for (const r of choices()) expect(OPENING).not.toContain(r);
    cleanup();

    // M7: she already calls him ケンタ — 「可以直接叫你「ケンタ」嗎？」 is not asked.
    bond.mockResolvedValue({ star: 'unpai', callName: 'ケンタ', callStage: 'new', ask: { to: 'familiar', text: '欸，可以直接叫你「ケンタ」嗎？' }, praise: {} } as never);
    renderAt({ star: 'unpai' });
    await screen.findByTestId('room', {}, { timeout: 8000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(screen.queryByTestId('call-ask')).toBeNull();
    expect(screen.queryByTestId('call-yes')).toBeNull();
  });

  it('M3: out of messages, the limit panel shows at once — even while her last reply is on its first page', async () => {
    const LONG = '說不上來也沒關係的。有時候一整天就是這樣，淡淡的，沒有什麼特別的。 那就不用說了。現在只要待在這裡就好，我陪你一起把今天慢慢收尾。……要不要喝點溫熱的東西？我這邊正泡著一杯呢。';
    const chat = vi.spyOn(api, 'chat').mockResolvedValueOnce(reply(LONG, { chatLeft: 1 })).mockRejectedValue(new ApiError('daily_limit', 402));
    const style = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, p) => {
      const s = style(el, p);
      return (el as HTMLElement).classList?.contains('room2-measure') ? new Proxy(s, { get: (t, k) => (k === 'lineHeight' ? '34px' : Reflect.get(t, k)) }) : s;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('room2-measure') ? Math.ceil((this.textContent ?? '').length / 22) * 34 : 0;
    });
    renderAt();
    await ready();
    fireEvent.click(screen.getByTestId('room-replies').querySelector('button')!);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    await waitFor(() => expect(document.querySelectorAll('.room2-pages .js-rules i').length).toBeGreaterThan(1), { timeout: 4000 });
    // Page 1 of her reply; he types something else and sends: 402.
    fireEvent.change(document.getElementById('room-input')!, { target: { value: '再聊一下' } });
    fireEvent.submit(screen.getByTestId('room-composer'));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('room-limit', {}, { timeout: 1500 })).toBeTruthy();
  });

  it('M5: the date line of her message stays over her last words once his choices show', async () => {
    const m: InboxItemT = { id: 'm1', star: 'mahiro', kind: 'message', payload: { text: '今天好想你。' }, deliveredAt: '2026-10-01T03:00:00.000Z', readAt: null, createdAt: '2026-10-01T03:00:00.000Z' };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [m], unread: 1 });
    renderAt();
    const when = await screen.findByTestId('room-message-when', {}, { timeout: 8000 });
    expect(when.closest('.room2-choose')).not.toBeNull();
    expect(when.textContent).toContain('留言');
  });

  it('L6: 目錄 takes the focus as it opens, and Esc in its own field closes it', async () => {
    renderAt();
    await ready();
    fireEvent.keyDown(window, { key: 'm' });
    const index = await screen.findByTestId('room-index');
    await waitFor(() => expect(document.activeElement).toBe(index));
    const field = document.createElement('input');
    index.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('room-index')).toBeNull());
  });
});
