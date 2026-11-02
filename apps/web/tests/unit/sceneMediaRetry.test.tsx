import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { loadSceneMedia, mediaEntry, setSceneLoader } from '../../src/data/media';

// N-48: the lazy scene catalogue failing once (or for good) never leaves a scene, her morning or the wake screen blank.
const real = async () => (await import('../../src/data/media.scene.gen.json')).default as never;
const flaky = (fails: number) => {
  let n = 0;
  return vi.fn(async () => { if (n++ < fails) throw new Error('chunk load failed'); return real(); });
};

afterEach(() => { cleanup(); setSceneLoader(real); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

describe('the scene catalogue, tried again (N-48)', () => {
  it('a load that fails twice is tried again with a backoff and comes in on the third try', async () => {
    const imp = flaky(2);
    setSceneLoader(imp as never);
    expect(await loadSceneMedia()).toBe(true);
    expect(imp).toHaveBeenCalledTimes(3);
    expect(mediaEntry('mahiro-morning-9x16') ?? mediaEntry('mahiro-idle-9x16')).toBeDefined();
  });

  it('each retry asks for the catalogue under a new address, never from a cache (N-61)', async () => {
    const { resetSceneLoader } = await import('../../src/data/media');
    const asked: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input));
      if (asked.length < 3) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(await real()), { status: 200 });
    });
    try {
      resetSceneLoader();
      expect(await loadSceneMedia()).toBe(true);
      expect(asked).toHaveLength(3);
      expect(asked[1]).toMatch(/[?&]r=/);
      expect(new Set(asked).size).toBe(3);
    } finally { fetchMock.mockRestore(); }
  });

  it('failed for good, a scene shows a retry — never an empty stage — and opens once the catalogue comes', async () => {
    setSceneLoader(flaky(99) as never);
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'k' } }}>
        <MemoryRouter initialEntries={['/me/scene/demo-evening']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    const failed = await screen.findByTestId('scene-media-failed', {}, { timeout: 8000 });
    expect(failed.textContent).toContain('映像を読み込めませんでした');
    setSceneLoader(real);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }));
    expect(await screen.findByRole('group', { name: 'なんて答える？' }, { timeout: 8000 })).toBeTruthy();
    expect(document.querySelector('.scn-layer')).not.toBeNull();
  });

  it('failed for good, the wake-up moment goes on with her core clip instead of a blank screen', async () => {
    setSceneLoader(flaky(99) as never);
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'k' } }}>
        <MemoryRouter initialEntries={['/me/wake?star=nana']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    const wake = await screen.findByTestId('wake', {}, { timeout: 8000 });
    await vi.waitFor(() => expect(wake.querySelector('.scn-layer')).not.toBeNull(), { timeout: 8000 });
  });
});
