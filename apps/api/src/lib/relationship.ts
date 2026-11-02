import type { FastifyInstance } from 'fastify';
import {
  STAR_IDS, confess, freshRelationship, jstDay, nextChange, rewardRankOf, viewOf,
  type RelationshipInfo, type RelationshipStage, type StarId
} from '@jstar/shared';
import type { RelationshipRow } from '../db/types';
import { newId } from './crypto';

/** A settle loop that keeps losing races is a bug, not traffic: every stage needs days, so a few steps is the most. */
const MAX_STEPS = 16;

/**
 * The relationship stage machine on the server (#54, docs/requirements.md §10.1). The rules are the shared pure
 * functions (packages/shared/src/relationship.ts); this applies them to storage, where every change is conditional
 * on the row's `rev`, pays its free pulls in the same write, and is recorded as `stage.changed`.
 */
export function relationships(app: FastifyInstance) {
  const repos = app.repos;

  /** Applies every change due now, one conditional write at a time; a lost race re-reads and re-decides. */
  async function settle(row: RelationshipRow, xp: number, now: Date): Promise<RelationshipRow> {
    let cur = row;
    for (let i = 0; i < MAX_STEPS; i++) {
      const change = nextChange(cur, xp, now.toISOString());
      if (!change) return cur;
      const done = await repos.relationship.change(cur, { ...cur, ...change.next, rev: newId('rel') }, change.pulls);
      if (!done) {
        const fresh = await repos.relationship.get(cur.userId, cur.star);
        if (!fresh) return cur;
        cur = fresh;
        continue;
      }
      if (done.stage !== cur.stage) await app.recordEvent(cur.userId, 'stage.changed', { star: cur.star, from: cur.stage, to: done.stage });
      cur = done;
    }
    app.log.warn({ userId: row.userId, star: row.star }, 'relationship_settle_gave_up');
    return cur;
  }

  /**
   * He spent time with her (a message, a scene): the JST day counts once as a day together, then the relationship
   * moves on if its days and XP are both met. Call it after the XP of the interaction has been added.
   */
  async function touch(userId: string, star: StarId, now = new Date()): Promise<{ row: RelationshipRow; xp: number }> {
    const row = await repos.relationship.touch(userId, star, jstDay(now), now.toISOString());
    const xp = await repos.affinity.get(userId, star);
    return { row: await settle(row, xp, now), xp };
  }

  /**
   * XP that came without a day together (a gift, #77): the relationship moves on only if its days were already met.
   * No day is counted, so XP from here can speed a stage up but never skip its minimum days. `row` is null before
   * their first message or scene: the XP waits for the first day together.
   */
  async function advance(userId: string, star: StarId, now = new Date()): Promise<{ row: RelationshipRow | null; xp: number }> {
    const [row, xp] = await Promise.all([repos.relationship.get(userId, star), repos.affinity.get(userId, star)]);
    return { row: row ? await settle(row, xp, now) : null, xp };
  }

  /** His stage with her; `new` (not stored) before their first message or scene. */
  async function stageOf(userId: string, star: StarId): Promise<RelationshipStage> {
    return (await repos.relationship.get(userId, star))?.stage ?? 'new';
  }

  async function view(userId: string, star: StarId, row?: RelationshipRow | null, xp?: number): Promise<RelationshipInfo> {
    const r = row === undefined ? await repos.relationship.get(userId, star) : row;
    return viewOf(star, r ?? freshRelationship(new Date().toISOString()), xp ?? (await repos.affinity.get(userId, star)));
  }

  /** All five, in STAR_IDS order. */
  async function all(userId: string): Promise<RelationshipInfo[]> {
    const [rows, xp] = await Promise.all([repos.relationship.forUser(userId), repos.affinity.all(userId)]);
    const now = new Date().toISOString();
    return STAR_IDS.map((star) => viewOf(star, rows.find((r) => r.star === star) ?? freshRelationship(now), xp[star] ?? 0));
  }

  /**
   * He accepted her confession (#55): lovers from now, today is their anniversary, and the lover stage's free pull is
   * paid. Null unless she was ready to confess (or the change lost a race to another one).
   */
  async function becomeLovers(userId: string, star: StarId, now = new Date()): Promise<RelationshipRow | null> {
    const row = await repos.relationship.get(userId, star);
    const xp = await repos.affinity.get(userId, star);
    const next = row && confess(row, xp, now);
    if (!row || !next) return null;
    const done = await repos.relationship.change(row, { ...row, ...next, rev: newId('rel') }, 0);
    if (!done) return null;
    await app.recordEvent(userId, 'stage.changed', { star, from: row.stage, to: 'lover' });
    return settle(done, xp, now);
  }

  /**
   * Demo mode only: puts the relationship at `stage` without the days. The reward rank moves with it, so the demo
   * pays no free pull; a lover starts today.
   */
  async function demoSet(userId: string, star: StarId, stage: RelationshipStage, now = new Date()): Promise<RelationshipRow> {
    const cur = await repos.relationship.get(userId, star) ?? (await repos.relationship.touch(userId, star, jstDay(now), now.toISOString()));
    const xp = await repos.affinity.get(userId, star);
    const iso = now.toISOString();
    const lover = stage === 'lover';
    const next: RelationshipRow = {
      ...cur, stage, stageSince: iso, stageDay: cur.daysTogether, rewardRank: Math.max(cur.rewardRank, rewardRankOf(stage, null)),
      confessedAt: lover ? iso : null, anniversary: lover ? jstDay(now) : null, loverXp: lover ? xp : null, rev: newId('rel')
    };
    return (await repos.relationship.change(cur, next, 0)) ?? cur;
  }

  return { touch, advance, stageOf, view, all, becomeLovers, demoSet };
}
