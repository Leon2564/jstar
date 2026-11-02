-- v1.1 (#55): her confession. Mirrors ConfessionState in packages/shared/src/confession.ts and ConfessionVoiceRow in
-- src/db/types.ts. The stage itself stays in `relationship` (#54): accepting moves it to lover there.

-- One row per (user, talent) once she has started on her confession: how many answers were not yes, when he gave the
-- last one (she asks again CONFESSION_RULES.retryDays days together later), and which round her inbox message and the
-- moment itself were already recorded for, so neither repeats. Deleted with the account (users.anonymise).
CREATE TABLE confessions (
  user_id        TEXT NOT NULL,
  star           TEXT NOT NULL,
  tries          INTEGER NOT NULL DEFAULT 0,     -- answers that were not yes; the round she is on
  last_answer    TEXT CHECK (last_answer IN ('accept', 'not_yet', 'decline')),
  answered_days  INTEGER,                        -- relationship.days_together at the last answer that was not yes
  answered_on    TEXT,                           -- JST day of the last answer
  invited_round  INTEGER NOT NULL DEFAULT -1,    -- round her inbox message was written for
  invited_inbox  TEXT,                           -- id of that inbox row: guards its insert in the same batch
  reached_round  INTEGER NOT NULL DEFAULT -1,    -- round `confession.reached` was recorded for
  reached_on     TEXT,                           -- JST day of that
  PRIMARY KEY (user_id, star)
);

-- The memory his yes became (docs/compliance-jp.md §7.3): the words he answered with and, only when he chose to keep it,
-- the recording, base64 in the row until the memory store (#51, R2) takes the files over. `consented_at` is when he
-- asked for it to be kept. He can delete the recording alone; the account deletion removes the row.
CREATE TABLE confession_voice (
  memory_id     TEXT PRIMARY KEY,               -- memories.id of the confession card
  user_id       TEXT NOT NULL,
  star          TEXT NOT NULL,
  transcript    TEXT NOT NULL,
  audio_type    TEXT,                           -- audio/webm | audio/mp4 | …; NULL = no recording kept
  audio         TEXT,                           -- base64, at most CONFESSION_RULES.voiceMaxBytes before encoding
  consented_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_confession_voice_user ON confession_voice(user_id, created_at);
-- The tick's invitation job reads the relationships waiting for her confession.
CREATE INDEX idx_relationship_confession ON relationship(stage) WHERE stage = 'confession_ready';
