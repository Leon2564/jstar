import { describe, expect, it, beforeEach } from 'vitest';
import { initialState, load, sanitize, level } from '../../src/lib/state';

describe('persisted state validation', () => {
  beforeEach(() => localStorage.clear());
  it('returns defaults for garbage', () => {
    expect(sanitize(null)).toEqual(initialState());
    expect(sanitize({ v: 2 })).toEqual(initialState());
    expect(sanitize('x')).toEqual(initialState());
  });
  it('recovers from corrupt JSON in storage', () => {
    localStorage.setItem('jstar.v1', '{not json');
    expect(load()).toEqual(initialState());
  });
  it('clamps and drops tampered values', () => {
    const s = sanitize({
      v: 1, ageOk: 'yes', points: -500, freePulls: 1e9, trialLeft: 99,
      owned: { 's1-mahiro-01': 3, '<img src=x onerror=alert(1)>': 1, 's1-nana-02': -4 },
      star: '__proto__', user: { via: 'admin', nickname: 'x' },
      chats: { mahiro: [{ from: 'hacker', text: 'x' }, { from: 'me', text: 'a'.repeat(5000) }] }
    });
    expect(s.ageOk).toBe(false);
    expect(s.points).toBe(0);
    expect(s.freePulls).toBe(99);
    expect(s.trialLeft).toBe(3);
    expect(s.owned).toEqual({ 's1-mahiro-01': 3, 's1-nana-02': 1 });
    expect(s.star).toBe('mahiro');
    expect(s.user).toBeNull();
    expect(s.chats.mahiro).toHaveLength(1);
    expect(s.chats.mahiro[0].text.length).toBe(500);
  });
  it('caps message history length', () => {
    const msgs = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), from: 'me', text: 'hi' }));
    expect(sanitize({ v: 1, chats: { mahiro: msgs } }).chats.mahiro).toHaveLength(200);
  });
  it('restores only a manually selected card that is owned by the matching talent', () => {
    expect(sanitize({
      v: 1,
      owned: { 's1-eimi-29': 1 },
      selectedCards: { eimi: 's1-eimi-29', mahiro: 's1-eimi-29', nana: 's1-nana-30' }
    }).selectedCards).toEqual({ eimi: 's1-eimi-29' });
  });
  it('levels up every 40 affinity', () => {
    expect(level(0)).toBe(1);
    expect(level(39)).toBe(1);
    expect(level(40)).toBe(2);
  });
});
