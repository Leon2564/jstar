-- Gifts (#77, docs/requirements.md §14.3): one row per gift he gave, written in the same batch as the points it cost and
-- the affinity XP it added, so a gift is paid for and counted exactly once. The rows also hold the daily cap
-- (GIFT_RULES.perDay, counted per JST `day`). Items are fixed digital gifts: nothing random, nothing physical.
-- Mirrors GiftRow in src/db/types.ts. Deleted with the account (users.anonymise).
CREATE TABLE gifts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  star       TEXT NOT NULL,
  gift_id    TEXT NOT NULL,
  card_id    TEXT,                 -- the variant card she was wearing (#75), if any
  price      INTEGER NOT NULL,     -- points spent
  xp         INTEGER NOT NULL,     -- her affinity XP it added
  taste      TEXT NOT NULL,        -- liked | plain | disliked
  day        TEXT NOT NULL,        -- JST day, for the daily cap
  created_at TEXT NOT NULL
);
CREATE INDEX idx_gifts_user_day ON gifts(user_id, day);
