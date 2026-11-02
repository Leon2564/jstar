import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { PICKUP_RULES, RULES } from '@jstar/shared/rules';
import type { PickupDef } from '@jstar/shared/gacha';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { pull } from '../../src/lib/gacha';
import * as api from '../../src/services/api';

/**
 * Pickups on the web (#78): announced on the pool itself and on 提供割合 with numbers computed from the config
 * (never only "UP"), with its period and no countdown; her chat leads to it with a small link, never a pop-up.
 * Offline, a Pickup exists only when a test injects one (window.__PICKUPS__).
 */
const DAY = 86_400_000;
const def = (patch: Partial<PickupDef> = {}): PickupDef => ({
  id: 'pickup:s1-eimi-30:20261001', cardId: 's1-eimi-30', star: 'eimi', share: PICKUP_RULES.share, rates: { ...RULES.rates },
  startsAt: new Date(Date.now() - DAY).toISOString(), endsAt: new Date(Date.now() + 7 * DAY).toISOString(), ...patch
});
const w = window as unknown as { __E2E__: boolean; __PICKUPS__?: PickupDef[] };

beforeAll(() => { w.__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); w.__PICKUPS__ = [def()]; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete w.__PICKUPS__; });

let where = '';
function Where() { const l = useLocation(); where = l.pathname; return null; }
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'eimi', ...patch }}>
      <MemoryRouter initialEntries={[path]}><Where /><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const percents = (el: HTMLElement) => [...el.querySelectorAll('tbody tr')].map((tr) => Number(tr.children[1].textContent!.replace('%', '')));

describe('提供割合 publishes a Pickup (#78)', () => {
  it('shows its period, the card at 2.5% beside its usual 0.5%, and tiers that add up to exactly 100%', async () => {
    renderAt('/legal/rates');
    const box = await screen.findByTestId('rates-pickup:s1-eimi-30:20261001');
    expect(box.textContent).toContain('「ロゼ色の夜」ピックアップ（深田えいみ）');
    expect(within(box).getByTestId('rates-pickup-row').textContent).toBe(
      'ピックアップ対象「ロゼ色の夜」（UR）：2.5%（深田えいみのガチャでは通常 0.5%）。SSR以上が出たときの50%がこのカードです。'
    );
    expect(box.textContent).toMatch(/開催中/);
    expect(box.textContent).toContain('ほかのガチャの確率は変わりません');
    const rows = percents(box);
    expect(rows).toEqual([2.5, 2.5, 12, 28, 55]);
    expect(Math.round(rows.reduce((n, x) => n + x, 0) * 1000)).toBe(100000);
    // The regular pools are listed as before.
    expect(percents(screen.getByTestId('rates-star:eimi'))).toEqual([0.5, 4.5, 12, 28, 55]);
  });

  it('announces a scheduled Pickup before it starts, and drops one that ended', async () => {
    w.__PICKUPS__ = [def({ startsAt: new Date(Date.now() + DAY).toISOString(), endsAt: new Date(Date.now() + 8 * DAY).toISOString() }),
      def({ id: 'pickup:s1-nana-30:20260901', cardId: 's1-nana-30', star: 'nana', startsAt: new Date(Date.now() - 9 * DAY).toISOString(), endsAt: new Date(Date.now() - DAY).toISOString() })];
    renderAt('/legal/rates');
    expect((await screen.findByTestId('rates-pickup:s1-eimi-30:20261001')).textContent).toContain('開催予定');
    expect(screen.queryByTestId('rates-pickup:s1-nana-30:20260901')).toBeNull();
  });
});

describe('the Pickup on the gacha page (#78)', () => {
  it('is a pool of its own with its rate and period, and no countdown', async () => {
    renderAt('/me/gacha', { points: 5000 });
    const chip = await screen.findByTestId('pickup-chip');
    expect(chip.textContent).toBe('✦ ロゼ色の夜');
    fireEvent.click(chip);
    const box = await screen.findByTestId('pickup');
    expect(box.textContent).toContain('「ロゼ色の夜」ピックアップ');
    expect(screen.getByTestId('pickup-rate').textContent).toBe('「ロゼ色の夜」2.5%（通常 0.5%）\nSSR以上の合計 5%');
    expect(box.textContent).toMatch(/開催期間 .+ 〜 .+（日本時間）/);
    expect(box.textContent).not.toMatch(/残り|あと\d+日|今だけ/);
  });

  it('draws only her cards while live; once it ends the page falls back to the whole series', async () => {
    for (let i = 0; i < 50; i++) expect(pull(10, 0, 'pickup:s1-eimi-30:20261001').drawn.every((d) => d.card.star === 'eimi')).toBe(true);
    w.__PICKUPS__ = [];
    renderAt('/me/gacha', { gachaPool: 'pickup:s1-eimi-30:20261001' });
    await waitFor(() => expect(screen.getByRole('button', { name: '全員' }).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.queryByTestId('pickup')).toBeNull();
  });
});

describe('her chat leads to it with a small link (#78)', () => {
  beforeEach(() => { vi.spyOn(api, 'history').mockResolvedValue(null); });
  const say = async (text: string) => {
    fireEvent.change(await screen.findByLabelText('メッセージ'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
  };
  const reply = (pickup?: object) => ({
    reply: 'あら、その服、まだ持ってないの…？', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0,
    ...(pickup ? { pickup } : {})
  });

  it('under her line, a link that opens that Pickup — no dialog', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue(reply({ poolId: 'pickup:s1-eimi-30:20261001', cardId: 's1-eimi-30', star: 'eimi', via: 'ask' }));
    renderAt('/me/chat');
    await say('新しいドレス見せて');
    const link = await screen.findByTestId('chat-pickup');
    expect(link.textContent).toBe('「ロゼ色の夜」のピックアップを見る');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(link);
    await waitFor(() => expect(where).toBe('/me/gacha'));
    expect((await screen.findByTestId('pickup-chip')).getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByTestId('pickup')).toBeTruthy();
  });

  it('an ordinary turn shows no link, and the next message clears it', async () => {
    const chat = vi.spyOn(api, 'chat').mockResolvedValue(reply({ poolId: 'pickup:s1-eimi-30:20261001', cardId: 's1-eimi-30', star: 'eimi', via: 'invite' }));
    renderAt('/me/chat');
    await say('ただいま');
    await screen.findByTestId('chat-pickup');
    chat.mockResolvedValue(reply());
    await say('そうなんだ');
    await waitFor(() => expect(screen.queryByTestId('chat-pickup')).toBeNull());
  });
});
