import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { sceneMedia } from '@jstar/shared/scenes';
import { SYSTEM_LINES, SYSTEM_SCENES } from '@jstar/shared/scenes/system';
import { LINES } from '@jstar/shared/lines';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { playable } from '../../src/scene/offer';
import { MEDIA } from '../../src/data/media.gen';
import { SCENE_MEDIA } from '../../src/data/media.scene.gen';
import { loadSceneMedia } from '../../src/data/media';
import { mediaFor } from '../../src/components/stage';
import { STAR_IDS } from '@jstar/shared/domain';

// Prototype mode (no VITE_API_BASE): the player runs the shared engine against this browser, like the e2e suite.
// The scenes' clips are the lazy scene catalogue (src/data/media.ts): these checks run with it loaded, as the player does.
beforeAll(async () => { expect(await loadSceneMedia()).toBe(true); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); });

let latest: AppState;
function Spy() { latest = useStore().state; return null; }
const renderAt = (route: string) => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' } }}>
    <Spy />
    <MemoryRouter initialEntries={[route]}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);

describe('the system scenes in the web (#71)', () => {
  it('play only clips this build has: an offer of any of them is shown', () => {
    for (const s of SYSTEM_SCENES) expect(playable(sceneMedia(s)), s.meta.id).toBe(true);
  });

  it('their wide shots and her confession at sunset come in 16:9 for a landscape screen; close shots stay 9:16', () => {
    const wide = ['confession-wide', 'sys-goodnight', 'sys-herbday-wide', 'sys-hisbday-wide', 'sys-first-snow-wide', 'sys-rainy-night-wide', 'sys-typhoon-wide', 'sys-promise-kept', 'sys-lights-out', 'sys-promise-morning-wide'];
    for (const star of STAR_IDS) {
      for (const f of wide) {
        expect(MEDIA[`${star}-${f}-16x9`] ?? SCENE_MEDIA[`${star}-${f}-16x9`], `${star}-${f}`).toBeDefined();
        expect(mediaFor(`${star}-${f}`, false)?.id).toBe(`${star}-${f}-16x9`);
        expect(mediaFor(`${star}-${f}`, true)?.id).toBe(`${star}-${f}-9x16`);
      }
      expect(mediaFor(`${star}-sys-whisper`, false)?.id).toBe(`${star}-sys-whisper-9x16`);
      // The promises kept (#59, #67): her close shots, in the lazy scene catalogue.
      for (const f of ['sys-promise-kept-close', 'sys-promise-morning-close']) expect(SCENE_MEDIA[`${star}-${f}-9x16`], `${star}-${f}`).toBeDefined();
    }
  });

  it('load on their own when one opens, and play like any scene: her whisper, his goodnight, the lights out', async () => {
    renderAt('/me/scene/whisper-nana-2');
    const choices = await screen.findByRole('group', {}, { timeout: 5000 });
    expect(screen.getByTestId('scene').textContent).toContain(LINES.nana.goodnight.whisper[1].ja);
    const night = [...choices.querySelectorAll('button')].find((b) => b.textContent?.includes(SYSTEM_LINES.choices.whisper[0].label.ja))!;
    fireEvent.click(night);
    await screen.findByTestId('scene-end', {}, { timeout: 5000 });
    expect(screen.getByTestId('scene').getAttribute('data-played')).toMatch(/lights end$/);
    expect(screen.getByTestId('scene-end').textContent).toContain('おやすみ。また明日ね。');
  });

  it('her first snow ends with its memory card', async () => {
    renderAt('/me/scene/first-snow-mahiro');
    const choices = await screen.findByRole('group', {}, { timeout: 5000 });
    fireEvent.click(choices.querySelector('button')!);
    const end = await screen.findByTestId('scene-end', {}, { timeout: 5000 });
    expect(end.textContent).toContain(SYSTEM_LINES.memories.firstSnow.ja);
    expect(latest.memories.map((m) => m.title)).toContain(SYSTEM_LINES.memories.firstSnow.ja);
  });

  it('a moment without a memory card ends in her thanks, not "already received today"', async () => {
    renderAt('/me/scene/typhoon-unpai');
    const choices = await screen.findByRole('group', {}, { timeout: 5000 });
    fireEvent.click(choices.querySelector('button')!);
    const end = await screen.findByTestId('scene-end', {}, { timeout: 5000 });
    expect(end.textContent).toContain('今日も一緒にいてくれて、ありがとう。');
    expect(end.textContent).not.toContain('今日の思い出はもう受け取っています');
  });

  it('an id that only looks like one is not found', async () => {
    renderAt('/me/scene/whisper-nana-9');
    expect((await screen.findByTestId('scene-error')).getAttribute('data-code')).toBe('scene_not_found');
  });
});
