import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItemT } from '@jstar/shared/contracts';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';
import * as inboxRead from '../../src/services/inboxRead';
import { messageStill } from '../../src/pages/me';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

const item = (id: string, star: InboxItemT['star'], patch: Partial<InboxItemT> = {}): InboxItemT => ({
  id, star, kind: 'message', payload: { text: `${star}: ${id}` }, deliveredAt: '2026-10-01T00:00:00.000Z', readAt: null, createdAt: '2026-09-30T00:00:00.000Z', ...patch
});

/** Her name in her room's 目錄 (A2, #163) carries her unread count. */
const openIndex = async () => fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));

describe('her inbox on the companion home (#49)', () => {
  it('shows each talent\'s unread count on her face, and nothing for read items', async () => {
    vi.spyOn(api, 'inbox').mockResolvedValue({
      items: [item('n2', 'nana'), item('n1', 'nana'), item('e1', 'eimi', { readAt: '2026-10-01T01:00:00.000Z' })], unread: 2
    });
    renderAt('/me/home');
    await openIndex();
    expect((await screen.findByTestId('inbox-badge-nana')).textContent).toBe('2');
    expect(screen.queryByTestId('inbox-badge-eimi')).toBeNull();
    expect(screen.getByRole('button', { name: /未読2件/ })).toBeTruthy();
  });

  it('picking her opens her room, where her messages play one by one (②); after the last they are read', async () => {
    const newest = item('n2', 'nana', { payload: { text: 'ねえ、起きてる？' } });
    const older = item('n1', 'nana', { payload: { text: 'お昼、何食べた？' } });
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [newest, older], unread: 2 });
    const read = vi.spyOn(api, 'readInbox').mockImplementation(async (id) => ({ item: { ...(id === 'n2' ? newest : older), readAt: '2026-10-01T02:00:00.000Z' }, unread: 0 }));
    renderAt('/me/home', { star: 'mahiro' });
    await openIndex();
    fireEvent.click(await screen.findByRole('button', { name: /未読2件/ }));
    await waitFor(() => expect(latest.star).toBe('nana'));
    // Oldest first, as she left them.
    expect((await screen.findByTestId('room-message')).textContent).toBe('お昼、何食べた？');
    expect(screen.getByTestId('room-away').textContent).toContain('2');
    // B: NEXT comes with his choices, in her subtitle's place, once her message has typed out.
    fireEvent.click(await screen.findByTestId('room-message-next', {}, { timeout: 4000 }));
    expect((await screen.findByTestId('room-message')).textContent).toBe('ねえ、起きてる？');
    expect(read).not.toHaveBeenCalled();
    // B: NEXT comes with his choices, in her subtitle's place, once her message has typed out.
    fireEvent.click(await screen.findByTestId('room-message-next', {}, { timeout: 4000 }));
    await waitFor(() => expect(latest.inbox.filter((i) => !i.readAt)).toHaveLength(0));
    expect(screen.queryByTestId('room-message')).toBeNull();
  });

  it('answering her first message keeps ② going: the next waits behind her answer, and all he saw are read (QA #2)', async () => {
    const one = item('n1', 'mahiro', { payload: { text: 'お昼、何食べた？' }, deliveredAt: '2026-10-01T01:00:00.000Z' });
    const two = item('n2', 'mahiro', { payload: { text: 'ねえ、起きてる？' } });
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [two, one], unread: 2 });
    const read = vi.spyOn(api, 'readInbox').mockImplementation(async (id) => ({ item: { ...(id === 'n1' ? one : two), readAt: '2026-10-01T02:00:00.000Z' }, unread: 0 }));
    renderAt('/me/home', { star: 'mahiro' });
    expect((await screen.findByTestId('room-message', {}, { timeout: 8000 })).textContent).toBe('お昼、何食べた？');
    // He answers her first message instead of NEXT (his choices come once her line has typed out).
    fireEvent.click((await screen.findByTestId('room-replies', {}, { timeout: 4000 })).querySelector('button')!);
    await screen.findByTestId('room-her', {}, { timeout: 8000 });
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('room-message-more'));
    expect((await screen.findByTestId('room-message')).textContent).toBe('ねえ、起きてる？');
    // B: NEXT comes with his choices, in her subtitle's place, once her message has typed out.
    fireEvent.click(await screen.findByTestId('room-message-next', {}, { timeout: 4000 }));
    await waitFor(() => expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(['n1', 'n2']));
    expect(screen.queryByTestId('room-message-more')).toBeNull();
  });

  it('② shows a voice note only when her message carries one, and a photo of its own or one of her stills (QA #5)', async () => {
    const plain = item('p1', 'mahiro', { payload: { text: '雨だね。' } });
    // jsdom loads no media: her recording's header says 6.2 s.
    vi.stubGlobal('Audio', class { duration = 6.2; onloadedmetadata: (() => void) | null = null; constructor() { setTimeout(() => this.onloadedmetadata?.(), 0); } });
    const voiced = item('p2', 'mahiro', { payload: { text: '聞いて。', audio: '/voice/msg/p2.mp3', photo: '/media/msg/p2.jpg' }, deliveredAt: '2026-10-01T03:00:00.000Z' });
    // Her still turns with the message, the same each time; a message's own photo wins.
    const stills = new Set(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map((id) => messageStill(item(id, 'mahiro'))));
    expect(stills.size).toBeGreaterThan(1);
    expect(messageStill(item('a1', 'mahiro'))).toBe(messageStill(item('a1', 'mahiro')));
    expect(messageStill(voiced)).toBe('/media/msg/p2.jpg');
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [voiced, plain], unread: 2 });
    renderAt('/me/home', { star: 'mahiro' });
    expect((await screen.findByTestId('room-message', {}, { timeout: 8000 })).textContent).toBe('雨だね。');
    expect(document.querySelector('.js-voice')).toBeNull();
    // B: NEXT comes with his choices, in her subtitle's place, once her message has typed out.
    fireEvent.click(await screen.findByTestId('room-message-next', {}, { timeout: 4000 }));
    expect((await screen.findByTestId('room-message')).textContent).toBe('聞いて。');
    expect(document.querySelector('.js-voice')).not.toBeNull();
    // Its waveform carries its length (#165), read from her recording.
    await waitFor(() => expect(document.querySelector('.js-voice-time')!.textContent).toBe('0:06'));
    expect(document.querySelector('.js-print')!.getAttribute('src')).toBe('/media/msg/p2.jpg');
  });

  it('her words for the day (a calendar event) play in her room too (②)', async () => {
    const ev = item('c1', 'mahiro', { kind: 'event', payload: { text: 'メリークリスマス！', calendar: 'season', season: 'christmas' } });
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [ev], unread: 1 });
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...ev, readAt: '2026-10-01T02:00:00.000Z' }, unread: 0 });
    renderAt('/me/home', { star: 'mahiro' });
    expect((await screen.findByTestId('room-message', {}, { timeout: 8000 })).textContent).toBe('メリークリスマス！');
  });

  it('an item with a scene: picking her opens her room on her line with ✦, which opens that scene — never her chat (R18, M6)', async () => {
    // N1: a scene that can start now (her demo evening plays at any hour) — prototype mode works it out from the script.
    const newest = item('n2', 'mahiro', { payload: { text: 'ねえ、起きてる？', sceneId: 'demo-evening' } });
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [newest], unread: 1 });
    const read = vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...newest, readAt: '2026-10-01T02:00:00.000Z' }, unread: 0 });
    vi.spyOn(api, 'history').mockResolvedValue(null);
    renderAt('/me/home', { star: 'nana' });
    await openIndex();
    fireEvent.click(await screen.findByRole('button', { name: /未読1件/ }));
    expect((await screen.findByTestId('inbox-line', {}, { timeout: 4000 })).textContent).toBe('ねえ、起きてる？');
    expect(screen.queryByTestId('chat-inbox')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const invite = await screen.findByTestId('inbox-invite', {}, { timeout: 4000 });
    expect(invite.textContent).toContain('シーンへ');
    fireEvent.click(invite);
    expect(await screen.findByTestId('scene', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByTestId('chat-inbox')).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledWith('n2'));
    expect(latest.star).toBe('mahiro');
  });

  it('her messages read in her room are read in one request, and her badge clears (N-44)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    const newest = item('u7', 'unpai', { payload: { text: 'ねえねえ' } });
    const items = [newest, ...[1, 2, 3, 4, 5, 6].map((n) => item(`u${n}`, 'unpai')), item('e1', 'eimi')];
    vi.spyOn(api, 'inbox').mockResolvedValue({ items, unread: 8 });
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...newest, readAt: '2026-10-01T02:00:00.000Z' }, unread: 7 });
    vi.spyOn(api, 'history').mockResolvedValue(null);
    const readAll = vi.spyOn(inboxRead, 'readHerLines').mockImplementation(async (star) => ({
      items: items.map((i) => (i.star === star ? { ...i, readAt: '2026-10-01T02:00:00.000Z' } : i)), unread: 1
    }));
    renderAt('/me/home', { star: 'mahiro' });
    await openIndex();
    expect((await screen.findByTestId('inbox-badge-unpai')).textContent).toBe('7');
    fireEvent.click(screen.getByRole('button', { name: /未読7件/ }));
    // Her room plays the newest five; the last 「NEXT」 reads the five he saw in one request.
    for (let i = 0; i < 5; i++) fireEvent.click(await screen.findByTestId('room-message-next'));
    await waitFor(() => expect(readAll).toHaveBeenCalledWith('unpai', false, ['u4', 'u3', 'u2', 'u1', 'u7']));
    await waitFor(() => expect(latest.inbox.filter((i) => i.star === 'unpai' && !i.readAt)).toHaveLength(0));
    // Another talent's line is hers to open.
    expect(latest.inbox.find((i) => i.id === 'e1')?.readAt).toBeNull();
  });

  it('keeps her line above what he sends next', async () => {
    const it1 = item('a1', 'alice', { kind: 'wakeup', payload: {} });
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...it1, readAt: '2026-10-01T02:00:00.000Z' }, unread: 0 });
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'chat').mockResolvedValue({ reply: 'おはよう', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0 });
    renderAt('/me/chat?inbox=a1', { star: 'alice', inbox: [it1] });
    // A kind without text still opens with a line of hers.
    expect((await screen.findByTestId('chat-inbox')).textContent).toBe('あなたに、伝えたいことがあって。');
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'おはよう' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('おはよう', { selector: '.msg.her' });
    const lines = [...document.querySelectorAll('.chat-body .msg')].map((p) => p.textContent);
    expect(lines).toEqual(['あなたに、伝えたいことがあって。', 'おはよう', 'おはよう']);
  });

  it('shows no badge without the server (prototype mode)', async () => {
    renderAt('/me/home');
    await screen.findByTestId('greeting');
    expect(document.querySelector('.inbox-badge')).toBeNull();
    expect(latest.inbox).toEqual([]);
  });
});

