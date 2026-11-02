/**
 * v1.1.1 member acceptance (B-findings H1–M11, Lows; A-M4/M5/L11): the member and account flows in the prototype
 * store (no API), the way each finding was reported.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { jstDay } from '@jstar/shared/rules';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState, type Msg } from '../../src/lib/state';
import { CONFIG } from '../../src/lib/config';
import { ensureLang, translate } from '../../src/i18n';
import { drawSummary } from '../../src/components/cardArt';
import { StarAvatar } from '../../src/components/starAvatar';
import { mergeHistory } from '../../src/pages/me';
import { otpError } from '../../src/pages/flows';
import * as api from '../../src/services/api';
import { CARDS } from '../../src/data/cards';

afterEach(() => { cleanup(); vi.restoreAllMocks(); try { sessionStorage.clear(); } catch { /* jsdom */ } });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let latest: AppState;
function Spy() { latest = useStore().state; return null; }
const member = { ageOk: true, birthdayOk: true, user: { via: 'email' as const, nickname: 'qa-b-zh1' }, star: 'mahiro' as const };
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, ...patch }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const tJa = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate('ja', k, v);

describe('H1: a draw summary counts every tier', () => {
  it('names UR and N too, and its counts add up to the cards drawn', async () => {
    await ensureLang('en');
    const ten = ['N', 'R', 'UR', 'N', 'SR', 'N', 'R', 'N', 'N', 'N'] as const;
    expect(drawSummary([...ten], tJa, 'ja')).toBe('10枚：UR 1・SR 1・R 2・N 6');
    expect(drawSummary([...ten], (k, v) => translate('en', k, v), 'en')).toBe('10 drawn: UR 1 · SR 1 · R 2 · N 6');
    expect(drawSummary(['SR'], (k, v) => translate('en', k, v), 'en')).toBe('1 drawn: SR 1');
  });
});

describe('L2: English counts of one', () => {
  it('are singular', async () => {
    await ensureLang('en');
    expect(translate('en', 'pts.checkinDays', { n: 1 })).toBe('1 day');
    expect(translate('en', 'pts.checkinDays', { n: 11 })).toBe('11 days');
    expect(translate('en', 'res.count', { n: 1 })).toBe('1 card');
  });
});

describe('H2: nothing sends him to buy what cannot be bought', () => {
  it('her chat at the daily limit: when it comes back, the serial code, no pass to buy; no placeholder, no hands-free', async () => {
    renderAt('/me/chat', { ...member, chatDay: jstDay(), chatUsed: CONFIG.dailyFreeMessages });
    const panel = await screen.findByTestId('chat-limit');
    expect(panel.getAttribute('href')).toBe('/serial');
    expect(panel.textContent).toContain('0時（日本時間）');
    expect(panel.textContent).not.toMatch(/マンスリーパスを見る/);
    expect((screen.getByLabelText('メッセージ') as HTMLInputElement).placeholder).toBe('今日のトークはここまで');
    expect(screen.queryByTestId('hands-free')).toBeNull();
  });
});

describe('H3: the trial and the card lead into her room', () => {
  it('the trial end signs up into her room', async () => {
    renderAt('/trial', { trialLeft: 0 });
    expect((await screen.findByTestId('trial-done')).getAttribute('href')).toBe('/signup?next=/me/home');
  });
  it("a card's 「このカードの話をする」 opens her room with her", async () => {
    const card = CARDS.find((c) => c.star === 'nana')!;
    renderAt(`/me/cards/${card.id}`, { ...member, owned: { [card.id]: 1 } });
    expect((await screen.findByRole('link', { name: 'このカードの話をする' })).getAttribute('href')).toBe('/me/home');
  });
});

describe('M1 / L11: a refused code says why', () => {
  const err = (code: string, status = 400, retry?: number) => new api.ApiError(code, status, retry);
  it('expired, spent by wrong tries, a cooldown, and a 429 with its wait', () => {
    expect(otpError(err('code_expired'), tJa)).toBe(tJa('su.errExpired'));
    expect(otpError(err('code_attempts'), tJa)).toBe(tJa('su.errTries'));
    expect(otpError(err('invalid_code'), tJa)).toBe(tJa('su.errCode'));
    expect(otpError(err('signup_cooldown', 403), tJa)).toBe(tJa('su.errCooldown'));
    expect(otpError(err('rate_limited', 429, 7 * 60_000), tJa)).toBe('続けて送信されたため、約7分後にもう一度お試しください。');
  });
  it('the code step says how long the code lasts, resends after a wait, and an expired code says to send a new one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const send = vi.spyOn(api, 'sendOtp').mockResolvedValue(10);
    vi.spyOn(api, 'verifyOtp').mockRejectedValue(new api.ApiError('code_expired', 400));
    renderAt('/signup?mode=login');
    fireEvent.change(await screen.findByLabelText('メールアドレス'), { target: { value: 'a@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '確認コードを送る' }));
    expect((await screen.findByTestId('su-ttl')).textContent).toBe('コードの有効期限は10分です。');
    const resend = screen.getByTestId('su-resend') as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/再送する（\d+秒後）/);
    fireEvent.change(screen.getByLabelText('確認コード'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /のもとへ/ }));
    expect((await screen.findByRole('alert')).textContent).toBe(tJa('su.errExpired'));
    await act(async () => { vi.advanceTimersByTime(61_000); });
    await waitFor(() => expect(resend.disabled).toBe(false));
    fireEvent.click(resend);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('新しいコードを送りました。')).toBeTruthy();
    vi.useRealTimers();
  });
  it('A-L11: the address he typed survives a trip to the terms', async () => {
    renderAt('/signup');
    fireEvent.change(await screen.findByLabelText('メールアドレス'), { target: { value: 'keep@example.com' } });
    cleanup();
    renderAt('/signup');
    expect(((await screen.findByLabelText('メールアドレス')) as HTMLInputElement).value).toBe('keep@example.com');
  });
});

