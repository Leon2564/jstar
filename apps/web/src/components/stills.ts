import { media, stillOf } from './stage';

/**
 * Her still that stands in for card art not delivered yet (rarer cards get the closer shots). Kept apart from the
 * card catalog so the home page can show card covers without loading 150 cards.
 */
export function fallbackArt(c: { id: string; star: string }, rank: number): string | undefined {
  const n = Number(/(\d+)$/.exec(c.id)?.[1] ?? 1);
  const kinds = rank >= 3 ? ['hero-9x16', 'breath-9x16'] : rank === 2 ? ['breath-9x16', 'hero-9x16'] : ['costume', 'breath-9x16', 'prop'];
  for (let k = 0; k < kinds.length; k++) {
    const src = stillOf(media(`${c.star}-${kinds[(n + k) % kinds.length]}`));
    if (src) return src;
  }
  return undefined;
}
