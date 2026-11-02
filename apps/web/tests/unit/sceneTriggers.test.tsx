import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { SceneOfferViewT } from '@jstar/shared/contracts';
import { TRIGGER_RULES } from '@jstar/shared/rules';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';

const offers = vi.hoisted(() => ({ roomOffer: vi.fn(), declineOffer: vi.fn() }));
vi.mock('../../src/scene/offer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/scene/offer')>()),
  roomOffer: offers.roomOffer,
  declineOffer: offers.declineOffer
}));

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); offers.roomOffer.mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

let where = '';
function Where() { const l = useLocation(); where = `${l.pathname}${l.search}`; return null; }
function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', ...patch }}>
      <MemoryRouter initialEntries={[path]}><Where /><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const offer = (patch: Partial<SceneOfferViewT> = {}): SceneOfferViewT => ({
  id: 'ofr_1', sceneId: 'demo-evening', star: 'mahiro', source: 'proposed', expiresAt: '2026-10-01T03:10:00.000Z',
  title: { ja: 'おかえりの夜', 'zh-Hant': '歡迎回家的夜晚', en: 'A Night Back Home' }, media: ['mahiro-hero'], ...patch
});
const TITLE = { ja: 'おかえりの夜', 'zh-Hant': '歡迎回家的夜晚', en: 'A Night Back Home' };
const reply = (scene?: { sceneId: string; action: 'start' | 'offer' }) => ({
  reply: 'ふふ、いいよ。', affinityXp: 8, level: 1, memoryCard: null, trialMessagesLeft: null, chatLeft: 19, freePulls: 0,
  ...(scene ? { scene: { ...scene, title: TITLE } } : {})
});

describe('entering her room is where a scene begins (#65)', () => {
  it('her proposal takes the place of her greeting; yes opens the scene with the offer', async () => {
    offers.roomOffer.mockResolvedValue(offer());
    renderAt('/me/home');
    // The home is a lazy route: on a loaded machine (the whole suite at once) its first render can take a few seconds.
    const box = await screen.findByTestId('scene-offer', {}, { timeout: 8000 });
    expect(box.getAttribute('aria-label')).toBe('まひろからのおさそい');
    expect(box.textContent).toContain('ねえ……今夜は「おかえりの夜」、一緒に過ごさない？');
    expect(screen.queryByTestId('greeting')).toBeNull();
    expect(offers.roomOffer).toHaveBeenCalledWith('mahiro');
    // His choices come once her line has typed out (QA #8).
    fireEvent.click(await screen.findByTestId('scene-offer-yes', {}, { timeout: 4000 }));
    await waitFor(() => expect(where).toBe('/me/scene/demo-evening?offer=ofr_1'));
  });

  it('"not now" lets it go and her greeting comes back', async () => {
    offers.roomOffer.mockResolvedValue(offer({ source: 'time' }));
    renderAt('/me/home');
    expect((await screen.findByTestId('scene-offer', {}, { timeout: 8000 })).textContent).toContain('ちょうどいい時間だね。');
    fireEvent.click(await screen.findByTestId('scene-offer-no', {}, { timeout: 4000 }));
    expect(offers.declineOffer).toHaveBeenCalledWith('ofr_1');
    expect(screen.queryByTestId('scene-offer')).toBeNull();
    expect(screen.getByTestId('greeting')).toBeTruthy();
  });

  it('without an offer, her room is as it was', async () => {
    renderAt('/me/home');
    await screen.findByTestId('greeting');
    expect(screen.queryByTestId('scene-offer')).toBeNull();
  });

  it('gives her one more chance when he sits quietly, once per visit', async () => {
    // e2e time scale: TRIGGER_RULES.idleProposeMs becomes a fraction of a second.
    const w = window as unknown as { __SCENE_TIME_SCALE__?: number };
    w.__SCENE_TIME_SCALE__ = 200 / TRIGGER_RULES.idleProposeMs;
    try {
      renderAt('/me/home');
      await waitFor(() => expect(offers.roomOffer).toHaveBeenCalledTimes(1));
      offers.roomOffer.mockResolvedValue(offer());
      expect(await screen.findByTestId('scene-offer', {}, { timeout: 3000 })).toBeTruthy();
      expect(offers.roomOffer).toHaveBeenCalledTimes(2);
      await new Promise((r) => setTimeout(r, 600));
      expect(offers.roomOffer).toHaveBeenCalledTimes(2);
    } finally {
      delete w.__SCENE_TIME_SCALE__;
    }
  });

  it('a touch starts his quiet time over', async () => {
    const w = window as unknown as { __SCENE_TIME_SCALE__?: number };
    w.__SCENE_TIME_SCALE__ = 400 / TRIGGER_RULES.idleProposeMs;
    try {
      renderAt('/me/home');
      await waitFor(() => expect(offers.roomOffer).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 200)); fireEvent.pointerDown(window); }
      expect(offers.roomOffer).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(offers.roomOffer).toHaveBeenCalledTimes(2), { timeout: 2000 });
    } finally {
      delete w.__SCENE_TIME_SCALE__;
    }
  });
});

