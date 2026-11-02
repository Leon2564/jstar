import { describe, expect, it } from 'vitest';
import { safeNext } from '../../src/lib/safeNext';

describe('safeNext (open-redirect guard)', () => {
  it.each(['/', '/me/chat', '/me/cards/mahiro-1', '/serial?code=999000000011'])('allows %s', (v) => expect(safeNext(v)).toBe(v));
  it.each([
    'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/me/chat?x=<script>',
    '/%2F%2Fevil', ' /me/chat', '/me/../../etc', 'data:text/html,hi', '/' + 'a'.repeat(200), null, undefined
  ])('blocks %s', (v) => expect(safeNext(v as string, '/fallback')).toBe('/fallback'));
});
