import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CardAffectionResT, VariantStateT } from '@jstar/shared/contracts';
import { VARIANT_CARDS } from '@jstar/shared/rules';
import { variantState } from '@jstar/shared/variants';
import { sceneMedia } from '@jstar/shared/scenes';
import { previewScript } from '@jstar/shared/scenes/media';
import { PENDING_VARIANT_CLIPS, VARIANT_SCENES } from '@jstar/shared/scenes/variantScenes';
import { StoreProvider } from '../../src/lib/store';
import { initialState, save, type AppState } from '../../src/lib/state';
import { AppRoutes } from '../../src/App';
import { homeLookFor, homeSceneFor } from '../../src/pages/me';
import { MEDIA, type MediaEntry } from '../../src/data/media.gen';
import { playable } from '../../src/scene/offer';
import { loadSceneMedia } from '../../src/data/media';
import * as api from '../../src/services/api';

const http = vi.hoisted(() => ({ server: true }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => http.server };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); http.server = true; });
// The scenes' clips are the lazy scene catalogue (src/data/media.ts): these checks run with it loaded, as the player does.
beforeAll(async () => { expect(await loadSceneMedia()).toBe(true); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

const EIMI = VARIANT_CARDS.find((id) => id.includes('-eimi-'))!;
const MAHIRO = VARIANT_CARDS.find((id) => id.includes('-mahiro-'))!;
const at = (level: number, xp: number, pinned = false): VariantStateT => ({ ...variantState({ xp, level, kokoro: 0 }), pinned });
const member = { ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email' as const, nickname: 'kenta' } };
const open = (path: string, patch: Partial<AppState> = {}) =>
  render(<StoreProvider initial={{ ...member, ...patch }}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></StoreProvider>);

describe('her variant scenes in this build (#76)', () => {
  it('every clip of the twenty scripts exists here, or is one of #81\'s declared pending variant clips', () => {
    expect(VARIANT_SCENES).toHaveLength(20);
    for (const s of VARIANT_SCENES) {
      for (const id of sceneMedia(s)) expect(playable([id]) || PENDING_VARIANT_CLIPS.includes(id), `${s.meta.id} ${id}`).toBe(true);
      // As the test site plays them (her own clips standing in), every one of them is here.
      expect(playable(sceneMedia(previewScript(s))), s.meta.id).toBe(true);
    }
  });

  it('declares only clips this build does not have yet (take one out of the list when #81 lands it)', () => {
    for (const id of PENDING_VARIANT_CLIPS) expect(playable([id]), id).toBe(false);
  });
});

describe('her home look, weighted by her variant\'s own level (#76)', () => {
  const clip = (id: string): MediaEntry => ({ ...MEDIA['mahiro-breath-9x16'], id });
  const share = (variants: Parameters<typeof homeLookFor>[6]) =>
    Array.from({ length: 400 }, (_, i) => homeLookFor('mahiro', 'night', true, {}, [MAHIRO], i / 400, variants).look).filter((l) => l === MAHIRO).length / 400;

  it('rotates more toward her variant as its level rises; pinned at level 10 it is always her variant', () => {
    MEDIA['mahiro-variant-home-9x16'] = clip('mahiro-variant-home-9x16');
    try {
      expect(share({})).toBeCloseTo(1 / 2, 2);
      expect(share({ [MAHIRO]: at(10, 1000) })).toBeCloseTo(3.25 / 4.25, 2);
      expect(share({ [MAHIRO]: at(10, 1000, true) })).toBe(1);
      expect(homeLookFor('mahiro', 'night', true, {}, [MAHIRO], 0, { [MAHIRO]: at(10, 1000, true) }).entry?.id).toBe('mahiro-variant-home-9x16');
    } finally {
      delete MEDIA['mahiro-variant-home-9x16'];
    }
  });

  it('shows her in the variant at home when he pinned it at level 10 (#81 made the clip), on phones and desktop', () => {
    for (const portrait of [true, false]) {
      const r = homeLookFor('mahiro', 'night', portrait, {}, [MAHIRO], 0.99, { [MAHIRO]: at(10, 1000, true) });
      expect(r.look).toBe(MAHIRO);
      expect(r.entry?.id).toMatch(/^mahiro-variant-home-(9x16|16x9)$/);
      expect(r.entry).not.toEqual(homeSceneFor('mahiro', 'night', portrait));
    }
  });
});

describe('the variant card page (#76)', () => {
  const view = (patch: Partial<AppState>) => {
    vi.spyOn(api, 'relationships').mockResolvedValue(null);
    return open(`/me/cards/${EIMI}`, { owned: { [EIMI]: 1 }, ...patch });
  };
  const layers = () => [...screen.getByTestId('variant-layers').querySelectorAll('li')].map((li) => `${li.dataset.layer}:${li.dataset.open}`);

  it('shows her closeness, the layers open so far and a hint in her words — never a number of XP', async () => {
    view({ variants: { [EIMI]: at(3, 150) } });
    expect(await screen.findByTestId('variant-panel', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByTestId('variant-level').textContent).toBe('Lv 3 / 10');
    expect(layers()).toEqual(['1:true', '3:true', '6:false', '10:false']);
    expect(screen.getByTestId('variant-hint').textContent).toBe('もう少し仲良くなったら、えいみが次の場面を見せてくれるみたい。');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
    expect(screen.getByTestId('variant-panel').textContent).not.toMatch(/150|XP/);
    expect(screen.queryByTestId('variant-pin')).toBeNull();
  });

  it('prototype mode and a first look: level 1, the reveal open', async () => {
    http.server = false;
    view({});
    await screen.findByTestId('variant-panel', {}, { timeout: 8000 });
    expect(layers()).toEqual(['1:true', '3:false', '6:false', '10:false']);
  });

  it('a card that is not a variant has no panel', async () => {
    vi.spyOn(api, 'relationships').mockResolvedValue(null);
    open('/me/cards/s1-eimi-01', { owned: { 's1-eimi-01': 1 } });
    await screen.findByText('Star Genesis', { exact: false }, { timeout: 8000 });
    expect(screen.queryByTestId('variant-panel')).toBeNull();
  });

  it('at level 10 he may keep her in this look on her home, and let her rotate again', async () => {
    const res = (pinned: boolean): CardAffectionResT => ({ cardId: EIMI, star: 'eimi', owned: true, variant: at(10, 1000, pinned) });
    const pin = vi.spyOn(api, 'pinVariantHome').mockResolvedValueOnce(res(true)).mockResolvedValueOnce(res(false));
    view({ variants: { [EIMI]: at(10, 1000) } });
    expect((await screen.findByTestId('variant-hint', {}, { timeout: 8000 })).textContent).toBe('えいみの場面は、ぜんぶ見せてもらいました。');
    fireEvent.click(screen.getByTestId('variant-pin'));
    await waitFor(() => expect(screen.getByTestId('variant-pin').getAttribute('aria-pressed')).toBe('true'));
    expect(pin).toHaveBeenLastCalledWith(EIMI, true);
    expect(screen.getByTestId('variant-pinned')).toBeTruthy();
    fireEvent.click(screen.getByTestId('variant-pin'));
    await waitFor(() => expect(screen.getByTestId('variant-pin').getAttribute('aria-pressed')).toBe('false'));
    expect(pin).toHaveBeenLastCalledWith(EIMI, false);
  });

  it('never keeps his variant state in the browser', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    save({ ...member, variants: { [EIMI]: at(10, 1000, true) } });
    expect(JSON.parse(set.mock.calls[0][1])).not.toHaveProperty('variants');
  });
});
