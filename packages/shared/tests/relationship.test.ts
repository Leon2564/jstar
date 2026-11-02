import { describe, expect, it } from 'vitest';
import {
  LEGACY_STAGE_XP, RULES, STAGE_RULES, confess, countDay, freshRelationship, hintOf, legacyStage, loverLevel, rewardRankOf, settle,
  stageAtLeast, stageProgress, viewOf, type RelationshipState
} from '../src';

const AT = '2026-11-02T03:00:00.000Z';
const day = (n: number) => `2026-11-${String(n + 1).padStart(2, '0')}`;
/** One interaction on JST day n: count the day, then apply whatever is due. */
const visit = (s: RelationshipState, n: number, xp: number) => settle(countDay(s, day(n)), xp, AT);

describe('relationship stages (#54)', () => {
  it('needs both the days and the XP: at the minimums the confession is ready on the 7th day together', () => {
    let s = freshRelationship(AT);
    const stages: string[] = [];
    let pulls = 0;
    for (let n = 1; n <= 7; n++) {
      const r = visit(s, n, 10_000);
      s = r.state;
      pulls += r.pulls;
      stages.push(s.stage);
    }
    expect(stages).toEqual(['new', 'familiar', 'familiar', 'ambiguous', 'ambiguous', 'ambiguous', 'confession_ready']);
    expect(pulls).toBe(2);
    // The minimum days are exactly the rule's: 2 + 2 + 3.
    const { new: a, familiar: b, ambiguous: c } = STAGE_RULES.stages;
    expect(a.minDays + b.minDays + c.minDays).toBe(7);
  });

  it('counts a day once, and XP alone moves nothing', () => {
    let s = freshRelationship(AT);
    for (let i = 0; i < 50; i++) s = visit(s, 1, 10_000).state;
    expect(s).toMatchObject({ stage: 'new', daysTogether: 1, lastDay: day(1) });
    expect(countDay(s, day(0))).toBe(s);
    // Days without the XP move nothing either.
    let slow = freshRelationship(AT);
    for (let n = 1; n <= 9; n++) slow = visit(slow, n, (n - 1) * RULES.xpPerMessage).state;
    expect(slow.stage).toBe('new');
    expect(hintOf(slow, 8 * RULES.xpPerMessage)).toBe('talk');
  });

  it('says what she is waiting for without numbers, and fills the bar by XP', () => {
    const s = visit(freshRelationship(AT), 1, 0).state;
    expect(hintOf(s, 0)).toBe('both');
    expect(hintOf(s, STAGE_RULES.stages.new.xp)).toBe('time');
    expect(stageProgress(s, STAGE_RULES.stages.new.xp / 2)).toBe(0.5);
    const familiar = { ...s, stage: 'familiar' as const };
    expect(stageProgress(familiar, STAGE_RULES.stages.new.xp)).toBe(0);
    expect(hintOf({ ...s, stage: 'confession_ready' }, 0)).toBe('ready');
    expect(viewOf('nana', s, 0)).toEqual({ star: 'nana', stage: 'new', daysTogether: 1, anniversary: null, loverLevel: null, hint: 'both', progress: 0 });
  });

  it('becomes lovers only from confession_ready; lover levels count from the confession and are capped', () => {
    const ready: RelationshipState = { ...freshRelationship(AT), stage: 'confession_ready', daysTogether: 7, stageDay: 7, rewardRank: 2 };
    expect(confess({ ...ready, stage: 'ambiguous' }, 500)).toBeNull();
    const lovers = confess(ready, 500, Date.parse('2026-11-08T16:00:00Z'))!;
    // 16:00 UTC is 01:00 JST the next day: the anniversary is the JST date.
    expect(lovers).toMatchObject({ stage: 'lover', anniversary: '2026-11-09', loverXp: 500, rewardRank: 2 });
    expect(loverLevel(lovers, 500)).toBe(1);
    expect(loverLevel(lovers, 500 + STAGE_RULES.loverXpPerLevel)).toBe(2);
    expect(loverLevel(lovers, 1e9)).toBe(STAGE_RULES.loverMaxLevel);
    expect(settle(lovers, 500, AT).pulls).toBe(1);
    expect(settle(lovers, 1e9, AT).pulls).toBe(STAGE_RULES.loverMaxLevel);
    expect(rewardRankOf('lover', STAGE_RULES.loverMaxLevel)).toBe(12);
  });

  it('orders stages for scene triggers and story unlocks, confession_ready counting as ambiguous', () => {
    expect(stageAtLeast('confession_ready', 'ambiguous')).toBe(true);
    expect(stageAtLeast('new', STAGE_RULES.storyTwoStage)).toBe(false);
    expect(stageAtLeast('lover', STAGE_RULES.storyTwoStage)).toBe(true);
    expect(rewardRankOf('confession_ready', null)).toBe(rewardRankOf('ambiguous', null));
  });

  it('maps pre-stage accounts by their old level, never to an event stage (migration 0007)', () => {
    // Lv.3 and Lv.6 at 40 XP a level: the old story-2 unlock and the old "special" persona notes.
    expect(LEGACY_STAGE_XP).toEqual({ familiar: 2 * RULES.xpPerLevel, ambiguous: 5 * RULES.xpPerLevel });
    expect([0, 79, 80, 199, 200, 1e6].map(legacyStage)).toEqual(['new', 'new', 'familiar', 'familiar', 'ambiguous', 'ambiguous']);
  });
});
