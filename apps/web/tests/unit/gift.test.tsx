import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GiftSendResT, GiftsResT } from '@jstar/shared/contracts';
import { FEATURED_GIFTS, GIFTS } from '@jstar/shared/gifts';
import { GIFT_RULES } from '@jstar/shared/rules';
import { giftReaction } from '@jstar/shared/tastes';
import { StoreProvider, useStore, type Actions } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { giftBlock } from '../../src/components/gift';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import * as giftApi from '../../src/services/gifts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let latest: { state: AppState; actions: Actions };
function Spy() { latest = useStore(); return null; }
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, points: 1030, ...patch }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const list = (known: string[] = [], sentToday = 0): GiftsResT => ({
  star: 'nana', gifts: GIFTS.map((g) => ({ id: g.id, price: g.price, known: known.includes(g.id) })), sentToday, perDay: GIFT_RULES.perDay, points: 1030
});
const sent = (patch: Partial<GiftSendResT> = {}): GiftSendResT => ({
  star: 'nana', giftId: 'karaoke-mic', taste: 'liked', wished: true, reaction: 'マイク！？ 覚えててくれたの！？', affinityXp: 60, level: 3,
  relationship: { star: 'nana', stage: 'new', daysTogether: 1, anniversary: null, loverLevel: null, hint: 'time', progress: 1 },
  points: 830, freePulls: 0, sentToday: 1, perDay: GIFT_RULES.perDay, known: ['yakiniku'], variant: null, ...patch
});
/** The chat and the home are lazy routes: on a loaded machine the first render can take a few seconds. */
const openSheet = async () => {
  fireEvent.click(await screen.findByTestId('gift-open', {}, { timeout: 8000 }));
  return screen.findByTestId('gift-sheet');
};

