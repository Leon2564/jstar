import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SceneOfferViewT } from '@jstar/shared/contracts';
import { MAIN_SCENES, SCENES, sceneMedia, scenePlayable } from '@jstar/shared/scenes';
import { LANDED_SCENE_CLIPS, isPendingMedia, pendingMedia, previewScript, sceneClips } from '@jstar/shared/scenes/media';
import { MEDIA } from '../../src/data/media.gen';
import { SCENE_MEDIA } from '../../src/data/media.scene.gen';
import { loadSceneMedia } from '../../src/data/media';
import { SYSTEM_SCENES } from '@jstar/shared/scenes/system';
import { CONFESSION_SCENES } from '@jstar/shared/scenes/confession';
import { stillPosterPath } from '@jstar/shared/memories';
import { declineOffer, playable, roomOffer, sceneLink } from '../../src/scene/offer';

const api = vi.hoisted(() => ({ server: true, sceneRoom: vi.fn(), sceneOfferDecline: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => api.server,
  http: { sceneRoom: api.sceneRoom, sceneOfferDecline: api.sceneOfferDecline }
}));

afterEach(() => { vi.clearAllMocks(); api.server = true; });

const offer = (patch: Partial<SceneOfferViewT> = {}): SceneOfferViewT => ({
  id: 'ofr_1', sceneId: 'demo-evening', star: 'mahiro', source: 'proposed', expiresAt: '2026-10-01T03:10:00.000Z',
  title: { ja: 'おかえりの夜', 'zh-Hant': '歡迎回家的夜晚', en: 'A Night Back Home' }, media: ['mahiro-hero', 'mahiro-night', 'mahiro-breath'], ...patch
});

// The scenes' clips are the lazy scene catalogue (src/data/media.ts): these checks run with it loaded, as the player does.
beforeAll(async () => { expect(await loadSceneMedia()).toBe(true); });
/** Both catalogues: the entry's (media.gen.ts) and the scenes' (media.scene.gen.ts). */
const ALL = { ...MEDIA, ...SCENE_MEDIA };

describe('her offers in the web (#65)', () => {
  it('the publish rule holds for this build: every clip a scene uses is here, or declared pending (and then not here)', () => {
    for (const s of SCENES) {
      for (const id of sceneMedia(s)) expect(playable([id]) || isPendingMedia(id), `${s.meta.id} ${id}`).toBe(true);
      // A scene production may play has every clip here; demo mode plays the rest with her own clips standing in.
      if (scenePlayable(s, false)) expect(playable(sceneMedia(s)), s.meta.id).toBe(true);
      expect(playable(sceneMedia(previewScript(s))), s.meta.id).toBe(true);
    }
    // The five's own clips (#80) are in this build: nothing pending, every scene playable in production.
    expect(pendingMedia(SCENES)).toEqual([]);
    expect(sceneClips(MAIN_SCENES)).toHaveLength(25);
    for (const s of MAIN_SCENES) expect([playable(sceneMedia(s)), scenePlayable(s, false)], s.meta.id).toEqual([true, true]);
  });

  it('nothing in the catalogue is still declared pending, and every landed clip is here (LANDED_SCENE_CLIPS)', () => {
    const ids = Object.keys(ALL).flatMap((id) => [id, id.replace(/-(9x16|16x9|1x1)$/, '')]);
    for (const id of ids) expect(isPendingMedia(id), id).toBe(false);
    for (const id of LANDED_SCENE_CLIPS) expect(playable([id]), id).toBe(true);
  });

  it('a memory card\'s still links to the poster the site serves, for every clip a script can be on (#51)', () => {
    const clips = [...SCENES, ...CONFESSION_SCENES, ...SYSTEM_SCENES].flatMap((s) => s.steps.flatMap((st) => (st.type === 'clip' ? [st.media, ...(st.variants ?? []).map((v) => v.media)] : [])));
    for (const media of new Set(clips)) {
      const entry = ALL[media] ?? ALL[`${media}-9x16`];
      expect(entry, media).toBeDefined();
      expect(stillPosterPath(media), media).toBe(entry.poster);
    }
  });

  it('shows an offer only when its clips exist, for the talent asked about', async () => {
    api.sceneRoom.mockResolvedValueOnce({ offer: offer() });
    expect(await roomOffer('mahiro')).toMatchObject({ id: 'ofr_1' });
    expect(api.sceneRoom).toHaveBeenCalledWith('mahiro', undefined);
    api.sceneRoom.mockResolvedValueOnce({ offer: offer({ media: ['mahiro-hero', 'mahiro-scene-not-made-yet'] }) });
    expect(await roomOffer('mahiro')).toBeNull();
    api.sceneRoom.mockResolvedValueOnce({ offer: offer() });
    expect(await roomOffer('nana')).toBeNull();
    api.sceneRoom.mockResolvedValueOnce({ offer: null });
    expect(await roomOffer('mahiro')).toBeNull();
    api.sceneRoom.mockRejectedValueOnce(new Error('down'));
    expect(await roomOffer('mahiro')).toBeNull();
    api.sceneRoom.mockResolvedValueOnce({ offer: offer({ source: 'time' }) });
    expect(await roomOffer('mahiro', 'inb_1')).toMatchObject({ source: 'time' });
    expect(api.sceneRoom).toHaveBeenLastCalledWith('mahiro', 'inb_1');
  });

  it('asks nothing in prototype mode', async () => {
    api.server = false;
    expect(await roomOffer('mahiro')).toBeNull();
    declineOffer('ofr_1');
    expect(api.sceneRoom).not.toHaveBeenCalled();
    expect(api.sceneOfferDecline).not.toHaveBeenCalled();
  });

  it('declines best effort, and carries an accepted offer to the player', async () => {
    api.sceneOfferDecline.mockRejectedValueOnce(new Error('down'));
    declineOffer('ofr_1');
    expect(api.sceneOfferDecline).toHaveBeenCalledWith('ofr_1');
    expect(sceneLink('demo-evening', 'ofr_1')).toBe('/me/scene/demo-evening?offer=ofr_1');
    expect(sceneLink('demo-evening')).toBe('/me/scene/demo-evening');
  });
});
