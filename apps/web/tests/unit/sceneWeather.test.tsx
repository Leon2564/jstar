import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SceneRunViewT } from '@jstar/shared/contracts';
import { previewScript, sceneById, type SceneScript } from '@jstar/shared/scenes';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';

// #67: 奈々's 雨夜限定 reading draws the rain at her window, not only plays it.
const api = vi.hoisted(() => ({ scenePreview: vi.fn(), sceneStart: vi.fn(), sceneStep: vi.fn(), sceneCurrent: vi.fn(), sceneRun: vi.fn(), scenePreviews: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => true,
  http: api
}));
vi.mock('../../src/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api')>()),
  serverMode: () => true,
  isDemo: () => true
}));

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const CSS = readFileSync(resolve(__dirname, '../../src/scene/scene.css'), 'utf8');
const WEATHER = CSS.slice(CSS.indexOf('/* #67'));

/** The scene player on a preview of `id`, as the test site plays it. */
async function play(id: string): Promise<HTMLElement> {
  const script = previewScript(sceneById(id)!);
  const view: SceneRunViewT = {
    id: 'scn_1', sceneId: id, star: script.meta.star, seq: 0, status: 'active', outcome: null,
    startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString(), endedAt: null,
    beats: script.steps.slice(0, 3) as SceneRunViewT['beats'], waiting: script.steps[3] as SceneRunViewT['waiting'], waitingSince: new Date().toISOString(),
    upcoming: [], timerEndsAt: null, rewardable: true, rewards: { affinity: 0, variantXp: 0, memories: [], promises: [] }, result: null, affinityXp: 0
  };
  api.scenePreview.mockResolvedValue({ script: script as SceneScript, standIns: {} });
  api.sceneCurrent.mockResolvedValue({ run: null });
  api.sceneStart.mockResolvedValue({ run: view, replayed: false });
  render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email', nickname: 'kenta' }, star: script.meta.star }}>
      <MemoryRouter initialEntries={[`/me/scene/${id}?preview=1`]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
  await waitFor(() => expect(api.sceneStart).toHaveBeenCalled());
  return screen.findByTestId('scene');
}

describe('the rain at her window during a scene (#67)', () => {
  it('奈々\'s rainy reading carries its weather on the scene; the dry reading none', async () => {
    expect(sceneById('read-aloud-rain')!.meta.audio?.ambience).toBe('rain');
    await waitFor(async () => expect((await play('read-aloud-rain')).dataset.weather).toBe('rain'));
    // Her scrim (over her clips and lip-sync, under her subtitles) is what draws it.
    expect(screen.getByTestId('scene').querySelector(':scope > .scn-scrim')).not.toBeNull();
    cleanup();
    expect(sceneById('read-aloud')!.meta.audio?.ambience).toBeUndefined();
    const dry = await play('read-aloud');
    expect(dry.dataset.weather).toBeUndefined();
  });

  it('scene.css draws two sheets of falling streaks for rain (and a storm) over the scrim, and darkens the light', () => {
    for (const sky of ['rain', 'storm']) {
      expect(WEATHER).toContain(`.scn[data-weather="${sky}"] .scn-scrim::before`);
      expect(WEATHER).toContain(`.scn[data-weather="${sky}"] .scn-scrim::after`);
      expect(WEATHER).toMatch(new RegExp(`\\.scn\\[data-weather="${sky}"\\] \\.scn-scrim[ ,][^{]*\\{ background: linear-gradient`));
    }
    // The room's two sheets (weatherRoom.tsx rain: 320 px near, 220 px far, 0.48 s and 0.62 s), as SVG tiles.
    expect(WEATHER).toMatch(/::before \{ --h: 320px; background-image: url\("data:image\/svg\+xml,[^"]+"\);[^}]*animation: scn-rain 0\.48s linear infinite/);
    expect(WEATHER).toMatch(/::after \{ --h: 220px; background-image: url\("data:image\/svg\+xml,[^"]+"\);[^}]*animation: scn-rain 0\.62s linear infinite/);
  });

  it('moves by transform alone, and stands still with reduced motion', () => {
    const keyframes = /@keyframes scn-rain \{([^@]*?)\}\s*\}/.exec(WEATHER)![1];
    expect(keyframes).toMatch(/transform: translate3d\(0, var\(--h\), 0\)/);
    expect(keyframes).not.toMatch(/top|left|background-position|height/);
    expect(WEATHER).toMatch(/will-change: transform/);
    expect(WEATHER).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.scn\[data-weather\] \.scn-scrim::before, \.scn\[data-weather\] \.scn-scrim::after \{ animation: none; \} \}/);
  });
});
