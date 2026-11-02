import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';

const push = vi.hoisted(() => ({ status: 'unavailable' as string, enablePush: vi.fn(), disablePush: vi.fn(), syncPush: vi.fn() }));
vi.mock('../../src/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/push')>()),
  pushStatus: async () => push.status,
  enablePush: push.enablePush,
  disablePush: push.disablePush,
  syncPush: push.syncPush
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let latest: AppState;
function Spy() { latest = useStore().state; return null; }
function renderAt(path: string) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email', nickname: 'kenta', named: true }, star: 'mahiro' }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('notification settings on My page (#50)', () => {
  it('is not shown at all while push is off on the server', async () => {
    renderAt('/me/mypage');
    await screen.findByTestId('nickname');
    expect(screen.queryByTestId('push-optin')).toBeNull();
  });

  it('shows iPhone users the three steps to the home screen instead of an error', async () => {
    push.status = 'ios-install';
    renderAt('/me/mypage');
    const guide = await screen.findByTestId('push-ios-guide');
    expect(guide.querySelectorAll('li')).toHaveLength(3);
    expect(guide.textContent).toContain('ホーム画面に追加');
    expect(screen.queryByTestId('push-toggle')).toBeNull();
  });

  it('asks for permission only on a tap, and can be turned off again', async () => {
    push.status = 'off';
    push.enablePush.mockResolvedValue('on');
    renderAt('/me/mypage');
    const toggle = await screen.findByTestId('push-toggle');
    expect(push.enablePush).not.toHaveBeenCalled();
    expect(toggle.textContent).toBe('通知を受け取る');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('push-optin').dataset.status).toBe('on'));
    expect(push.enablePush).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('push-toggle'));
    await waitFor(() => expect(screen.getByTestId('push-optin').dataset.status).toBe('off'));
    expect(push.disablePush).toHaveBeenCalledOnce();
  });
});

describe('a notification opens the right room (#50)', () => {
  it('switches to the talent named in the link', async () => {
    renderAt('/me/home?star=eimi');
    await waitFor(() => expect(latest.star).toBe('eimi'));
  });

  it('ignores unknown talents and links outside the member pages', async () => {
    renderAt('/me/chat?star=nobody');
    await screen.findByLabelText('メッセージ');
    expect(latest.star).toBe('mahiro');
    cleanup();
    renderAt('/stars?star=eimi');
    await new Promise((r) => setTimeout(r, 50));
    expect(latest.star).toBe('mahiro');
  });
});
