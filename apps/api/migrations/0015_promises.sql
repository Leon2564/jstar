-- v1.1 (#59, docs/requirements.md §11.4): promises. Before a time together ends they agree on the next one; when it
-- comes she keeps it herself. Mirrors PromiseRow in src/db/types.ts. Deleted with the account (users.anonymise).
CREATE TABLE promises (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  star          TEXT NOT NULL,
  text          TEXT NOT NULL,              -- the promise as it was made, in `lang`
  due_at        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('wakeup', 'message', 'scene', 'free')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'missed')),
  made_at       TEXT NOT NULL,
  kept_at       TEXT,
  source_msg_id TEXT,                       -- chat promises: his message the memory model heard it in
  source        TEXT NOT NULL CHECK (source IN ('chat', 'proposal', 'scene')),
  scene_id      TEXT,                       -- scene promises: the scene it came from
  lang          TEXT NOT NULL,
  notified_at   TEXT,                       -- the tick wrote her promise_due line (or he kept it before the tick came)
  missed_at     TEXT,
  mentioned_at  TEXT                        -- missed: she brought it up once; never again after this is set
);
-- At most one open promise per talent: a second one is refused until the first is kept or missed.
CREATE UNIQUE INDEX idx_promises_open ON promises(user_id, star) WHERE status = 'open';
-- The tick only looks at open promises, so the index stays small however many are kept.
CREATE INDEX idx_promises_due ON promises(due_at) WHERE status = 'open';
CREATE INDEX idx_promises_user ON promises(user_id, star, made_at);
