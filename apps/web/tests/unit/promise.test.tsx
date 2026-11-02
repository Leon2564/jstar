import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItemT, PromiseItemT, PromiseProposalT } from '@jstar/shared/contracts';
import { PROMISE_RULES } from '@jstar/shared/rules';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { fmtWhen } from '../../src/i18n';
import * as api from '../../src/services/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, ...patch }}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

// 2026-09-27 21:00 JST
const DUE = '2026-09-27T12:00:00.000Z';
const promise = (patch: Partial<PromiseItemT> = {}): PromiseItemT => ({
  id: 'prm_1', star: 'nana', text: '夜9時、朗読を聞かせる', kind: 'scene', status: 'open', source: 'chat',
  dueAt: DUE, madeAt: '2026-09-26T11:00:00.000Z', keptAt: null, sceneId: null, ...patch
});
const proposal: PromiseProposalT = { star: 'nana', lineId: 'tea', kind: 'scene', propose: '明日の朝、お茶を淹れて続きを読もうか？', text: '明日の朝、お茶を淹れて続きを読む', dueAt: DUE };
const reply = (patch = {}) => ({ reply: 'うん', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0, ...patch });

async function say(text: string) {
  fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await screen.findByText('うん', { selector: '.msg.her' });
}

describe('promises (#59)', () => {
  it('shows the next promise with her on the companion home: when (JST) and what', async () => {
    vi.spyOn(api, 'promises').mockResolvedValue({ promises: [promise({ star: 'mahiro', id: 'x' }), promise()], proposal: null });
    renderAt('/me/home', { star: 'nana' });
    // The home is a lazy route: on a loaded machine its first render can take a few seconds. Her room's 目錄 (A2) holds it.
    fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
    const card = await screen.findByTestId('next-promise', {}, { timeout: 8000 });
    expect(fmtWhen(DUE, 'ja')).toMatch(/9\/27.*21:00/);
    // Round 12: shown on his own clock (this machine's zone), Japan's only when his is Japan's.
    const { promiseWhen } = await import('../../src/components/promise');
    expect(card.textContent).toBe(`02約束${promiseWhen(DUE, 'ja')}`);
    expect(card.getAttribute('aria-label')).toBe(`奈々との次の約束：夜9時、朗読を聞かせる（${promiseWhen(DUE, 'ja')}）`);
    // C-room L9: 約定 opens her room's own sheet, never her chat page.
    fireEvent.click(card);
    const sheet = await screen.findByTestId('room-promise-sheet');
    expect(sheet.textContent).toContain(promiseWhen(DUE, 'ja'));
    expect(sheet.textContent).toContain('朗読を聞かせる');
  });

  it('shows no card without a promise with her, or without the server', async () => {
    renderAt('/me/home', { star: 'nana' });
    await screen.findByTestId('greeting');
    expect(screen.queryByTestId('next-promise')).toBeNull();
  });

  it('brings up the next time as he leaves her chat; 「約束する」 makes it and he goes home', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValueOnce({ promises: [], proposal }).mockResolvedValue({ promises: [promise({ source: 'proposal', text: proposal.text })], proposal: null });
    vi.spyOn(api, 'chat').mockResolvedValue(reply());
    const make = vi.spyOn(api, 'makePromise').mockResolvedValue(promise({ source: 'proposal', text: proposal.text }));
    renderAt('/me/chat', { star: 'nana' });
    // Leaving before he said anything: no proposal, he just goes.
    await waitFor(() => expect(api.promises).toHaveBeenCalled());
    await say('ただいま');
    fireEvent.click(screen.getByRole('link', { name: 'ホームへ戻る' }));
    const offer = await screen.findByTestId('promise-offer');
    expect(offer.textContent).toContain('明日の朝、お茶を淹れて続きを読もうか？');
    fireEvent.click(screen.getByRole('button', { name: '約束する' }));
    await waitFor(() => expect(make).toHaveBeenCalledWith('nana', 'tea', 'ja'));
    // Round 10: the card counts the day when shown, never a 「明日」 frozen into her words.
    fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
    const card = (await screen.findByTestId('next-promise')).getAttribute('aria-label') ?? '';
    expect(card).toContain('朝、お茶を淹れて続きを読む');
    expect(card).not.toContain('明日の朝');
  });

  it('lets him leave without one: 「また今度」', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue({ promises: [], proposal });
    vi.spyOn(api, 'chat').mockResolvedValue(reply());
    const make = vi.spyOn(api, 'makePromise');
    renderAt('/me/chat', { star: 'nana' });
    await waitFor(() => expect(api.promises).toHaveBeenCalled());
    await say('ただいま');
    fireEvent.click(screen.getByRole('link', { name: 'ホームへ戻る' }));
    fireEvent.click(await screen.findByRole('button', { name: 'また今度' }));
    await screen.findByTestId('greeting');
    expect(make).not.toHaveBeenCalled();
  });

  it('brings it up after ten quiet minutes in the chat', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue({ promises: [], proposal });
    vi.spyOn(api, 'chat').mockResolvedValue(reply());
    renderAt('/me/chat', { star: 'nana' });
    await waitFor(() => expect(api.promises).toHaveBeenCalled());
    await say('ただいま');
    expect(screen.queryByTestId('promise-offer')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(PROMISE_RULES.idleProposeMs + 10); });
    expect(await screen.findByTestId('promise-offer')).toBeTruthy();
  });

  it('notes a promise both agreed on in the conversation, right after her reply', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue({ promises: [], proposal: null });
    vi.spyOn(api, 'chat').mockResolvedValue(reply({ promise: promise() }));
    renderAt('/me/chat', { star: 'nana' });
    await say('明日の夜9時に朗読聞かせて');
    const note = await screen.findByTestId('promise-made');
    const { promiseWhen } = await import('../../src/components/promise');
    expect(note.textContent).toBe(`約束したよ。${promiseWhen(DUE, 'ja')}、夜9時、朗読を聞かせる`);
    const log = [...document.querySelectorAll('.chat-body > *')].map((e) => e.getAttribute('data-testid') ?? e.textContent);
    expect(log.filter(Boolean).slice(-3)).toEqual(['明日の夜9時に朗読聞かせて', 'うん', 'promise-made']);
  });

  it('opening her promise line in time keeps it, and a promised scene can be played again from there', async () => {
    const line: InboxItemT = { id: 'inb_prm_1', star: 'mahiro', kind: 'promise_due', payload: { text: '昨日の約束、覚えてる？「明日も、ここで待ってるね」', promiseId: 'prm_1', sceneId: 'demo-evening' }, deliveredAt: DUE, readAt: null, createdAt: DUE };
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue({ promises: [], proposal: null });
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...line, readAt: DUE }, unread: 0, promise: promise({ star: 'mahiro', status: 'kept', sceneId: 'demo-evening' }) });
    renderAt('/me/chat?inbox=inb_prm_1', { star: 'mahiro', inbox: [line] });
    expect((await screen.findByTestId('chat-inbox')).textContent).toBe('昨日の約束、覚えてる？「明日も、ここで待ってるね」');
    expect((await screen.findByTestId('promise-scene')).getAttribute('href')).toBe('/me/scene/demo-evening');
  });
});

