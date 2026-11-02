import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatSendResT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';
import { ApiError, readChatStream } from '../../src/services/http';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

const result = (reply: string, extra: Partial<ChatSendResT> = {}): ChatSendResT => ({
  reply, affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0, ...extra
});

/** A Response whose NDJSON body arrives in the given chunks (split anywhere, even mid-line or mid-character). */
function ndjson(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); }
  });
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('streamed chat turn (NDJSON)', () => {
  it('reads deltas split across chunks, honours a replace, and resolves with the stored result', async () => {
    const done = JSON.stringify({ type: 'done', result: result('ふふ、おかえり。') });
    const lines = [
      '{"type":"delta","text":"ふふ"}\n{"type":"del', 'ta","text":"、おか"}\n', '{"type":"delta","text":"えり"}\n',
      '{"type":"replace","text":"ふふ、おかえり。"}\n', `${done.slice(0, 20)}`, `${done.slice(20)}\n`
    ];
    const seen: string[] = [];
    const r = await readChatStream(ndjson(lines), (t) => seen.push(t));
    expect(seen).toEqual(['ふふ', 'ふふ、おか', 'ふふ、おかえり', 'ふふ、おかえり。']);
    expect(r.reply).toBe('ふふ、おかえり。');
  });

  it('turns an error event, a plain HTTP error and a stream without an end into ApiError', async () => {
    await expect(readChatStream(ndjson(['{"type":"delta","text":"a"}\n{"type":"error","error":"agent_unavailable"}\n']), () => {}))
      .rejects.toMatchObject({ code: 'agent_unavailable', status: 503 });
    const blocked = new Response(JSON.stringify({ error: 'minor' }), { status: 422 });
    await expect(readChatStream(blocked, () => {})).rejects.toBeInstanceOf(ApiError);
    await expect(readChatStream(new Response(JSON.stringify({ error: 'minor' }), { status: 422 }), () => {})).rejects.toMatchObject({ code: 'minor', status: 422 });
    await expect(readChatStream(ndjson(['{"type":"delta","text":"a"}\n']), () => {})).rejects.toMatchObject({ code: 'network' });
  });
});

/** Lets a test push tokens into the page and finish the turn when it wants. */
function controlledTurn() {
  let push: (t: string) => void = () => {};
  let finish: (r: ChatSendResT) => void = () => {};
  const started = new Promise<void>((ready) => {
    const impl = (_s: AppState, _star: string, _text: string, _lang: string, onText?: (t: string) => void) => {
      push = (t) => onText?.(t);
      ready();
      return new Promise<ChatSendResT>((resolve) => { finish = resolve; });
    };
    vi.spyOn(api, 'chat').mockImplementation(impl as typeof api.chat);
    vi.spyOn(api, 'trialChat').mockImplementation(impl as typeof api.trialChat);
  });
  return { started, push: (t: string) => act(() => push(t)), finish: (r: ChatSendResT) => act(async () => finish(r)) };
}

function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, ...patch }}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('chat renders her reply as it streams', () => {
  it('member chat: typing dots, then the growing reply, then the stored message and memory card', async () => {
    const turn = controlledTurn();
    renderAt('/me/chat', { user: { via: 'email', nickname: 'kenta' } });
    fireEvent.change(await screen.findByLabelText('メッセージ'), { target: { value: 'ただいま' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await turn.started;
    expect(screen.getByRole('status', { name: /入力中/ })).toBeTruthy();
    expect(screen.queryByTestId('chat-live')).toBeNull();

    turn.push('おかえり');
    expect(screen.getByTestId('chat-live').textContent).toBe('おかえり');
    expect(screen.queryByRole('status', { name: /入力中/ })).toBeNull();
    turn.push('おかえり、寒かったね');
    expect(screen.getByTestId('chat-live').textContent).toBe('おかえり、寒かったね');

    await turn.finish(result('おかえり、寒かったね。', { memoryCard: { id: 'm1', title: '寒い夜のおかえり', createdAt: new Date().toISOString() } }));
    await waitFor(() => expect(screen.queryByTestId('chat-live')).toBeNull());
    expect(screen.getByText('おかえり、寒かったね。')).toBeTruthy();
    expect(screen.getByText(/寒い夜のおかえり/)).toBeTruthy();
  });

  it('trial chat streams the same way and counts down', async () => {
    const turn = controlledTurn();
    renderAt('/trial');
    fireEvent.change(await screen.findByLabelText('メッセージ'), { target: { value: 'はじめまして' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await turn.started;
    turn.push('はじめまして');
    expect(screen.getByTestId('chat-live').textContent).toBe('はじめまして');
    await turn.finish(result('はじめまして。来てくれてうれしい。', { trialMessagesLeft: 2, chatLeft: null }));
    await waitFor(() => expect(screen.getByTestId('trial-left').textContent).toBe('あと2通'));
    expect(screen.queryByTestId('chat-live')).toBeNull();
    expect(screen.getByText('はじめまして。来てくれてうれしい。')).toBeTruthy();
  });

  it('prototype mode plays the stub reply out in pieces through the same callback', async () => {
    const seen: string[] = [];
    const r = await api.chat({ ...initialState(), user: { via: 'email', nickname: 'k' } }, 'mahiro', 'hello', 'ja', (t) => seen.push(t));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(r.reply);
    expect(r.reply.startsWith(seen[0])).toBe(true);
  });
});
