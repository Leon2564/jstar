-- v1.1 (#56, docs/requirements.md §10.3): what she calls him, and how she changes for him. Mirrors CallNameState in
-- packages/shared/src/bond.ts and the bond repo in src/db/types.ts. All three tables are deleted with the account
-- (users.anonymise).

-- One row per (user, talent) once he answered her asking to call him differently: the call stage he said yes to, and
-- the highest one she asked about (she never asks about it again). The answer is a conditional upsert on `asked`, so
-- two tabs cannot both answer the same question.
CREATE TABLE call_names (
  user_id      TEXT NOT NULL,
  star         TEXT NOT NULL,
  stage        TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'familiar', 'lover')),
  asked        TEXT NOT NULL DEFAULT 'new' CHECK (asked IN ('new', 'familiar', 'lover')),
  last_answer  TEXT CHECK (last_answer IN ('accepted', 'declined')),
  answered_at  TEXT,
  PRIMARY KEY (user_id, star)
);

-- How often he praised each of her looks ('outfit', 'face' or her variant card's id), as the memory model heard it.
-- Only the count and when: never his words (docs/compliance-jp.md §7.4).
CREATE TABLE look_praise (
  user_id   TEXT NOT NULL,
  star      TEXT NOT NULL,
  look      TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  last_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, star, look)
);

-- The name he asks all five to use (「呼び方」 on My page), in place of his nickname.
CREATE TABLE call_name_prefs (
  user_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
