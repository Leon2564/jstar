import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BondResT } from '@jstar/shared/contracts';
import { VARIANT_CARDS } from '@jstar/shared/rules';
import { StoreProvider } from '../../src/lib/store';
import { initialState, type AppState } from '../../src/lib/state';
import { AppRoutes } from '../../src/App';
import { CallNameSetting } from '../../src/components/callName';
import { homeLookFor, homeSceneFor } from '../../src/pages/me';
import { MEDIA, type MediaEntry } from '../../src/data/media.gen';
import { ApiError } from '../../src/services/http';
import * as api from '../../src/services/api';

const http = vi.hoisted(() => ({ server: true, callNameGet: vi.fn(), callNameSet: vi.fn(), bond: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => http.server, http: { ...real.http, callNameGet: http.callNameGet, callNameSet: http.callNameSet, bond: http.bond } };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); http.server = true; });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

const member = { ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email' as const, nickname: 'kenta' } };
const at = (path: string, patch: Partial<AppState> = {}) =>
  render(<StoreProvider initial={{ ...member, ...patch }}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></StoreProvider>);
const bond = (patch: Partial<BondResT> = {}): BondResT => ({ star: 'mahiro', callName: 'ケンタさん', callStage: 'new', ask: null, praise: {}, ...patch });
const ASK = 'ねえ。これから、ケンタくんって呼んでもいい？';

describe('her question about what to call him, in the chat (#56)', () => {
  it('asks once, with two answers; yes puts her question and her answer in the conversation', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue(null);
    vi.spyOn(api, 'bondOf').mockResolvedValue(bond({ ask: { to: 'familiar', text: ASK } }));
    const answer = vi.spyOn(api, 'answerCallName').mockResolvedValue({ reply: 'ふふ、ケンタくん。', bond: bond({ callName: 'ケンタくん', callStage: 'familiar' }) });
    at('/me/chat', { star: 'mahiro' });
    const ask = await screen.findByTestId('call-ask', {}, { timeout: 8000 });
    expect(ask.querySelector('.msg.her')?.textContent).toBe(ASK);
    expect(screen.getByTestId('call-yes').textContent).toBe('いいよ');
    expect(screen.getByTestId('call-no').textContent).toBe('いまのままで');
    fireEvent.click(screen.getByTestId('call-yes'));
    await waitFor(() => expect(screen.queryByTestId('call-ask')).toBeNull());
    expect(answer).toHaveBeenCalledWith('mahiro', 'familiar', true, 'ja');
    const said = [...document.querySelectorAll('.chat-body .msg.her')].map((p) => p.textContent);
    expect(said.slice(-2)).toEqual([ASK, 'ふふ、ケンタくん。']);
  });

  it('asked and answered elsewhere: she stops asking; a failure keeps the question and says so', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue(null);
    vi.spyOn(api, 'bondOf').mockResolvedValue(bond({ ask: { to: 'familiar', text: ASK } }));
    const answer = vi.spyOn(api, 'answerCallName').mockRejectedValueOnce(new Error('network'));
    at('/me/chat', { star: 'mahiro' });
    fireEvent.click(await screen.findByTestId('call-no', {}, { timeout: 8000 }));
    expect(await screen.findByText('うまく届きませんでした。もう一度お試しください。')).toBeTruthy();
    expect(screen.getByTestId('call-ask')).toBeTruthy();
    answer.mockRejectedValueOnce(new ApiError('not_asking', 409));
    fireEvent.click(screen.getByTestId('call-no'));
    await waitFor(() => expect(screen.queryByTestId('call-ask')).toBeNull());
    expect(answer).toHaveBeenLastCalledWith('mahiro', 'familiar', false, 'ja');
  });

  it('asks nothing when she is not asking', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(null);
    vi.spyOn(api, 'promises').mockResolvedValue(null);
    const of = vi.spyOn(api, 'bondOf').mockResolvedValue(bond());
    at('/me/chat', { star: 'mahiro' });
    await screen.findByTestId('chat-opener', {}, { timeout: 8000 });
    await waitFor(() => expect(of).toHaveBeenCalledWith('mahiro', 'ja'));
    expect(screen.queryByTestId('call-ask')).toBeNull();
  });
});

