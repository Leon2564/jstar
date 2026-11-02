-- v1.1 (#58, docs/requirements.md §11.3): her messages. Mirrors HerMessageRow in src/db/types.ts. Both tables are
-- deleted with the account (users.anonymise).

-- One row per message she will write to him: planned for his local day once it has begun (the tick's
-- her-messages.plan job), written and delivered when its time comes (her-messages.send). The primary key makes
-- a (user, day, kind) exist once, however many ticks overlap; every change of status is conditional on the one
-- before it, so the model is asked at most once per message.
CREATE TABLE her_messages (
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,              -- his local day (users.tz, JST when unknown)
  kind       TEXT NOT NULL CHECK (kind IN ('dream', 'note', 'invite')),
  star       TEXT NOT NULL,
  inbox_id   TEXT NOT NULL,              -- the inbox row it becomes; fixed when planned
  due_at     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'writing', 'sent', 'skipped')),
  tried_at   TEXT,                       -- when the send job took it (writing): a job that died holds it for a lease
  sent_at    TEXT,
  source     TEXT CHECK (source IN ('model', 'fallback')),
  reason     TEXT,                       -- skipped: off | cap | quiet | late | inactive
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day, kind)
);
-- The send job only looks at rows still waiting, so the index stays small however many were sent.
CREATE INDEX idx_her_messages_due ON her_messages(due_at) WHERE status IN ('planned', 'writing');
-- The global daily cap counts what was written since 0:00 JST.
CREATE INDEX idx_her_messages_sent ON her_messages(sent_at) WHERE status = 'sent';

-- His setting (My page). No row = 'normal'.
CREATE TABLE her_message_prefs (
  user_id    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL CHECK (mode IN ('normal', 'less', 'off')),
  updated_at TEXT NOT NULL
);

-- Planning finds who talked with her recently by the day of their last time together.
CREATE INDEX IF NOT EXISTS idx_relationship_last_day ON relationship(last_day);
