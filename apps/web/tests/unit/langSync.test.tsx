import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MeResT } from '@jstar/shared/contracts';
import App from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';
import { setToken } from '../../src/services/http';

const srv = vi.hoisted(() => ({ on: true, otpVerify: vi.fn(), me: vi.fn(), setLang: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => srv.on, http: { ...real.http, otpVerify: srv.otpVerify, me: srv.me, setLang: srv.setLang } };
});

/** #176: the server writes his texts in the account's language; the app keeps it his. */
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); setToken(null); window.location.hash = ''; srv.on = true; srv.otpVerify.mockReset(); srv.me.mockReset(); srv.setLang.mockReset(); });

const me = (lang: string): MeResT => ({
  user: { id: 'u1', nickname: 'kenta', via: 'email', lang: lang as MeResT['user']['lang'], ageConfirmedAt: '2026-01-01T00:00:00.000Z' },
  wallet: { points: 0, freePulls: 0, pity: 0, shards: 0 }, owned: [], memories: [], affinity: {}, chat: { left: 20, passUntil: null },
  serialsRedeemed: 0, dailyBonus: 0, checkIn: { month: '2026-10', days: 1, claimed: [] }, birthdayConfirmed: true, inboxUnread: 0, voiceLeft: 600,
  voice: { day: '2026-10-02', leftSeconds: 600, usedSeconds: 0, allowanceSeconds: 600, extensions: 0, extensionsLeft: 3, extendCost: 150, extendMinutes: 30, tts: false }
});

describe('his language on the server (#176)', () => {
  it('signing in sends the app\'s language', async () => {
    srv.otpVerify.mockResolvedValue({ token: 't', user: me('zh-Hant').user });
    srv.me.mockResolvedValue(me('zh-Hant'));
    await api.verifyOtp('123456', 'k@example.com', 'zh-Hant');
    expect(srv.otpVerify).toHaveBeenCalledWith('k@example.com', '123456', 'zh-Hant');
  });

  it('on load an account in another language follows the app; switching the language follows too', async () => {
    setToken('t');
    vi.spyOn(api, 'bootstrap').mockResolvedValue({ kind: 'member', me: me('ja') });
    const set = srv.setLang.mockResolvedValue(me('zh-Hant'));
    window.location.hash = '#/menu';
    render(<App initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' } } as AppState} />);
    await waitFor(() => expect(set).toHaveBeenCalledWith('zh-Hant'));
    fireEvent.change(await screen.findByRole('combobox', {}, { timeout: 8000 }), { target: { value: 'en' } });
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('en'));
  });

  it('asks nothing of the server signed out or in prototype mode', async () => {
    const set = srv.setLang.mockResolvedValue(me('en'));
    await api.syncLang('en');
    srv.on = false;
    setToken('t');
    await api.syncLang('en');
    expect(set).not.toHaveBeenCalled();
  });
});