describe('「呼び方」 on My page (#56)', () => {
  it('is not offered in prototype mode', async () => {
    http.server = false;
    render(<StoreProvider initial={member}><CallNameSetting /></StoreProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('call-name')).toBeNull();
    expect(http.callNameGet).not.toHaveBeenCalled();
  });

  it('shows what she calls him, saves a name, and turns nonsense away before sending it', async () => {
    http.callNameGet.mockResolvedValue({ name: null });
    http.bond.mockResolvedValueOnce(bond({ callName: 'kentaさん' })).mockResolvedValue(bond({ callName: 'ケンさん' }));
    http.callNameSet.mockResolvedValue({ name: 'ケン' });
    render(<StoreProvider initial={{ ...member, star: 'mahiro' }}><CallNameSetting /></StoreProvider>);
    expect((await screen.findByTestId('call-now')).textContent).toBe('まひろからの呼ばれ方：kentaさん');
    const input = screen.getByTestId('call-input') as HTMLInputElement;
    expect(input.maxLength).toBe(20);
    fireEvent.change(input, { target: { value: 'me@example.com' } });
    fireEvent.submit(input.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('20文字以内で、連絡先やURLを含まない名前にしてください。');
    expect(http.callNameSet).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'ケン' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByTestId('call-now').textContent).toBe('まひろからの呼ばれ方：ケンさん'));
    expect(http.callNameSet).toHaveBeenCalledWith('ケン');
    expect(screen.getByRole('status').textContent).toBe('保存しました。次のひとことから反映されます。');
    http.callNameSet.mockResolvedValue({ name: null });
    fireEvent.click(screen.getByTestId('call-clear'));
    await waitFor(() => expect(http.callNameSet).toHaveBeenLastCalledWith(null));
  });
});

describe('she is changed by him: the look in her room (#56)', () => {
  const variant = VARIANT_CARDS.find((id) => id.includes('-mahiro-'))!;
  const clip = (id: string): MediaEntry => ({ ...MEDIA['mahiro-breath-9x16'], id });

  it('her usual clip until he praises her face; then her close-up joins, twice as often after three', () => {
    const hero = homeSceneFor('mahiro', 'night', true);
    expect(homeLookFor('mahiro', 'night', true, {}, [], 0.99)).toEqual({ look: 'outfit', entry: hero });
    expect(homeLookFor('mahiro', 'night', true, { face: 1 }, [], 0.49).look).toBe('outfit');
    expect(homeLookFor('mahiro', 'night', true, { face: 1 }, [], 0.51)).toEqual({ look: 'face', entry: MEDIA['mahiro-breath-9x16'] });
    // 1 : 2 after three praises.
    expect(homeLookFor('mahiro', 'night', true, { face: 3 }, [], 0.34).look).toBe('face');
    // A landscape screen has no close-up clip: only what exists is picked.
    expect(homeLookFor('mahiro', 'night', false, { face: 9 }, [], 0.99).look).toBe('outfit');
  });

  it('her variant shows only with its clip, and weighs double once praised three times', () => {
    // Without the clip her variant never shows (the clip exists since #81: take it away for this check).
    const made = MEDIA['mahiro-variant-home-9x16'], wide = MEDIA['mahiro-variant-home-16x9'];
    delete MEDIA['mahiro-variant-home-9x16'];
    delete MEDIA['mahiro-variant-home-16x9'];
    expect(homeLookFor('mahiro', 'night', true, { [variant]: 5 }, [variant], 0.99).look).toBe('outfit');
    MEDIA['mahiro-variant-home-9x16'] = made ?? clip('mahiro-variant-home-9x16');
    if (wide) MEDIA['mahiro-variant-home-16x9'] = wide;
    try {
      const share = (n: number) => Array.from({ length: 300 }, (_, i) => homeLookFor('mahiro', 'night', true, { [variant]: n }, [variant], i / 300).look)
        .filter((l) => l === variant).length / 300;
      expect(share(2)).toBeCloseTo(1 / 2, 2);
      expect(share(3)).toBeCloseTo(2 / 3, 2);
      // Not his card: not her look.
      expect(homeLookFor('mahiro', 'night', true, { [variant]: 5 }, [], 0.99).look).toBe('outfit');
    } finally {
      if (made) MEDIA['mahiro-variant-home-9x16'] = made; else delete MEDIA['mahiro-variant-home-9x16'];
    }
  });

  it('her room shows the look his praise picked', async () => {
    // An evening on his clock: in the morning her room shows her morning look instead (the suite failed before 11:00).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 20, 0));
    onTestFinished(() => { vi.useRealTimers(); });
    // A phone held upright: the close-up is a vertical clip.
    const matchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('portrait'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    onTestFinished(() => { window.matchMedia = matchMedia; });
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    vi.spyOn(api, 'bondOf').mockResolvedValue(bond({ praise: { face: 3 } }));
    at('/me/home', { star: 'mahiro' });
    await waitFor(() => expect(document.querySelector('.home-stage')?.getAttribute('data-look')).toBe('face'), { timeout: 8000 });
    expect(document.querySelector('.home-stage [data-scene]')?.getAttribute('data-scene')).toBe('mahiro-breath-9x16');
  }, 15_000);
});
