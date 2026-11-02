import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { DEMO_SERIALS } from '../../src/lib/serial';

afterEach(() => cleanup());
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

function renderAt(path: string, patch: Partial<ReturnType<typeof initialState>> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, ...patch }}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('trial chat limit', () => {
  it('allows exactly 3 messages then offers sign-up', async () => {
    renderAt('/trial');
    await screen.findByTestId('trial-left');
    for (let n = 3; n > 0; n--) {
      expect(screen.getByTestId('trial-left').textContent).toBe(`あと${n}通`);
      fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: `hello ${n}` } });
      fireEvent.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => expect(screen.getByTestId('trial-left').textContent).toBe(`あと${n - 1}通`));
      await waitFor(() => expect(screen.queryByRole('status', { name: /入力中/ })).toBeNull());
    }
    expect(await screen.findByTestId('trial-done')).toBeTruthy();
    expect((screen.getByLabelText('メッセージ') as HTMLInputElement).disabled).toBe(true);
  });
  it('renders user text literally (no HTML injection)', async () => {
    const { container } = renderAt('/trial');
    await screen.findByTestId('trial-left');
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: '<img src=x onerror="window.__pwned=1">' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('<img src=x onerror="window.__pwned=1">');
    expect(container.querySelector('img[src="x"], img[onerror]')).toBeNull();
  });
});

describe('route guards', () => {
  it('sends visitors on /me/* to sign-up', async () => {
    renderAt('/me/gacha');
    // A-M5: no trial conversation to save: the neutral log-in words, her line for where he was going.
    expect(await screen.findByRole('heading', { name: 'ログイン／無料登録' })).toBeTruthy();
    expect(screen.getByText(/ガチャは、ログインしてから。/)).toBeTruthy();
  });
  it('sends users who have not confirmed age to the age gate', () => {
    render(<StoreProvider initial={initialState()}><MemoryRouter initialEntries={['/serial']}><AppRoutes /></MemoryRouter></StoreProvider>);
    expect(screen.getByRole('heading', { name: '18歳以上の方ですか？' })).toBeTruthy();
  });
  it('sends a serial result without a redeemed code back to the form', async () => {
    renderAt('/gacha/redeem');
    expect(await screen.findByRole('heading', { name: /手元のカードを/ })).toBeTruthy();
  });
});

describe('lucky-card code (prototype mode)', () => {
  const enter = async (code: string) => {
    fireEvent.change(await screen.findByLabelText('シリアルコード'), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'カードを受け取る' }));
  };
  it('shows what a code gives and the published odds', async () => {
    renderAt('/serial');
    expect((await screen.findByTestId('serial-gets')).textContent).toContain('カード6枚');
    const rates = screen.getByTestId('lucky-rates').textContent!;
    expect(rates).toContain('SSR 26.5%');
    expect(rates).toContain('UR 2.9%');
    expect(rates).toContain('R 28%');
    expect(rates).toContain('N 55%');
  });
  it('opens the Star Stone top-up dialog when there is no code', async () => {
    renderAt('/serial');
    fireEvent.click(await screen.findByRole('button', { name: '星石をチャージ' }));
    expect(await screen.findByRole('dialog', { name: '星石をチャージ' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByRole('link', { name: '無料登録してチャージ' }).getAttribute('href')).toBe('/signup?next=/me/shop');
  });
  it('tells a typo apart from an unknown code', async () => {
    renderAt('/serial');
    await enter('9990-0000-0012');
    expect((await screen.findByRole('alert')).textContent).toContain('入力ミス');
    await enter('1234');
    expect((await screen.findByRole('alert')).textContent).toContain('12桁');
  });
  it('turns a demo code into six cards, the first SR or better', async () => {
    renderAt('/serial');
    await enter(DEMO_SERIALS[0]);
    expect(await screen.findByTestId('pg-title')).toBeTruthy();
    expect(screen.getAllByTestId('gacha-result-card')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'すべてめくる' }));
    const first = screen.getAllByTestId('gacha-result-card')[0].textContent!;
    expect(first).toMatch(/SSR|SR/);
    expect(await screen.findByTestId('lucky-bonus')).toBeTruthy();
    expect(await screen.findByRole('link', { name: '無料登録してカードを保存する' })).toBeTruthy();
  });
});
