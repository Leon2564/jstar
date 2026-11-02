import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIFTS, GIFT_IDS, GIFT_RULES, GIFT_REACTIONS, STAR_IDS, TASTES, VARIANT_RULES, formatWishes, giftReaction, giftXp, parseWishes, tasteOf, tasteProblems, variantGiftXp, wishToHint, wishesIn, type GiftId } from '../src';

describe('gift catalogue (#77)', () => {
  it('has five everyday gifts and three of each talent\'s tastes, priced in the plan\'s range', () => {
    expect(GIFTS).toHaveLength(20);
    expect([...GIFT_IDS].sort()).toEqual(Object.keys(GIFT_RULES.prices).sort());
    for (const g of GIFTS) {
      expect(g.price, g.id).toBeGreaterThanOrEqual(50);
      expect(g.price, g.id).toBeLessThanOrEqual(300);
      expect(g.name.ja && g.name['zh-Hant'] && g.name.en, g.id).toBeTruthy();
    }
  });

  it('gives every talent tastes that name real gifts, never one both liked and disliked', () => {
    expect(tasteProblems()).toEqual([]);
    for (const star of STAR_IDS) expect(TASTES[star].likes.length, star).toBeGreaterThanOrEqual(3);
  });

  it('counts a liked gift exactly twice an ordinary one, and a disliked one for less', () => {
    for (const id of GIFT_IDS) {
      expect(giftXp(id, 'liked'), id).toBe(2 * giftXp(id, 'plain'));
      expect(giftXp(id, 'disliked'), id).toBeLessThan(giftXp(id, 'plain'));
      expect(giftXp(id, 'disliked'), id).toBeGreaterThan(0);
    }
    expect(tasteOf('nana', 'yakiniku')).toBe('liked');
    expect(tasteOf('mahiro', 'yakiniku')).toBe('plain');
    expect(tasteOf('mahiro', 'alarm')).toBe('disliked');
  });

  it('keeps the variant multiplier within VARIANT_RULES.giftMultiplier (#75)', () => {
    for (const m of Object.values(GIFT_RULES.variantMultiplier)) {
      expect(m).toBeGreaterThanOrEqual(VARIANT_RULES.giftMultiplier.min);
      expect(m).toBeLessThanOrEqual(VARIANT_RULES.giftMultiplier.max);
    }
    expect(variantGiftXp(10, 'liked', true)).toBe(30);
    expect(variantGiftXp(10, 'plain', true)).toBe(10);
  });
});

describe('her tastes in conversation (#77)', () => {
  it('hears a liked gift when she says its name, in every language', () => {
    for (const star of STAR_IDS) for (const id of TASTES[star].likes) {
      const g = GIFTS.find((x) => x.id === id)!;
      for (const lang of ['ja', 'zh-Hant', 'en'] as const) expect(wishesIn(star, `最近ね、${g.name[lang]}が気になるの`), `${star} ${id} ${lang}`).toContain(id);
    }
  });

  it('hears only her own tastes, and English words only as whole words', () => {
    expect(wishesIn('nana', 'メロンパン食べたい')).toEqual([]);
    expect(wishesIn('mahiro', 'I love cats so much')).toEqual(['cat-plush']);
    expect(wishesIn('mahiro', 'catch me later')).toEqual([]);
    expect(wishesIn('unpai', '毛布にくるまってゲームしたい')).toEqual(['new-game', 'blanket']);
  });

  it('brings one taste up on his 5th message and every 20th after, one he does not know yet, in turn', () => {
    const turns = Array.from({ length: 70 }, (_, sent) => [sent + 1, wishToHint('alice', sent, [])] as const).filter(([, h]) => h);
    expect(turns).toEqual([[5, 'tea-leaves'], [25, 'paperback'], [45, 'letter-set'], [65, 'bouquet']]);
    expect(wishToHint('alice', 4, ['tea-leaves'])).toBe('paperback');
    expect(wishToHint('alice', 4, TASTES.alice.likes)).toBeNull();
    expect(wishToHint('alice', 5, [])).toBeNull();
  });

  it('keeps what he knows as gift ids, ignoring anything else', () => {
    expect(parseWishes('yakiniku, karaoke-mic,diamond,yakiniku')).toEqual(['yakiniku', 'karaoke-mic']);
    expect(parseWishes(undefined)).toEqual([]);
    expect(formatWishes(['yakiniku', 'fes-towel', 'yakiniku'] as GiftId[])).toBe('yakiniku,fes-towel');
  });

  it('has a written reaction for every talent, kind and language, naming the gift', () => {
    for (const star of STAR_IDS) for (const [kind, text] of Object.entries(GIFT_REACTIONS[star])) {
      for (const lang of ['ja', 'zh-Hant', 'en'] as const) expect(text[lang], `${star} ${kind} ${lang}`).toContain('{gift}');
    }
    expect(giftReaction('nana', 'yakiniku', 'liked', true, 'ja')).toBe('焼肉ディナー！？ 奈々が言ってたの、覚えててくれたの！？ うれしすぎてジャンプしちゃう！');
    // A plain gift cannot be a wish come true.
    expect(giftReaction('nana', 'bouquet', 'plain', true, 'en')).toBe('Bouquet! Thanks! Anything from you makes me happy!');
  });
});

describe('gift pictures (#77)', () => {
  it('every gift has its picture on the site: a small WebP, one per gift', () => {
    const pub = join(import.meta.dirname, '../../../apps/web/public');
    for (const g of GIFTS) {
      expect(g.image).toBe(`/gifts/${g.id}.webp`);
      const file = join(pub, g.image);
      expect(existsSync(file), g.id).toBe(true);
      expect(statSync(file).size, g.id).toBeLessThan(30_000);
    }
  });
});
