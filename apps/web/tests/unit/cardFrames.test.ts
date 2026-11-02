import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { foilNote } from '../../src/components/cardTile';
import { CARDS, cardLine } from '../../src/data/cards';

describe('tier frames after the physical card deck', () => {
  it("the UR gold-foil comment is the first phrase of her line, short enough to sign", () => {
    expect(foilNote('紺色のほうは、あなたの。ずっと、ここに置いておくね。')).toBe('紺色のほうは、あなたの。');
    expect(foilNote('おそーい！ ……でも来てくれたから、ぜんぶ許す！')).toBe('おそーい！');
    expect(foilNote('Look at me. Tonight I wore this only for you.')).toBe('Look at me.');
    for (const c of CARDS.filter((x) => x.rarity === 'UR')) {
      for (const lang of ['ja', 'zh-Hant', 'en']) {
        const note = foilNote(cardLine(c, lang));
        expect(note.length).toBeGreaterThan(0);
        expect([...note].length).toBeLessThanOrEqual(16);
      }
    }
  });

  it('every tier draws its frame, and only overlays: no size or layout changes on the card', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/components/cards.css'), 'utf8');
    for (const t of ['N', 'R', 'SSR', 'UR']) expect(css).toMatch(new RegExp(`\\.card\\.tier-${t}::before \\{\\s*content: ''`));
    expect(css).toMatch(/\.card\.tier-SR \{ border-color: transparent; \}/);
    expect(css).toMatch(/\.card\.tier-SR::after/);
    expect(css).not.toMatch(/\.card(\.tier-\w+)?(::\w+)? \{[^}]*\b(width|height|aspect-ratio|padding|margin|container-type)\s*:/);
  });
});
