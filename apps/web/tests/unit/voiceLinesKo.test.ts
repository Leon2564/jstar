import { describe, expect, it } from 'vitest';
import { lineFor, type VoiceSlot } from '../../src/components/voiceLines';

// Her recorded greetings' subtitles in Korean (the wake-up moment shows them by his hour since N-42).
describe('her greeting subtitles in Korean', () => {
  it('every talent and slot has a Korean subtitle, not the English one', () => {
    const slots: VoiceSlot[] = ['morning', 'day', 'evening', 'night', 'welcome', 'return', 'levelup', 'gacha-ssr'];
    for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi']) {
      for (const slot of slots) {
        const ko = lineFor(star, slot, 'ko');
        expect(ko, `${star} ${slot}`).toMatch(/[가-힣]/);
        expect(ko, `${star} ${slot}`).not.toBe(lineFor(star, slot, 'en'));
      }
    }
  });
});
