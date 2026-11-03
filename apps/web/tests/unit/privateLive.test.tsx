import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../src/App';
import { ensureLang } from '../../src/i18n';
import { initialState } from '../../src/lib/state';
import { StoreProvider } from '../../src/lib/store';

const connectLiveAvatar = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/viduLive', () => ({ connectLiveAvatar }));

beforeAll(async () => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  await ensureLang('zh-Hant');
});

afterEach(() => {
  cleanup();
  connectLiveAvatar.mockReset();
  vi.unstubAllGlobals();
});

function openRoom(desktop: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: desktop }));
  connectLiveAvatar.mockResolvedValue({
    session: { liveId: 'test' },
    send: vi.fn(),
    events: vi.fn().mockResolvedValue([]),
    close: vi.fn()
  });
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'unpai' }}>
      <MemoryRouter initialEntries={['/me/home?star=unpai']}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

function openTrial(desktop: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: desktop }));
  connectLiveAvatar.mockResolvedValue({
    session: { liveId: 'test' },
    send: vi.fn(),
    events: vi.fn().mockResolvedValue([]),
    close: vi.fn()
  });
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', trialStar: 'mahiro' }}>
      <MemoryRouter initialEntries={['/trial']}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('private Vidu room', () => {
  it('keeps the responsive still behind frosted glass while desktop Vidu starts', async () => {
    openRoom(true);
    const stage = await screen.findByLabelText('Unpai 1v1 live');
    expect(stage.querySelector('source')?.getAttribute('srcset')).toBe('/media/live/unpai-public-live-16x9.jpg');
    expect(stage.querySelector('img')?.getAttribute('src')).toBe('/media/live/unpai-public-live-9x16.jpg');
    expect(stage.querySelector('.private-live-glass')).toBeTruthy();
    await waitFor(() => expect(connectLiveAvatar).toHaveBeenCalled());
    expect(connectLiveAvatar.mock.calls[0]?.slice(3)).toEqual(['ja', 'desktop']);
  });

  it('selects the 9:16 Vidu configuration on mobile', async () => {
    openRoom(false);
    await waitFor(() => expect(connectLiveAvatar).toHaveBeenCalled());
    expect(connectLiveAvatar.mock.calls[0]?.slice(3)).toEqual(['ja', 'mobile']);
  });

  it('shows the same frosted Vidu stage immediately in the guest chat', async () => {
    openTrial(true);
    const stage = await screen.findByLabelText('唯井真尋 1v1 live');
    expect(stage.querySelector('source')?.getAttribute('srcset')).toBe('/media/live/mahiro-public-live-16x9.jpg');
    expect(stage.querySelector('.trial-avatar-glass')).toBeTruthy();
    expect(stage.querySelector('video')).toBeNull();
    await waitFor(() => expect(connectLiveAvatar).toHaveBeenCalled());
    expect(connectLiveAvatar.mock.calls[0]?.slice(3)).toEqual(['ja', 'desktop']);
  });
});
