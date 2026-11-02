import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItemT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { initialState, type AppState } from '../../src/lib/state';
import { AppRoutes } from '../../src/App';
import { HerMessagesSetting } from '../../src/components/herMessages';
import * as api from '../../src/services/api';

const http = vi.hoisted(() => ({ server: true, herSettings: vi.fn(), herSettingsSet: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => http.server, http: { ...real.http, herSettings: http.herSettings, herSettingsSet: http.herSettingsSet } };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); http.server = true; });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

const member = { ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email' as const, nickname: 'kenta' } };
const invite = (patch: Partial<InboxItemT> = {}): InboxItemT => ({
  id: 'inb_1', star: 'mahiro', kind: 'message', payload: { text: '今夜、部屋で待ってるね。', herMessage: 'invite', sceneId: 'demo-evening' },
  deliveredAt: '2026-10-05T08:00:00.000Z', readAt: null, createdAt: '2026-10-05T08:00:00.000Z', ...patch
});
function chatAt(path: string, patch: Partial<AppState> = {}) {
  return render(<StoreProvider initial={{ ...member, ...patch }}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></StoreProvider>);
}

describe('how often she writes, on My page (#58)', () => {
  it('is not offered in prototype mode', async () => {
    http.server = false;
    render(<StoreProvider initial={member}><HerMessagesSetting /></StoreProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('her-messages')).toBeNull();
    expect(http.herSettings).not.toHaveBeenCalled();
  });

  it('shows his setting and changes it at once', async () => {
    http.herSettings.mockResolvedValue({ mode: 'normal' });
    http.herSettingsSet.mockResolvedValue({ mode: 'less' });
    render(<StoreProvider initial={member}><HerMessagesSetting /></StoreProvider>);
    const normal = await screen.findByTestId('her-mode-normal');
    expect(normal.getAttribute('aria-pressed')).toBe('true');
    expect(normal.textContent).toBe('ふつう（1日2通まで）');
    expect(screen.getByTestId('her-mode-off').textContent).toBe('受け取らない');
    fireEvent.click(screen.getByTestId('her-mode-less'));
    await waitFor(() => expect(screen.getByTestId('her-messages').dataset.mode).toBe('less'));
    expect(http.herSettingsSet).toHaveBeenCalledWith('less');
    expect(screen.getByText('夜22時〜朝7時（あなたの時間）には送りません。通知のオン・オフは「通知」で設定できます。')).toBeTruthy();
  });

  it('says so when the change did not go through, and keeps what he had', async () => {
    http.herSettings.mockResolvedValue({ mode: 'normal' });
    http.herSettingsSet.mockRejectedValue(new Error('down'));
    render(<StoreProvider initial={member}><HerMessagesSetting /></StoreProvider>);
    fireEvent.click(await screen.findByTestId('her-mode-off'));
    expect((await screen.findByRole('alert')).textContent).toBe('変更できませんでした。時間をおいてもう一度お試しください。');
    expect(screen.getByTestId('her-messages').dataset.mode).toBe('normal');
  });
});

describe('her message in the chat (#58)', () => {
  it('opens with her invitation as her line', async () => {
    const item = invite();
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...item, readAt: '2026-10-05T10:30:00.000Z' }, unread: 0 });
    vi.spyOn(api, 'history').mockResolvedValue(null);
    chatAt('/me/chat?inbox=inb_1', { star: 'mahiro', inbox: [item] });
    expect((await screen.findByTestId('chat-inbox')).textContent).toBe('今夜、部屋で待ってるね。');
  });

  it('shows her line once when the conversation already holds it (opened before)', async () => {
    const item = invite({ readAt: '2026-10-05T09:00:00.000Z', payload: { text: 'お昼、なに食べた？', herMessage: 'note' } });
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item, unread: 0 });
    vi.spyOn(api, 'history').mockResolvedValue([{ id: 'm1', from: 'me', text: 'やあ' }, { id: 'msg_inb_1', from: 'her', text: 'お昼、なに食べた？' }]);
    chatAt('/me/chat?inbox=inb_1', { star: 'mahiro', inbox: [item] });
    await screen.findByText('やあ');
    await waitFor(() => expect(screen.queryByTestId('chat-inbox')).toBeNull());
    expect([...document.querySelectorAll('.chat-body .msg')].map((p) => p.textContent)).toEqual(['やあ', 'お昼、なに食べた？']);
  });
});
