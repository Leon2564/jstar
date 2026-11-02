import { describe, expect, it } from 'vitest';
import { coverX } from '../../src/components/stage';
import { lineFor, slotForTap, voiceUrl } from '../../src/components/voiceLines';

describe('3D stage helpers', () => {
  it('maps a face in a cover-fitted clip onto the screen', () => {
    // 16:9 clip on a 1440×900 screen: 1600 px wide, 80 px cropped each side.
    expect(coverX(0.74, 1440, 900, '16:9')).toBeCloseTo((0.74 * 1600 - 80) / 1440, 5);
    // A clip that fits exactly is not shifted; object-position moves the crop.
    expect(coverX(0.5, 900, 1600, '9:16')).toBeCloseTo(0.5, 5);
    expect(coverX(0.5, 390, 844, '9:16', 0)).toBeGreaterThan(coverX(0.5, 390, 844, '9:16', 1));
  });
  it('her taps follow the hour first, never repeat back to back, and have subtitles in each language', () => {
    expect(slotForTap(0, 8)).toBe('morning');
    expect(slotForTap(0, 23)).toBe('night');
    expect([0, 1, 2, 3].map((n) => slotForTap(n, 14))).toEqual(['day', 'welcome', 'levelup', 'day']);
    for (const lang of ['ja', 'zh-Hant', 'en'] as const) expect(lineFor('mahiro', 'welcome', lang).length).toBeGreaterThan(5);
    expect(lineFor('nobody', 'welcome', 'ja')).toBe('');
    expect(voiceUrl('nana', 'evening')).toBe('/voice/greet/nana-evening.mp3');
  });
});
