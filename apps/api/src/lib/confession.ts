import type { FastifyInstance } from 'fastify';
import {
  afterAnswer, answerOfOutcome, confessionOf, confessionOffered, confessionStatus, freshConfession, jstDay, localText,
  type ConfessionAnswer, type ConfessionStatus, type Lang, type StarId
} from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import type { RelationshipRow, SceneGrant, SceneRunRow } from '../db/types';
import { judgeConfession } from './confessionJudge';
import { relationships } from './relationship';

/** Why a confession scene cannot start now (the scene route answers 403 with it). */
export type ConfessionBlock = 'scene_locked' | 'confession_waiting' | 'confession_tonight';

/**
 * Her confession on the server (#55; rules in packages/shared/src/confession.ts). The scene engine plays it
 * (`confession-<star>`); this decides when it may start, records that she reached it, has his answer judged, and
 * applies the answer: lovers with today as the anniversary, or a gentle "later" and another try in two days together.
 */
export function confessions(app: FastifyInstance) {
  const repos = app.repos;
  const rel = relationships(app);

  /** While her lines are drafts (#82, #84): the test site and demos only. */
  const offered = (star: StarId) => confessionOffered(LINES[star].draft, app.demo);

  async function status(userId: string, star: StarId, row?: RelationshipRow | null, now = new Date()): Promise<ConfessionStatus | null> {
    if (!offered(star)) return null;
    const r = row === undefined ? await repos.relationship.get(userId, star) : row;
    if (!r || r.stage !== 'confession_ready') return null;
    return confessionStatus(star, r, await repos.confessions.get(userId, star), now);
  }

  /** Null when he may play `sceneId` now. The evening-only rule is waived in demo mode so the test site works by day. */
  async function blocked(userId: string, sceneId: string, now = new Date()): Promise<ConfessionBlock | null> {
    const which = confessionOf(sceneId);
    if (!which) return 'scene_locked';
    const s = await status(userId, which.star, undefined, now);
    if (!s || s.sceneId !== sceneId) return 'scene_locked';
    if (s.phase === 'waiting') return 'confession_waiting';
    if (!s.tonight && !app.demo) return 'confession_tonight';
    return null;
  }

  /** She said it: `confession.reached`, once per round (the numerator of the admin's confession reach rate, #52). */
  async function reached(userId: string, star: StarId, now = new Date()): Promise<void> {
    const round = (await repos.confessions.get(userId, star))?.tries ?? 0;
    if (await repos.confessions.reach(userId, star, round, jstDay(now))) await app.recordEvent(userId, 'confession.reached', { star });
  }

  /** His words, judged. Her question goes along so the model reads the answer to what she asked. */
  async function judge(star: StarId, lang: Lang, text: string): Promise<ConfessionAnswer> {
    const ask = localText(LINES[star].confession.ask, lang);
    const verdict = await judgeConfession({ star, lang, text, ask });
    if (verdict.source === 'fallback') app.log.warn({ star }, 'confession_judge_fallback');
    return verdict.answer;
  }

  /**
   * The run reached one of the answers' ends: apply it. Called once, by the request whose step ended the run (its
   * write won the run's `seq`), so a repeated answer never applies twice; the stores' own conditions back that up.
   */
  async function answered(run: SceneRunRow, grant: SceneGrant, text: string, now = new Date()): Promise<void> {
    const answer = answerOfOutcome(run.outcome);
    if (!answer || !confessionOf(run.sceneId)) return;
    const { userId, star } = run;
    const [c, r] = await Promise.all([repos.confessions.get(userId, star), repos.relationship.get(userId, star)]);
    const state = c ?? freshConfession();
    if (answer === 'accept') {
      if (!(await rel.becomeLovers(userId, star, now))) app.log.warn({ userId, star }, 'confession_accept_without_ready');
      // His yes becomes the memory: the card the scene granted, with his words. The recording follows only if he
      // chose to keep it (PUT /v1/confession/memories/:id/audio, docs/compliance-jp.md §7.3).
      const memory = grant.memories[0];
      if (memory) await repos.confessions.addVoice({ memoryId: memory.id, userId, star, transcript: text.slice(0, 500), audioType: null, consentedAt: null, createdAt: memory.createdAt });
    }
    await repos.confessions.answer(userId, star, state.tries, afterAnswer(state, answer, r?.daysTogether ?? 0, now));
    await app.recordEvent(userId, 'confession.answered', { star, answer });
  }

  return { offered, status, blocked, reached, judge, answered };
}
