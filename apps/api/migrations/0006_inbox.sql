-- v1.1 (#49): what she says on her own, at a time she chose, and the scheduled tick that delivers it.
-- Mirrors InboxRow and JobRunRow in src/db/types.ts.

-- Her messages, promises falling due, wake-up calls and calendar events. A row is written ahead of time with its
-- due_at; the tick (POST /v1/ops/tick, every 5 minutes) sets delivered_at once due_at has passed, and only
-- delivered rows are shown. Deleted with the account (users.anonymise).
CREATE TABLE inbox (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  star         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('message', 'promise_due', 'wakeup', 'event')),
  payload      TEXT NOT NULL DEFAULT '{}',   -- JSON object owned by the job that wrote the row; `text` = her line
  due_at       TEXT NOT NULL,
  delivered_at TEXT,
  read_at      TEXT,
  created_at   TEXT NOT NULL
);
-- The badge and the list: a user's delivered rows, unread first.
CREATE INDEX idx_inbox_user ON inbox(user_id, delivered_at, read_at);
-- The delivery job only ever looks at rows still waiting, so the index stays small however long the inbox grows.
CREATE INDEX idx_inbox_due ON inbox(due_at) WHERE delivered_at IS NULL;

-- One row per tick job: when it last started and finished and how it went. Starting a job is a conditional
-- upsert on this row, so two overlapping ticks never run the same job at once and a job runs at most as often
-- as it asks to (src/lib/tick.ts).
CREATE TABLE job_runs (
  job         TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,                          -- NULL while running (or after a crash, until the lease runs out)
  ok          INTEGER,
  error       TEXT,
  result      TEXT,                          -- JSON object the job returned (counts), for the logs
  last_ok_at  TEXT,
  runs        INTEGER NOT NULL DEFAULT 0
);
