import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { RULES } from '@jstar/shared/rules';
import { AppRoutes } from '../../src/App';
import { RevealCard } from '../../src/components/reveal';
import { CARD_BY_ID } from '../../src/data/cards';
import { initialState, type AppState } from '../../src/lib/state';
import { StoreProvider } from '../../src/lib/store';

afterEach(cleanup);
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; window.scrollTo = () => {}; });

const member = { via: 'email' as const, nickname: 'kenta' };
function shell(node: ReactNode, patch: Partial<AppState> = {}) {
  return render(<StoreProvider initial={{ ...initialState(), ageOk: true, user: member, ...patch }}><MemoryRouter>{node}</MemoryRouter></StoreProvider>);
}

describe('Star Shards', () => {
  it('routes the former member draw URL into the new draw screen with its selected pool', async () => {
    render(<StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: member, gachaPool: 'star:alice' }}><MemoryRouter initialEntries={['/me/gacha']}><AppRoutes /></MemoryRouter></StoreProvider>);
    expect(await screen.findByRole('heading', { name: /星をめくる/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '七瀬アリス' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('10回引く')).toBeNull();
  });

  it('shows Star Stones and Star Shards in the gacha wallet and opens rarity-priced exchange', async () => {
    render(<StoreProvider initial={{ ...initialState(), ageOk: true, user: member, points: 1200, shards: 77 }}><MemoryRouter initialEntries={['/gacha']}><AppRoutes /></MemoryRouter></StoreProvider>);
    expect(await screen.findByText('1,200')).toBeTruthy();
    const shards = screen.getByRole('button', { name: /星のかけら 77/ });
    fireEvent.click(shards);
    expect(await screen.findByRole('dialog', { name: '交換所' })).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(`N.*重複.*${RULES.duplicateShards.N}.*交換.*${RULES.exchangeShards.N}`) })).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(`UR.*重複.*${RULES.duplicateShards.UR}.*交換.*${RULES.exchangeShards.UR}`) })).toBeTruthy();
  });

  it('opens recharge from the Star Stone balance and automatically when a draw is short', async () => {
    render(<StoreProvider initial={{ ...initialState(), ageOk: true, user: member, points: 0, freePulls: 0 }}><MemoryRouter initialEntries={['/gacha']}><AppRoutes /></MemoryRouter></StoreProvider>);
    const balance = await screen.findByRole('button', { name: /星石 0/ });
    fireEvent.click(balance);
    expect(await screen.findByTestId('charge-modal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: /シングル TAP TO DRAW/ }));
    expect(await screen.findByTestId('charge-modal')).toBeTruthy();
  });

  it('keeps one six-card deck mounted while the draw modes fan out and fold together', async () => {
    const view = render(<StoreProvider initial={{ ...initialState(), ageOk: true, user: member }}><MemoryRouter initialEntries={['/gacha']}><AppRoutes /></MemoryRouter></StoreProvider>);
    const deck = await screen.findByTestId('gacha-deck');
    const cards = Array.from(deck.querySelectorAll('img'));
    expect(cards).toHaveLength(6);
    expect(deck.classList.contains('pg-deck-1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /6連ガチャ/ }));
    expect(deck.classList.contains('pg-deck-6')).toBe(true);
    expect(deck.querySelectorAll('img')).toHaveLength(6);
    expect(deck.querySelector('img')).toBe(cards[0]);

    fireEvent.click(screen.getByRole('button', { name: /シングル/ }));
    expect(deck.classList.contains('pg-deck-1')).toBe(true);
    expect(deck.querySelector('img')).toBe(cards[0]);
    view.unmount();
  });

  it('changes the frosted talent scene and replays the star swap when a pool is selected', async () => {
    const view = render(<StoreProvider initial={{ ...initialState(), ageOk: true, user: member }}><MemoryRouter initialEntries={['/gacha']}><AppRoutes /></MemoryRouter></StoreProvider>);
    const deck = await screen.findByTestId('gacha-deck');
    const page = view.container.querySelector('.pg-page')!;
    expect(page.querySelector('.pg-pool-scene img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '七瀬アリス' }));
    expect(page.classList.contains('has-pool-art')).toBe(true);
    expect(page.querySelector<HTMLImageElement>('.pg-pool-scene img')?.src).toContain('/media/alice-herohd-16x9/poster-hq.jpg');
    expect(deck.classList.contains('is-pool-refresh-a')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '深田えいみ' }));
    expect(page.querySelector<HTMLImageElement>('.pg-pool-scene img')?.src).toContain('/media/eimi-feedback/poster.png');
    expect(deck.classList.contains('is-pool-refresh-b')).toBe(true);
  });

  it('marks a revealed duplicate for the shatter-to-wallet animation and shows its rarity yield', () => {
    const card = Object.values(CARD_BY_ID).find((item) => item.rarity === 'SR')!;
    const view = shell(<RevealCard k={0} item={{ card, isNew: false }} face omen={null} onTap={() => {}} label="flip" dup={<span>{`星碎 +${RULES.duplicateShards.SR}`}</span>} />);
    expect(view.container.querySelector('.rv.is-duplicate')).toBeTruthy();
    expect(view.container.querySelectorAll('.rv-shatter i')).toHaveLength(9);
    expect(screen.getByText(`星碎 +${RULES.duplicateShards.SR}`)).toBeTruthy();
  });
});
