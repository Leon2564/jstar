import { beforeAll, describe, expect, it } from 'vitest';
import { MEDIA } from '../../src/data/media.gen';
import { SCENE_MEDIA } from '../../src/data/media.scene.gen';
import { loadSceneMedia } from '../../src/data/media';
import { baseLoop, clipEntry } from '../../src/scene/stage';

// The scenes' clips are the lazy scene catalogue (src/data/media.ts): these checks run with it loaded, as the player does.
beforeAll(async () => { expect(await loadSceneMedia()).toBe(true); });
const ALL = { ...MEDIA, ...SCENE_MEDIA };

const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;

describe('her seated base loops in the scene player (#80)', () => {
  it('has the talking and listening loops for all five, in both orientations, and the close talking loop', () => {
    for (const s of STARS) {
      for (const r of ['9x16', '16x9']) for (const k of ['idle', 'talk']) expect(ALL[`${s}-${k}-${r}`]?.sources.length, `${s}-${k}-${r}`).toBeGreaterThan(0);
      expect(ALL[`${s}-talkclose-9x16`]?.sources.length, `${s}-talkclose-9x16`).toBeGreaterThan(0);
    }
  });

  it('plays talk while her line plays and idle while she listens on her wide shot; talkclose on her close shot', () => {
    expect(baseLoop('mahiro-hero', true, true)).toBe('mahiro-talk');
    expect(baseLoop('mahiro-hero', false, false)).toBe('mahiro-idle');
    expect(baseLoop('nana-hero-16x9', true, false)).toBe('nana-talk');
    expect(clipEntry(baseLoop('nana-hero', true, false), false)?.id).toBe('nana-talk-16x9');
    expect(clipEntry(baseLoop('nana-hero', false, true), true)?.id).toBe('nana-idle-9x16');
    expect(baseLoop('eimi-breath', true, true)).toBe('eimi-talkclose');
    // Her close shot while she listens stays her breathing loop; every other clip plays as written.
    expect(baseLoop('eimi-breath', false, true)).toBe('eimi-breath');
    expect(baseLoop('alice-night', true, true)).toBe('alice-night');
    expect(baseLoop('mahiro-scene-welcome-home-close', true, true)).toBe('mahiro-scene-welcome-home-close');
    expect(baseLoop('mahiro-herohd', true, true)).toBe('mahiro-herohd');
    expect(baseLoop(undefined, true, true)).toBeUndefined();
  });
});