describe('the day on a promise card (round 10)', () => {
  it('is counted when shown: tonight / tomorrow while near, the date after', async () => {
    const { promiseWhen } = await import('../../src/components/promise');
    const at15 = Date.parse('2026-10-01T06:00:00Z'); // 15:00 JST
    const tokyo = 'Asia/Tokyo';
    expect(promiseWhen('2026-10-01T12:00:00Z', 'ja', at15, tokyo)).toBe('今夜 21:00');
    // Round 12: a capital at the start of 「It's a promise. {when}: …」.
    expect(promiseWhen('2026-10-02T00:00:00Z', 'en', at15, tokyo)).toBe('Tomorrow, 09:00');
    expect(promiseWhen('2026-10-01T16:00:00Z', 'ko', at15, tokyo)).toBe('오늘 밤 01:00');
    expect(promiseWhen('2026-10-05T12:00:00Z', 'ja', at15, tokyo)).not.toMatch(/今夜|明日/);
    // Round 12: on his own clock — 23:00 in Taipei is 23:00 there, not Tokyo's midnight.
    expect(promiseWhen('2026-10-01T15:00:00Z', 'zh-Hant', at15, 'Asia/Taipei')).toBe('今晚 23:00');
    expect(promiseWhen('2026-10-01T15:00:00Z', 'zh-Hant', at15, tokyo)).toBe('今晚 00:00');
  });
});