describe('he asks for a scene in chat (#65)', () => {
  beforeEach(() => { vi.spyOn(api, 'history').mockResolvedValue(null); });
  const say = async (text: string) => {
    fireEvent.change(await screen.findByLabelText('メッセージ'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
  };

  it('she says yes, and the scene opens after her line', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue(reply({ sceneId: 'demo-evening', action: 'start' }));
    renderAt('/me/chat');
    await say('おかえりの夜、やろう');
    const cta = await screen.findByTestId('chat-scene');
    expect(cta.textContent).toBe('「おかえりの夜」をはじめる');
    expect(where).toBe('/me/chat');
    await waitFor(() => expect(where).toBe('/me/scene/demo-evening'), { timeout: 4000 });
  });

  it('she offers another instead: a button, never forced', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue(reply({ sceneId: 'demo-evening', action: 'offer' }));
    renderAt('/me/chat');
    await say('夜の温室、やろう');
    const cta = await screen.findByTestId('chat-scene');
    expect(cta.getAttribute('href')).toBe('/me/scene/demo-evening');
    fireEvent.click(cta);
    await waitFor(() => expect(where).toBe('/me/scene/demo-evening'));
  });

  it('an ordinary turn shows no scene', async () => {
    vi.spyOn(api, 'chat').mockResolvedValue(reply());
    renderAt('/me/chat');
    await say('ただいま');
    await screen.findByText('ふふ、いいよ。', { selector: '.msg.her' });
    expect(screen.queryByTestId('chat-scene')).toBeNull();
  });

  it('an inbox event that names a scene offers it under her line', async () => {
    const item = { id: 'inb_1', star: 'mahiro' as const, kind: 'wakeup' as const, payload: { text: 'おはよう', sceneId: 'demo-evening' }, deliveredAt: '2026-10-01T00:00:00.000Z', readAt: null, createdAt: '2026-10-01T00:00:00.000Z' };
    vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...item, readAt: '2026-10-01T01:00:00.000Z' }, unread: 0 });
    offers.roomOffer.mockResolvedValue(offer({ source: 'time', id: 'ofr_2' }));
    renderAt('/me/chat?inbox=inb_1', { inbox: [item] });
    expect(await screen.findByTestId('scene-offer')).toBeTruthy();
    expect(offers.roomOffer).toHaveBeenCalledWith('mahiro', 'inb_1');
    // His choices come once her line has typed out (QA #8).
    fireEvent.click(await screen.findByTestId('scene-offer-yes', {}, { timeout: 4000 }));
    await waitFor(() => expect(where).toBe('/me/scene/demo-evening?offer=ofr_2'));
  });
});

describe('下次吧 to her invitation (Low 10)', () => {
  it('lets the scene it names go: declined, so her room does not offer it again at once', async () => {
    vi.spyOn(api, 'serverMode').mockReturnValue(true);
    vi.spyOn(api, 'greeting').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'readInbox').mockResolvedValue(null);
    const invite = { id: 'm10', star: 'mahiro' as const, kind: 'message' as const, payload: { text: '今夜、来てね。', sceneId: 'demo-evening' }, deliveredAt: new Date().toISOString(), readAt: null, createdAt: new Date().toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [invite], unread: 1 });
    offers.roomOffer.mockImplementation(async (_star: string, inboxId?: string) => (inboxId ? offer({ id: 'ofr_inv', source: 'time' }) : null));
    renderAt('/me/home?star=mahiro&inbox=m10', { inbox: [invite] });
    await screen.findByTestId('call-incoming', {}, { timeout: 8000 });
    expect(screen.getByTestId('call-incoming-later').textContent).toBe('また今度');
    fireEvent.click(screen.getByTestId('call-incoming-later'));
    await waitFor(() => expect(offers.declineOffer).toHaveBeenCalledWith('ofr_inv'));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId('scene-offer-yes')).toBeNull();
  });
});