describe('gift sheet (#77)', () => {
  it('loads selectable gifts inside the 1v1 digital-human room', async () => {
    renderAt('/me/home', { star: 'eimi', points: 16200 });
    fireEvent.click(await screen.findByRole('button', { name: 'プレゼント' }, { timeout: 8000 }));
    const gift = await screen.findByTestId('gift-bouquet');
    expect((gift as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(gift);
    expect(gift.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens from her chat with the six featured gifts, their prices, and what a gift is', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list());
    renderAt('/me/chat', { star: 'nana' });
    const sheet = await openSheet();
    expect(sheet.getAttribute('aria-label')).toBe('奈々にプレゼント');
    for (const g of FEATURED_GIFTS) expect(screen.getByTestId(`gift-${g.id}`).textContent).toContain(`星石 ${g.price}`);
    expect(screen.queryByTestId('gift-yakiniku')).toBeNull();
    expect(screen.getByTestId('gift-points').textContent).toBe('所持星石 1,030');
    await waitFor(() => expect(screen.getByTestId('gift-left').textContent).toBe(`今日あと${GIFT_RULES.perDay}回`));
    // Digital, non-refundable, and her taste matters — but the sheet never says which she likes.
    expect(sheet.textContent).toContain('実物は届きません');
    expect(sheet.textContent).toContain('返金・換金できません');
    expect(screen.queryByTestId('gift-known')).toBeNull();
    expect(sheet.textContent).not.toContain('♥');
    expect((screen.getByTestId('gift-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks what he has learned she likes', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list(['bouquet', 'karaoke-mic']));
    renderAt('/me/chat', { star: 'nana' });
    await openSheet();
    expect((await screen.findByTestId('gift-known')).textContent).toBe('♥ 奈々の好きなもの：花束、カラオケマイク');
    expect(screen.getByTestId('gift-karaoke-mic').getAttribute('aria-label')).toBe('カラオケマイク 星石 150（好きって言ってた）');
    expect(screen.getByTestId('gift-bouquet').getAttribute('aria-label')).toBe('花束 星石 100（好きって言ってた）');
  });

  it('gives the gift: her reaction joins the chat, and the wallet and her XP follow', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list(['karaoke-mic']));
    const send = vi.spyOn(giftApi, 'sendGift').mockResolvedValue(sent());
    renderAt('/me/chat', { star: 'nana' });
    await openSheet();
    await waitFor(() => expect((screen.getByTestId('gift-karaoke-mic') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('gift-karaoke-mic'));
    const button = screen.getByTestId('gift-send');
    expect(button.textContent).toBe('星石150で贈る');
    fireEvent.click(button);
    expect(await screen.findByText('マイク！？ 覚えててくれたの！？', { selector: '.msg.her' })).toBeTruthy();
    expect(screen.getByText('カラオケマイクを贈りました', { selector: '.msg.system' })).toBeTruthy();
    expect(send).toHaveBeenCalledWith(expect.anything(), 'nana', 'karaoke-mic', 'ja');
    expect(screen.queryByTestId('gift-sheet')).toBeNull();
    expect(latest.state.points).toBe(830);
    expect(latest.state.affinity.nana).toBe(60);
  });

  it('says so when he is short of points, or today\'s gifts are done', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list());
    renderAt('/me/chat', { star: 'nana', points: 80 });
    await openSheet();
    await waitFor(() => expect((screen.getByTestId('gift-night-view') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('gift-night-view'));
    const button = screen.getByTestId('gift-send') as HTMLButtonElement;
    expect(button.textContent).toBe('星石が足りません');
    expect(button.disabled).toBe(true);
    // M9: never a dead end — by how much (on the tile) and where points come from (log-in, check-in, bond, a code).
    expect(screen.getByTestId('gift-night-view').textContent).toContain(`あと星石${GIFTS.find((g) => g.id === 'night-view')!.price - 80}`);
    expect(screen.getByTestId('gift-earn').textContent).toContain('星石が足りません');
    expect(await screen.findByTestId('charge-modal')).toBeTruthy();
    expect(screen.getByRole('button', { name: '星石の貯め方' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'シリアルコードを入力' }).getAttribute('href')).toBe('/serial');
    fireEvent.click(screen.getByTestId('charge-modal').querySelector('.charge-close')!);
    // A race the sheet could not see: the API's answer is shown as it is.
    fireEvent.click(screen.getByTestId('gift-cocoa'));
    vi.spyOn(giftApi, 'sendGift').mockRejectedValue(new api.ApiError('gift_limit', 409));
    fireEvent.click(screen.getByTestId('gift-send'));
    expect((await screen.findByRole('alert')).textContent).toBe('今日のプレゼントはここまで。また明日ね');
  });

  it('knows why it cannot send', () => {
    expect(giftBlock({ sentToday: GIFT_RULES.perDay, perDay: GIFT_RULES.perDay }, 9999, 100)).toBe('gift.limit');
    expect(giftBlock({ sentToday: 0, perDay: GIFT_RULES.perDay }, 9999, null)).toBe('gift.pick');
    expect(giftBlock({ sentToday: 0, perDay: GIFT_RULES.perDay }, 99, 100)).toBe('gift.noPoints');
    expect(giftBlock({ sentToday: 0, perDay: GIFT_RULES.perDay }, 100, 100)).toBeNull();
  });

  it('opens from her room too, and her reaction takes the place of her greeting', async () => {
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list());
    vi.spyOn(giftApi, 'sendGift').mockResolvedValue(sent({ star: 'mahiro', giftId: 'cocoa', reaction: 'ココア、うれしい。' }));
    renderAt('/me/home', { star: 'mahiro' });
    fireEvent.click(await screen.findByRole('button', { name: 'プレゼント' }, { timeout: 8000 }));
    await screen.findByTestId('gift-sheet');
    await waitFor(() => expect((screen.getByTestId('gift-cocoa') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('gift-cocoa'));
    fireEvent.click(screen.getByTestId('gift-send'));
    expect(await screen.findByText('ココア、うれしい。', { selector: '.private-live-chat .her' })).toBeTruthy();
    expect(document.querySelector('[data-scene="mahiro-react-b-16x9"]')).toBeTruthy();
    expect(latest.state.chats.mahiro.map((m) => m.text)).toEqual(['ホットココアを贈りました', 'ココア、うれしい。']);
  });

  it('plays her gift reaction without consuming an existing invitation (F-26)', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    const now = new Date().toISOString();
    const invite = { id: 'c26', star: 'alice' as const, kind: 'message' as const, payload: { text: '今夜、大事なお話があります。', scene: 'confession-alice' }, deliveredAt: now, readAt: null, createdAt: now };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite], unread: 1 });
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list());
    vi.spyOn(giftApi, 'sendGift').mockResolvedValue(sent({ star: 'alice', giftId: 'cocoa', reaction: 'ココア……うれしいです。' }));
    renderAt('/me/home', { star: 'alice', inbox: [invite] });
    fireEvent.click(await screen.findByRole('button', { name: 'プレゼント' }, { timeout: 8000 }));
    await screen.findByTestId('gift-sheet');
    await waitFor(() => expect((screen.getByTestId('gift-cocoa') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('gift-cocoa'));
    fireEvent.click(screen.getByTestId('gift-send'));
    expect(await screen.findByText('ココア……うれしいです。', { selector: '.private-live-chat .her' })).toBeTruthy();
    expect(document.querySelector('[data-scene="alice-react-b-16x9"]')).toBeTruthy();
    expect(latest.state.inbox.some((item) => item.id === invite.id)).toBe(true);
  });

  it('works offline (prototype mode) by the same shared rules: points, her taste and her written line', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    renderAt('/me/chat', { star: 'mahiro', points: 1000 });
    await openSheet();
    await waitFor(() => expect((screen.getByTestId('gift-cocoa') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('gift-cocoa'));
    fireEvent.click(screen.getByTestId('gift-send'));
    const line = giftReaction('mahiro', 'cocoa', 'liked', false, 'ja');
    expect(await screen.findByText(line, { selector: '.msg.her' })).toBeTruthy();
    expect(latest.state.points).toBe(1000 - GIFT_RULES.prices.cocoa);
    expect(latest.state.affinity.mahiro).toBe(2 * Math.round(GIFT_RULES.prices.cocoa * GIFT_RULES.xpPerPoint));
    // Now he knows: the sheet marks it.
    await openSheet();
    expect((await screen.findByTestId('gift-known')).textContent).toContain('ココア');
  });

  it('reads in English and Traditional Chinese', async () => {
    await act(async () => { await ensureLang('en'); await ensureLang('zh-Hant'); });
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(giftApi, 'gifts').mockResolvedValue(list(['bouquet']));
    const { unmount } = renderAt('/me/chat', { star: 'nana', lang: 'en' });
    const sheet = await openSheet();
    expect(sheet.getAttribute('aria-label')).toBe('A gift for Nana');
    expect((await screen.findByTestId('gift-known')).textContent).toBe('♥ Nana likes: Bouquet');
    expect(sheet.textContent).toContain('cannot be refunded or cashed out');
    unmount();
    renderAt('/me/chat', { star: 'nana', lang: 'zh-Hant' });
    const zh = await openSheet();
    expect(zh.getAttribute('aria-label')).toBe('送禮物給奈奈');
    expect(zh.textContent).toContain('花束');
  });
});
