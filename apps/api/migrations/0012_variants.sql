-- Variant cards (#75, docs/requirements.md §14.1): five of the 150 cards are also "another her", with an affinity of
-- her own. One row per user and variant card, written when he first gains variant XP with it (a duplicate's 心意, a
-- variant scene); no row = level 1, nothing gained yet. Which cards are variants is configuration
-- (VARIANT_CARDS in packages/shared/src/rules.ts), not a column. Mirrors CardAffectionRow in src/db/types.ts.
CREATE TABLE card_affection (
  user_id    TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  xp         INTEGER NOT NULL DEFAULT 0,  -- variant XP; 心意 counts here too
  level      INTEGER NOT NULL DEFAULT 1,  -- highest level reached (1–10): a raised threshold never closes an open layer
  kokoro     INTEGER NOT NULL DEFAULT 0,  -- 心意 received from duplicates, in total
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id)
);
