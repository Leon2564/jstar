import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneOfferViewT } from '@jstar/shared/contracts';
import { STAR_IDS } from '@jstar/shared/domain';
import { MEDIA } from '../../src/data/media.gen';
import { SCENE_MEDIA } from '../../src/data/media.scene.gen';
import { loadSceneMedia, mediaEntry, sceneMediaLoaded } from '../../src/data/media';
import { heroEntry, loaderEntry } from '../../src/data/heroMedia';
import { media, mediaFor } from '../../src/components/stage';
import { roomOffer } from '../../src/scene/offer';
import { homeLookFor, homeSceneFor, lazyLook } from '../../src/pages/me';
import { reactionKeysFor } from '../../src/data/reactions';
import { listenClipFor, talkClipFor } from '../../src/pages/roomV2';
import { EIMI_BONUS_CARD_ID, EIMI_BONUS_REACTIONS, eimiBonusIdle } from '../../src/data/eimiBonusMedia';

const api = vi.hoisted(() => ({ sceneRoom: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => true,
  http: { sceneRoom: api.sceneRoom }
}));
afterEach(() => { vi.clearAllMocks(); });

// The media catalogue in two parts (src/data/media.ts): the first screens' clips in the entry bundle, the scenes'
// clips in a lazy chunk. Both are written by tools/media (media:process); these checks hold the split to its rule.
describe('the media catalogue split', () => {
  it('uses every approved complete feedback set while keeping the default set for talents without one', () => {
    expect(reactionKeysFor('eimi')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(reactionKeysFor('alice')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(reactionKeysFor('mahiro')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(mediaEntry('alice-idle-16x9')?.sources[0]?.src).toBe('/media/alice-feedback/web-1080/alice-idle-16x9.mp4');
    expect(heroEntry('alice', false)?.id).toBe('alice-idle-16x9');
    expect(heroEntry('alice', true)?.id).toBe('alice-idle-16x9');
    for (const key of reactionKeysFor('alice')) {
      const entry = mediaFor(`alice-react-${key}`, true);
      expect(entry?.id).toBe(`alice-react-${key}-16x9`);
      expect(entry?.sources[0]?.src).toBe(`/media/alice-feedback/web-1080/alice-react-${key}-16x9.mp4`);
    }
    expect(mediaEntry('eimi-idle-16x9')?.sources[0]?.src).toBe('/media/eimi-feedback/web-1080/eimi-idle-16x9.mp4');
    expect(heroEntry('eimi', false)?.id).toBe('eimi-idle-16x9');
    expect(heroEntry('eimi', true)?.id).toBe('eimi-idle-16x9');
    expect(homeSceneFor('eimi', 'morning', true)?.id).toBe('eimi-idle-16x9');
    expect(homeSceneFor('eimi', 'night', false)?.id).toBe('eimi-idle-16x9');
    expect(listenClipFor('eimi', true)?.id).toBe('eimi-idle-16x9');
    expect(talkClipFor('eimi', 'outfit', false)?.id).toBe('eimi-idle-16x9');
    expect(mediaEntry('eimi-talk-16x9')?.id).toBe('eimi-idle-16x9');
    expect(mediaEntry('eimi-hero-morning-9x16')?.id).toBe('eimi-idle-16x9');
    expect(mediaEntry('eimi-costume')).toBeUndefined();
    for (const key of reactionKeysFor('eimi')) {
      const entry = mediaFor(`eimi-react-${key}`, true);
      expect(entry?.id).toBe(`eimi-react-${key}-16x9`);
      expect(entry?.sources[0]?.src).toBe(`/media/eimi-feedback/web-1080/eimi-react-${key}-16x9.mp4`);
    }
    expect(mediaEntry('mahiro-enter-9x16')?.sources[0]?.src).toBe('/media/mahiro-feedback/original-4k/mahiro-enter-16x9.mp4');
    expect(heroEntry('mahiro', false)?.id).toBe('mahiro-idle-16x9');
    expect(heroEntry('mahiro', true)?.id).toBe('mahiro-idle-16x9');
    for (const key of reactionKeysFor('mahiro')) {
      const entry = mediaFor(`mahiro-react-${key}`, true);
      expect(entry?.id).toBe(`mahiro-react-${key}-16x9`);
      expect(entry?.sources[0]?.src).toBe(`/media/mahiro-feedback/original-4k/mahiro-react-${key}-16x9.mp4`);
    }
  });

  it('binds the complete Eimi special-edition suite only to s1-eimi-29', () => {
    expect(EIMI_BONUS_CARD_ID).toBe('s1-eimi-29');
    expect(mediaEntry(`${EIMI_BONUS_CARD_ID}-bonus-enter`)?.sources[0]?.src).toBe(`/media/${EIMI_BONUS_CARD_ID}-bonus/web-1080/${EIMI_BONUS_CARD_ID}-bonus-enter.mp4`);
    expect(eimiBonusIdle().sources[0]?.src).toBe(`/media/${EIMI_BONUS_CARD_ID}-bonus/web-1080/${EIMI_BONUS_CARD_ID}-bonus-idle.mp4`);
    for (const key of EIMI_BONUS_REACTIONS) expect(mediaEntry(`${EIMI_BONUS_CARD_ID}-bonus-react-${key}`)).toBeDefined();
    expect(mediaEntry('s1-eimi-30-bonus-idle')).toBeUndefined();
    expect(homeLookFor('eimi', 'night', false, {}, [EIMI_BONUS_CARD_ID], 0.99).entry?.id).toBe('eimi-idle-16x9');
    expect(homeLookFor('eimi', 'night', false, {}, [EIMI_BONUS_CARD_ID], 0.99, {}, EIMI_BONUS_CARD_ID).entry?.id).toBe(`${EIMI_BONUS_CARD_ID}-bonus-idle`);
    expect(homeLookFor('eimi', 'night', false, {}, ['s1-eimi-30'], 0.99).entry?.id).toBe('eimi-idle-16x9');
    expect(lazyLook('eimi', 'night', [EIMI_BONUS_CARD_ID], EIMI_BONUS_CARD_ID)).toBe(false);
    expect(talkClipFor('eimi', EIMI_BONUS_CARD_ID, false)?.id).toBe(`${EIMI_BONUS_CARD_ID}-bonus-idle`);
  });

  it('keeps the first screens\' clips in the entry: the public home, her usual home loop, the loading screen', () => {
    for (const star of STAR_IDS) {
      for (const family of ['hero', 'herohd', 'night', 'enter', 'react-a', 'react-b', 'react-c']) {
        for (const r of ['9x16', '16x9']) expect(MEDIA[`${star}-${family}-${r}`], `${star}-${family}-${r}`).toBeDefined();
      }
      for (const id of [`${star}-breath-9x16`, `${star}-costume`, `${star}-prop`]) expect(MEDIA[id], id).toBeDefined();
      expect(mediaFor(`${star}-day`, true), `${star}-day`).toBeDefined();
    }
    for (const id of ['loading-stars', 'reveal-burst']) expect(MEDIA[id], id).toBeDefined();
    for (const portrait of [true, false]) expect(mediaEntry(loaderEntry(portrait)!.id)).toBe(loaderEntry(portrait));
  });

  it('moves only scene, variant and morning clips to the lazy catalogue, and no clip is in both', () => {
    const lazy = /^(mahiro|nana|unpai|alice|eimi)-(scene|talk|talkclose|idle|sys|confession|variant|morning|hero-morning)-/;
    for (const id of Object.keys(SCENE_MEDIA)) {
      expect(id, id).toMatch(lazy);
      expect(MEDIA[id], id).toBeUndefined();
    }
    for (const id of Object.keys(MEDIA)) expect(id, id).not.toMatch(lazy);
    expect(Object.keys(SCENE_MEDIA).length).toBeGreaterThan(150);
    // Her variant home loop and her morning clips are there, for every talent.
    for (const star of STAR_IDS) {
      for (const id of [`${star}-variant-home-9x16`, `${star}-variant-home-16x9`, `${star}-hero-morning-9x16`, `${star}-hero-morning-16x9`, `${star}-morning-9x16`]) {
        expect(SCENE_MEDIA[id], id).toBeDefined();
      }
    }
  });

  it('has her room wait for the lazy catalogue only when it may show a morning or variant look', () => {
    const variant = 's1-mahiro-30';
    expect(lazyLook('mahiro', 'night', [])).toBe(false);
    expect(lazyLook('mahiro', 'day', ['s1-mahiro-01'])).toBe(false);
    expect(lazyLook('mahiro', 'morning', [])).toBe(true);
    expect(lazyLook('mahiro', 'night', [variant])).toBe(true);
    // Another talent's variant is not hers.
    expect(lazyLook('nana', 'night', [variant])).toBe(false);
  });

  it('answers scene clips once the lazy catalogue has loaded (a room offer waits for it)', async () => {
    // Nothing has loaded it in this file yet: the sync lookup sees the core catalogue only.
    expect(sceneMediaLoaded()).toBe(false);
    expect(media('mahiro-talk-9x16')).toBeUndefined();
    expect(media('mahiro-hero-9x16')).toBe(MEDIA['mahiro-hero-9x16']);
    // Her room in the morning, before it: her usual loop (it waits for the catalogue before showing one, `lazyLook`).
    expect(homeSceneFor('mahiro', 'morning', true)?.id).toBe('mahiro-herohd-9x16');
    // Her offer names scene clips: it is judged once the catalogue is here, not dropped as unplayable.
    api.sceneRoom.mockResolvedValueOnce({
      offer: {
        id: 'ofr_1', sceneId: 'welcome-home', star: 'mahiro', source: 'proposed', expiresAt: '2026-10-01T03:10:00.000Z',
        title: { ja: 'おかえり', 'zh-Hant': '歡迎回家', en: 'Welcome home' }, media: ['mahiro-scene-welcome-home-cup', 'mahiro-talk']
      } satisfies SceneOfferViewT
    });
    expect(await roomOffer('mahiro')).toMatchObject({ id: 'ofr_1' });
    expect(sceneMediaLoaded()).toBe(true);
    expect(await loadSceneMedia()).toBe(true);
    expect(media('mahiro-talk-9x16')).toBe(SCENE_MEDIA['mahiro-talk-9x16']);
    expect(mediaEntry('mahiro-sys-goodnight-16x9')?.id).toBe('mahiro-sys-goodnight-16x9');
    expect(mediaFor('eimi-variant-close', true)?.id).toBe('eimi-idle-16x9');
    // Her room, once it is here: her morning loop in the morning, her variant home loop when he pinned it.
    expect(homeSceneFor('mahiro', 'morning', true)?.id).toBe('mahiro-hero-morning-9x16');
    expect(homeLookFor('mahiro', 'night', false, {}, ['s1-mahiro-30'], 0, { 's1-mahiro-30': { level: 10, pinned: true } }).entry?.id).toBe('mahiro-variant-home-16x9');
  });
});