describe('his own messages (N-50)', () => {
  it('a reply sent as her chat opens stays on screen when the server\'s history comes back after it', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [], unread: 0 });
    let historyBack: (v: never[]) => void = () => undefined;
    vi.spyOn(api, 'history').mockReturnValue(new Promise((r) => { historyBack = r as never; }) as never);
    vi.spyOn(api, 'chat').mockResolvedValue({ reply: 'おかえり。', affinityXp: 10, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0 } as never);
    renderAt('/me/chat?say=%E3%81%9F%E3%81%A0%E3%81%84%E3%81%BE', { star: 'mahiro' });
    expect(await screen.findByText('おかえり。')).toBeTruthy();
    // The history of a fresh account (empty) arrives after the turn: his line and her reply are still there.
    historyBack([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('ただいま')).toBeTruthy();
    expect(latest.chats.mahiro.map((m) => m.from)).toEqual(['me', 'her']);
  });

  it('merges without doubling what the server already has', async () => {
    const { mergeHistory } = await import('../../src/pages/me');
    const here = new Set(['l1', 'l2']);
    const local = [{ id: 'l1', from: 'me' as const, text: 'ただいま' }, { id: 'l2', from: 'her' as const, text: 'おかえり。' }];
    expect(mergeHistory([], local, here)).toEqual(local);
    const server = [{ id: 's1', from: 'me' as const, text: 'ただいま' }, { id: 's2', from: 'her' as const, text: 'おかえり。' }];
    expect(mergeHistory(server, local, here)).toEqual(server);
  });
});

