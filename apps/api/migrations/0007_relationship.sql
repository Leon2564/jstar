-- v1.1 (#54): the relationship stage per (user, talent). Mirrors RelationshipState in packages/shared/src/relationship.ts
-- (rules: STAGE_RULES in rules.ts, docs/requirements.md §10.1). affinity.xp stays as it is: it is the progress within
-- a stage, and it no longer pays a free pull per 40 XP.
CREATE TABLE relationship (
  user_id       TEXT NOT NULL,
  star          TEXT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'familiar', 'ambiguous', 'confession_ready', 'lover')),
  stage_since   TEXT NOT NULL,              -- when the current stage began (ISO)
  stage_day     INTEGER NOT NULL DEFAULT 0, -- days_together when it began; a stage's days are counted after it ('new' = 0)
  days_together INTEGER NOT NULL DEFAULT 0, -- JST days with at least one message or scene with her
  last_day      TEXT,                       -- the last JST day counted, so a day is counted once however often he comes
  confessed_at  TEXT,
  anniversary   TEXT,                       -- JST day she confessed and he accepted (YYYY-MM-DD), #55
  lover_xp      INTEGER,                    -- affinity XP at that moment: lover levels count from here
  reward_rank   INTEGER NOT NULL DEFAULT 0, -- free pulls already paid, as a rank (rewardRankOf): paid only when it rises
  rev           TEXT,                       -- id of the last change; guards the free pull written in the same batch
  PRIMARY KEY (user_id, star)
);

-- Accounts from before stages (docs/requirements.md §10.1 迁移): the stage their old affinity level stood for, so nothing
-- is taken away — Lv.3 (80 XP) had opened story episode 2 and her "closer" persona notes, Lv.6 (200 XP) the "special"
-- ones. Never confession_ready or lover: those are events. Days together are rebuilt from his messages (JST days).
-- reward_rank starts at the stage's rank: the free pulls he got per level already paid for it, so reaching it again
-- pays nothing; only a later stage does. A migrated stage above 'new' starts its days now (stage_day = days so far),
-- so no one is pushed to the next stage by the deploy itself. Numbers mirror legacyStage() in relationship.ts.
INSERT INTO relationship (user_id, star, stage, stage_since, stage_day, days_together, last_day, reward_rank)
SELECT a.user_id, a.star,
       CASE WHEN a.xp >= 200 THEN 'ambiguous' WHEN a.xp >= 80 THEN 'familiar' ELSE 'new' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       CASE WHEN a.xp >= 80 THEN coalesce(d.days, 0) ELSE 0 END,
       coalesce(d.days, 0),
       d.last_day,
       CASE WHEN a.xp >= 200 THEN 2 WHEN a.xp >= 80 THEN 1 ELSE 0 END
FROM affinity a
LEFT JOIN (
  SELECT owner_id, star, count(DISTINCT date(created_at, '+9 hours')) AS days, max(date(created_at, '+9 hours')) AS last_day
  FROM messages WHERE role = 'user' GROUP BY owner_id, star
) d ON d.owner_id = a.user_id AND d.star = a.star;
