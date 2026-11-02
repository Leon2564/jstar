import { DEMO_SERIALS, RULES } from '@jstar/shared';
import { CATALOG } from '@jstar/shared/catalog';
import { hashSerial } from '../lib/crypto';
import type { Repos } from './types';

/** Star Genesis · First Five (packages/shared/src/catalog.s1.json): 5 talents × 30 cards. */
export const SEED_CARDS = CATALOG;

/** Printed lucky-card codes draw from every card until the S1 designs replace them (docs/requirements.md §5). */
export const LUCKY_POOL_ID = 'lucky-s1';

export const DEMO_OTP = '123456';
export const DEMO_ADMIN_EMAIL = 'admin@jstar.demo';
const DEMO_BATCH = 'demo';

/**
 * The catalogue file is the source of truth: new or changed cards are written, unchanged ones are left alone,
 * so a boot costs no writes once the database matches.
 */
export async function seedCatalog(repos: Repos): Promise<void> {
  const current = new Map((await repos.cards.all()).map((c) => [c.id, JSON.stringify(c)]));
  for (const c of SEED_CARDS) if (current.get(c.id) !== JSON.stringify(c)) await repos.cards.upsert(c);
}

/** Demo codes and the demo admin. Idempotent: the database persists, and a used demo code stays used. */
export async function seedDemo(repos: Repos, key: string): Promise<void> {
  const createdAt = new Date().toISOString();
  await repos.serials.createBatch(
    { id: DEMO_BATCH, label: 'Sample cards for partners', quantity: DEMO_SERIALS.length, trialDays: RULES.serialDefaultTrialDays, draws: RULES.lucky.drawsPerCode, createdAt },
    DEMO_SERIALS.map((code, i) => ({ id: `${DEMO_BATCH}-${String(i + 1).padStart(4, '0')}`, codeHash: hashSerial(code, key) }))
  );
  if (await repos.users.byEmail(DEMO_ADMIN_EMAIL)) return;
  await repos.users.create({
    id: 'usr_demo_admin', email: DEMO_ADMIN_EMAIL, lineSub: null, nickname: 'admin', via: 'email', lang: 'ja', ageConfirmedAt: createdAt,
    points: 0, freePulls: 0, role: 'admin', banned: false, passUntil: null, chatDay: '', chatUsedToday: 0, bonusDay: null,
    pity: 0, shards: 0, loginDay: null, checkMonth: null, checkDays: 0, checkClaimed: [], birthday: null, tz: null
  });
}
