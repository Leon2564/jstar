import { STAR_IDS } from '@jstar/shared';
import type { Repos } from '../src/db/types';

/**
 * An account that has already met all five (N-29: no scene is offered at a first meeting): made long ago, with a
 * word to each of them before. For tests of her offers, which are about later visits.
 */
export const MET_AT = '2026-01-01T00:00:00.000Z';
export async function metBefore(repos: Repos, userId: string): Promise<void> {
  for (const star of STAR_IDS) {
    await repos.messages.add({ id: `met-${userId}-${star}`, ownerId: userId, star, role: 'user', text: 'こんにちは', createdAt: MET_AT });
  }
}
