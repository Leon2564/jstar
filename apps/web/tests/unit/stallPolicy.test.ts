import { describe, expect, it } from 'vitest';
import { isCloseShot, stallSpoken } from '../../src/scene/stage';

// N-33 / N-35: when a late clip gets her stall line, and which shots stay close while she listens.
describe('her stall line (N-33, N-35)', () => {
  const base = { tender: false, beforeAnswer: false, said: 0, lastStalled: false, slow: false };

  it('once a scene on a normal connection, never twice in a row', () => {
    expect(stallSpoken(base)).toBe(true);
    expect(stallSpoken({ ...base, said: 1 })).toBe(false);
    expect(stallSpoken({ ...base, said: 1, slow: true })).toBe(true);
    expect(stallSpoken({ ...base, said: 1, slow: true, lastStalled: true })).toBe(false);
  });

  it('never in a tender moment or right before she waits for his answer', () => {
    expect(stallSpoken({ ...base, tender: true })).toBe(false);
    expect(stallSpoken({ ...base, beforeAnswer: true })).toBe(false);
  });

  it('close shots are her close loops and close steps; the wide shot is not', () => {
    expect(isCloseShot({ shot: 'close', media: 'mahiro-scene-confession-close' })).toBe(true);
    expect(isCloseShot({ shot: 'wide', media: 'mahiro-breath' })).toBe(true);
    expect(isCloseShot({ shot: 'wide', media: 'mahiro-hero' })).toBe(false);
    expect(isCloseShot(null)).toBe(false);
  });
});