describe('a send that does not go (N-58)', () => {
  const ok = { reply: 'おかえり。', affinityXp: 10, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0 } as never;

  it('her service busy twice: his bubble says it did not go, and one tap sends it again', async () => {
    const { ApiError } = await import('../../src/services/http');
    vi.spyOn(api, 'history').mockResolvedValue(null);
    const send = vi.spyOn(api, 'chat')
      .mockRejectedValueOnce(new ApiError('agent_unavailable', 503))
      .mockRejectedValueOnce(new ApiError('agent_unavailable', 503))
      .mockResolvedValueOnce(ok);
    renderAt('/me/chat', { star: 'mahiro' });
    fireEvent.change(await screen.findByLabelText('メッセージ'), { target: { value: 'ただいま' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    const failed = await screen.findByTestId('chat-failed', {}, { timeout: 6000 });
    expect(failed.textContent).toContain('送れませんでした');
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.getByText('ただいま')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送る' }));
    expect(await screen.findByText('おかえり。')).toBeTruthy();
    expect(screen.queryByTestId('chat-failed')).toBeNull();
    expect(latest.chats.mahiro.map((m) => [m.from, m.text])).toEqual([['me', 'ただいま'], ['her', 'おかえり。']]);
  });

  it('a dropped connection is tried once more by itself; so is a 429 (after its Retry-After), then it says so', async () => {
    const { ApiError } = await import('../../src/services/http');
    vi.spyOn(api, 'history').mockResolvedValue(null);
    const send = vi.spyOn(api, 'chat').mockRejectedValueOnce(new ApiError('network', 0)).mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new ApiError('rate_limited', 429, 20)).mockRejectedValueOnce(new ApiError('rate_limited', 429, 20));
    renderAt('/me/chat', { star: 'mahiro' });
    fireEvent.change(await screen.findByLabelText('メッセージ'), { target: { value: 'ただいま' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText('おかえり。', {}, { timeout: 6000 })).toBeTruthy();
    expect(screen.queryByTestId('chat-failed')).toBeNull();
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'もう一回' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect((await screen.findByTestId('chat-failed')).textContent).toContain('送れませんでした');
    expect(send).toHaveBeenCalledTimes(4);
  });
});
