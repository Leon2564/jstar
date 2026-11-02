import { describe, expect, it } from 'vitest';
import { DEMO_SERIALS, formatSerial, isValidSerialFormat, normalizeSerial, serialFromPath, serialFromQuery } from '../../src/lib/serial';

describe('serial (printed lucky-card codes)', () => {
  it.each([
    ['9990-0000-0011', '999000000011'],
    ['9990 0000 0011', '999000000011'],
    ['９９９０ー００００ー００１１', '999000000011'],
    ['999000000011', '999000000011'],
    ['  9990_0000_0011  ', '999000000011']
  ])('normalizes %s', (raw, want) => {
    expect(normalizeSerial(raw)).toBe(want);
    expect(isValidSerialFormat(normalizeSerial(raw))).toBe(true);
  });
  it('groups digits as printed', () => {
    expect(formatSerial('999000000011')).toBe('9990-0000-0011');
    expect(formatSerial('99900')).toBe('9990-0');
  });
  it('catches typos with the check digit', () => {
    expect(isValidSerialFormat('999000000012')).toBe(false);
    expect(isValidSerialFormat('999000000021')).toBe(false); // one digit off (Luhn misses only a 09↔90 swap)
  });
  it('rejects wrong length and a leading zero', () => {
    expect(isValidSerialFormat(normalizeSerial('9990-0000-001'))).toBe(false);
    expect(isValidSerialFormat('099900000001')).toBe(false);
  });
  it('accepts every demo code', () => { for (const c of DEMO_SERIALS) expect(isValidSerialFormat(c)).toBe(true); });
  it('never throws on hostile input', () => {
    expect(() => normalizeSerial(undefined as unknown as string)).not.toThrow();
    expect(normalizeSerial('<script>alert(1)</script>')).toBe('1');
  });
  it('only takes a QR code param or path when it is a valid code', () => {
    expect(serialFromQuery('?code=9990-0000-0011')).toBe('999000000011');
    expect(serialFromQuery('?code=%3Cscript%3E')).toBeNull();
    expect(serialFromQuery('?code=' + '1'.repeat(500))).toBeNull();
    expect(serialFromQuery('')).toBeNull();
    expect(serialFromPath('/r/999000000011')).toBe('999000000011');
    expect(serialFromPath('/r/999000000012')).toBeNull();
    expect(serialFromPath('/lucky')).toBeNull();
  });
});
