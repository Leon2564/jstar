import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clockSlot, fetchGreeting, greetSlot } from '../../src/lib/companion';
import { fallbackArt } from '../../src/components/stills';
import { audioExists, playVoice, setSound } from '../../src/lib/sound';
import { useReveal } from '../../src/components/reveal';
import { CARD_BY_ID } from '../../src/data/cards';
import { MEDIA } from '../../src/data/media.gen';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); (window as unknown as { __REVEAL_SPEED__: number }).__REVEAL_SPEED__ = 0.01; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('companion greeting slot', () => {
  it.each([[4, 'night'], [5, 'morning'], [10, 'morning'], [11, 'day'], [16, 'day'], [17, 'evening'], [20, 'evening'], [21, 'night'], [0, 'night']])('%i:00 → %s', (h, want) => {
    expect(clockSlot(h as number)).toBe(want);
  });
  it('welcomes on the first visit and keeps it for the session', () => {
    const now = Date.parse('2026-10-02T09:00:00');
    expect(greetSlot(now, 9)).toBe('welcome');
    expect(greetSlot(now + 60_000, 9)).toBe('welcome');
  });
  it('says "welcome back" after two days away, the hour otherwise', () => {
    const t0 = Date.parse('2026-10-02T09:00:00');
    localStorage.setItem('jstar.lastSeen', String(t0));
    expect(greetSlot(t0 + 3 * 86_400_000, 22)).toBe('return');
    sessionStorage.clear();
    localStorage.setItem('jstar.lastSeen', String(t0));
    expect(greetSlot(t0 + 3_600_000, 22)).toBe('night');
  });
  it('has no server greeting in prototype mode', async () => {
    expect(await fetchGreeting('mahiro', 'ja')).toBeNull();
  });
});

describe('stand-in card art', () => {
  it('uses her closest still for rare cards and something from her set for common ones', () => {
    const hero = fallbackArt({ id: 's1-mahiro-27', star: 'mahiro' }, 3);
    expect(hero).toMatch(/\/media\/mahiro-(hero|breath)-9x16\//);
    const common = fallbackArt({ id: 's1-mahiro-02', star: 'mahiro' }, 0);
    expect(common).toMatch(/\/media\/mahiro-/);
  });
  it('returns nothing when no media exists (the tile keeps its tint)', () => {
    expect(fallbackArt({ id: 'x-1', star: 'nobody' }, 4)).toBeUndefined();
    expect(Object.keys(MEDIA).length).toBeGreaterThan(0);
  });
});

describe('optional voice files', () => {
  it('treats the SPA fallback page as "no file"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    expect(await audioExists('/voice/greet/mahiro-welcome.mp3')).toBe(false);
    expect(await playVoice('/voice/greet/mahiro-welcome.mp3', true)).toBe(false);
  });
  it('recognises a real audio file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } })));
    expect(await audioExists('/voice/greet/nana-morning.mp3')).toBe(true);
  });
  it('remembers the sound switch', () => {
    setSound(false);
    expect(localStorage.getItem('jstar.sound')).toBe('off');
    setSound(true);
    expect(localStorage.getItem('jstar.sound')).toBe('on');
  });
});

describe('reveal state machine', () => {
  const items = ['s1-mahiro-03', 's1-nana-20', 's1-eimi-30'].map((id) => ({ card: CARD_BY_ID[id], isNew: true }));
  it('turns one card on tap, all on skip', async () => {
    const { result } = renderHook(() => useReveal(items));
    expect(result.current.open).toBe(false);
    await act(async () => { result.current.tap(0); await new Promise((r) => setTimeout(r, 30)); });
    expect(result.current.face).toEqual([true, false, false]);
    act(() => result.current.skip());
    expect(result.current.open).toBe(true);
    expect(result.current.special).toBeNull();
  });
  it('reveal all keeps the full-screen moment for the rarest card (UR)', async () => {
    const { result } = renderHook(() => useReveal(items));
    await act(async () => { void result.current.revealAll(); await new Promise((r) => setTimeout(r, 80)); });
    expect(result.current.special).toBe(2);
    act(() => result.current.closeSpecial());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(result.current.open).toBe(true);
  });
});