describe('M2 / A-M5: the menu and the log-in words', () => {
  it('the menu offers 「ログイン／無料登録」, and log-in is not 「おかえり」', async () => {
    renderAt('/menu');
    expect(await screen.findByRole('link', { name: 'ログイン／無料登録' })).toBeTruthy();
    cleanup();
    renderAt('/signup?mode=login');
    expect(await screen.findByRole('heading', { name: 'ログイン／無料登録' })).toBeTruthy();
    expect(screen.queryByText(/おかえり/)).toBeNull();
  });
  it('a visitor is not offered the points page in the menu', async () => {
    renderAt('/menu');
    await screen.findByRole('link', { name: 'ログイン／無料登録' });
    expect(screen.queryByRole('link', { name: /星石/ })).toBeNull();
  });
});

describe('M3: logging out', () => {
  it('lands on the top page, which says so', async () => {
    renderAt('/me/mypage', member);
    fireEvent.click(await screen.findByTestId('logout'));
    expect(await screen.findByText('ログアウトしました')).toBeTruthy();
    expect(latest.user).toBeNull();
    expect(screen.queryByRole('heading', { name: '会話を保存して続ける' })).toBeNull();
  });
});

describe('M4: My page', () => {
  it('never shows the e-mail stand-in as his name; he picks one; her face is the avatar; the language row', async () => {
    renderAt('/me/mypage', member);
    fireEvent.click(await screen.findByTestId('nickname-set'));
    expect(screen.queryByText('qa-b-zh1')).toBeNull();
    fireEvent.change(screen.getByTestId('nickname-input'), { target: { value: 'ケンタ' } });
    fireEvent.click(screen.getByTestId('nickname-save'));
    expect((await screen.findByTestId('nickname')).textContent).toBe('ケンタ');
    expect(latest.user).toMatchObject({ nickname: 'ケンタ', named: true });
    expect(screen.getAllByTestId('star-avatar').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('言語'), { target: { value: 'en' } });
    await waitFor(() => expect(latest.lang).toBe('en'));
  });
});

describe('M10: an avatar that cannot load, and lines that did not go', () => {
  it('her avatar falls back to her initial, never a broken image', () => {
    // B-N9: the first character of her name in the app's language, never a Latin letter in zh-Hant or ko.
    for (const [lang, initial] of [['zh-Hant', '七'], ['ko', '나'], ['en', 'A']] as const) {
      const { container, unmount } = render(<StoreProvider initial={{ ...initialState(), lang }}><StarAvatar id="alice" size={40} /></StoreProvider>);
      const img = container.querySelector('img');
      if (img) fireEvent.error(img);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe(initial);
      unmount();
    }
  });
  it('the server copy of the conversation never drops a line that did not go', () => {
    const server: Msg[] = [{ id: 's1', from: 'me', text: 'hi' }, { id: 's2', from: 'her', text: 'hello' }];
    const local: Msg[] = [...server, { id: 'l1', from: 'me', text: 'offline 1', failed: true }, { id: 'l2', from: 'me', text: 'offline 2', failed: true }];
    expect(mergeHistory(server, local, new Set()).map((m) => m.id)).toEqual(['s1', 's2', 'l1', 'l2']);
  });
  it('earlier unsent lines stay marked in her chat', async () => {
    renderAt('/me/chat', { ...member, chats: { ...initialState().chats, mahiro: [{ id: 'f1', from: 'me', text: 'unsent one', failed: true }, { id: 'f2', from: 'me', text: 'unsent two', failed: true }] } });
    await waitFor(() => expect(screen.getAllByTestId('chat-failed')).toHaveLength(2));
  });
});

describe('L8 / L10', () => {
  it('export is unavailable with no memories', async () => {
    renderAt('/me/cards?tab=memory', member);
    expect(((await screen.findByTestId('memory-export')) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-export-empty')).toBeTruthy();
  });
  it("coming back to a code's result shows it face up, without replaying the reveal", async () => {
    const ids = CARDS.filter((c) => c.rarity === 'R').slice(0, 6).map((c) => c.id);
    renderAt('/gacha/redeem', { ...member, lastRedeem: { cards: ids.map((id) => ({ id, isNew: true })), days: 7, seen: true } });
    expect(await screen.findAllByTestId('gacha-result-card')).toHaveLength(6);
    expect(screen.getAllByTestId('gacha-result-card').every((card) => card.classList.contains('is-open'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'すべてめくる' })).toBeNull();
  });
});
