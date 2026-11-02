import { describe, expect, it } from 'vitest';
import { CARD_BY_ID, cardMotion } from '../../src/data/cards';

describe('card motion portraits', () => {
  it('maps approved R through UR cards to their motion files', () => {
    for (const star of ['nana', 'unpai']) {
      for (let number = 11; number <= 30; number += 1) {
        const id = `s1-${star}-${String(number).padStart(2, '0')}`;
        expect(cardMotion(CARD_BY_ID[id])).toBe(`/cards/${id}/motion.mp4`);
      }
    }
  });

  it('keeps N cards still', () => {
    expect(cardMotion(CARD_BY_ID['s1-nana-01'])).toBeNull();
    expect(cardMotion(CARD_BY_ID['s1-unpai-01'])).toBeNull();
  });
});
