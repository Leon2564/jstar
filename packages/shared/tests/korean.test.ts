import { describe, expect, it } from 'vitest';
import { GIFTS, localStory, localText } from '../src';
import { CATALOG } from '../src/catalog';

// Korean readers saw English wherever a text had no `ko` (localText's fallback, N-06): the 150 cards' titles, lines
// and stories, and the gift names. Every one is written in Korean now, and none may fall back again.
const HANGUL = /[가-힣]/;
const KANA = /[ぁ-ゖァ-ヺ]/;

describe('Korean has no English fallback (N-06)', () => {
  it('every card title, line and story is written in Korean', () => {
    expect(CATALOG).toHaveLength(125);
    for (const c of CATALOG) {
      for (const t of [c.title, c.line].filter((x) => !!x)) {
        expect(t!.ko, c.id).toBeTruthy();
        expect(localText(t, 'ko'), c.id).not.toBe(t!.en);
        expect(localText(t, 'ko'), c.id).toMatch(HANGUL);
        expect(localText(t, 'ko'), c.id).not.toMatch(KANA);
      }
      if (c.story) {
        expect(c.story.ko, c.id).toHaveLength(c.story.ja.length);
        for (const p of localStory(c.story, 'ko')) {
          expect(p, c.id).toMatch(HANGUL);
          expect(p, c.id).not.toMatch(KANA);
        }
      }
    }
  });

  it('all twenty gift names are written in Korean', () => {
    expect(GIFTS).toHaveLength(20);
    for (const g of GIFTS) {
      expect(g.name.ko, g.id).toBeTruthy();
      expect(localText(g.name, 'ko'), g.id).toMatch(HANGUL);
    }
  });
});
