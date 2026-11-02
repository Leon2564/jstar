/**
 * The v1.1.2 re-test, member and public pages (retest-A / retest-B): the boot marks, the member pages on the night,
 * the offline line under the header band, the refused address, the trial's end line, the install sheet's Esc.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import App, { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { coverSizes } from '../../src/data/mediaCompact';
import * as api from '../../src/services/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

const member = { ageOk: true, birthdayOk: true, user: { via: 'email' as const, nickname: 'kenta' }, star: 'mahiro' as const };
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, ...patch }}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('B-N1: boot.js marks her room only', () => {
  const boot = readFileSync(resolve(__dirname, '../../public/boot.js'), 'utf8');
  const mark = (hash: string) => {
    const doc = { documentElement: { dataset: {} as Record<string, string> } };
    new Function('location', 'document', boot)({ hash }, doc);
    return doc.documentElement.dataset.boot;
  };
  it('her room boots as the room; every other member page boots on the night, never as her room', () => {
    for (const h of ['#/me', '#/me/', '#/me/home', '#/me/home?star=nana', '#/me?star=nana']) expect(mark(h), h).toBe('room');
    for (const h of ['#/me/mypage', '#/me/shop', '#/me/redemptions', '#/me/account/delete', '#/me/gacha/history', '#/me/chat', '#/me/cards/x', '#/me/homework']) expect(mark(h), h).toBe('night');
    expect(mark('')).toBe('night');
    expect(mark('#/features')).toBe('site');
  });
});

describe('B-N2: every member page is on the night', () => {
  it.each(['/me/mypage', '/me/shop', '/me/redemptions', '/me/account/delete', '/me/gacha/history'])('%s', async (path) => {
    const { container } = renderAt(path, member);
    await waitFor(() => expect(container.querySelector('.page.js-nightpage')).toBeTruthy());
  });
});

describe('B-N3 / A-N3: the offline line sits under the header band', () => {
  function goOffline() {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    act(() => { window.dispatchEvent(new Event('offline')); });
  }
  afterEach(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); });
  it('docked right after the chat header, and the shell does not float another one', async () => {
    const { container } = render(<App initial={{ ...initialState(), ...member }} />);
    window.location.hash = '#/me/chat';
    await waitFor(() => expect(container.querySelector('.chat-hdr')).toBeTruthy());
    goOffline();
    const lines = await screen.findAllByTestId('offline-bar');
    expect(lines).toHaveLength(1);
    expect(lines[0].classList.contains('float')).toBe(false);
    expect(lines[0].previousElementSibling?.classList.contains('chat-hdr')).toBe(true);
    window.location.hash = '';
  });
  it('a member page with the shared header docks it under the header too', async () => {
    renderAt('/me/redemptions', member);
    await screen.findByText('シリアルコード履歴');
    goOffline();
    const line = await screen.findByTestId('offline-bar');
    expect(line.previousElementSibling?.tagName).toBe('HEADER');
  });
});

describe('B-N5: a refused address is not offered a resend', () => {
  it('signup_cooldown hides 再送する until the address changes', async () => {
    vi.spyOn(api, 'sendOtp').mockResolvedValue(10);
    vi.spyOn(api, 'verifyOtp').mockRejectedValue(new api.ApiError('signup_cooldown', 403));
    renderAt('/signup?mode=login');
    fireEvent.change(await screen.findByLabelText('メールアドレス'), { target: { value: 'young@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '確認コードを送る' }));
    await screen.findByTestId('su-resend');
    fireEvent.change(screen.getByLabelText('確認コード'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /のもとへ/ }));
    await screen.findByRole('alert');
    expect(screen.queryByTestId('su-resend')).toBeNull();
  });
});

describe('A-polish: the trial used up', () => {
  it('another star opens on the end panel with a line saying the trial is used up, above the sign-up button', async () => {
    renderAt('/trial', { trialLeft: 0, trialStar: 'nana', trialLog: [] });
    const used = await screen.findByTestId('trial-used');
    expect(used.textContent).toBe('お試しの回数は使い切りました');
    expect(used.compareDocumentPosition(screen.getByTestId('trial-done')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('A-M11: the stage poster is chosen for the width it is drawn at', () => {
  it('cover sizes follow the clip: a 9:16 clip is at least 56.25vh wide, a 16:9 one 177.78vh', () => {
    expect(coverSizes('9:16')).toBe('max(100vw, 56.25vh)');
    expect(coverSizes('16:9')).toBe('max(100vw, 177.78vh)');
  });
});

describe('A-L15: Esc closes the install sheet', () => {
  it('closes on Escape', async () => {
    (window as unknown as { __jstarInstall?: unknown }).__jstarInstall = { prompt: async () => {} };
    const { default: InstallHint } = await import('../../src/components/installHint');
    render(<StoreProvider initial={initialState()}><InstallHint /></StoreProvider>);
    expect(screen.getByTestId('install-hint')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('install-hint')).toBeNull();
    delete (window as unknown as { __jstarInstall?: unknown }).__jstarInstall;
  });
});
