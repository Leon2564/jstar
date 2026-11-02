-- v1.1 (#57): his wake-up alarm. One per user: the time in his own clock, the days, and which of the five wakes him.
-- The 5-minute tick (src/jobs/ringAlarms.ts) rings it as a `wakeup` inbox row, which the same tick delivers and
-- pushes. Mirrors AlarmRow in src/db/types.ts. Deleted with the account (users.anonymise).
CREATE TABLE alarms (
  user_id    TEXT PRIMARY KEY,
  star       TEXT NOT NULL,
  time_local TEXT NOT NULL,              -- 'HH:MM', 24-hour, in his clock
  days       INTEGER NOT NULL DEFAULT 127, -- bit n set = rings on weekday n (0 = Sunday): 127 every day, 62 Mon–Fri
  enabled    INTEGER NOT NULL DEFAULT 1,
  tz         TEXT NOT NULL,              -- IANA zone it was set in; users.tz (his latest clock) wins when set
  -- The per-morning claim: the local day it last rang. A ring is one conditional UPDATE on it, so overlapping or
  -- repeated ticks ring a morning once. Set to today when saved after today's time has passed (no instant ring).
  last_day   TEXT,
  snoozes    INTEGER NOT NULL DEFAULT 0,  -- 「あと5分」 used on last_day
  -- Written by the ring or snooze that won its UPDATE (it is that inbox row's id): the inbox row in the same batch
  -- is inserted only under it, so a statement that lost the race writes nothing.
  ring_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The ring job reads the enabled alarms every tick.
CREATE INDEX idx_alarms_enabled ON alarms(enabled);
