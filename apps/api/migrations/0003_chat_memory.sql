-- Long-term chat memory per (owner, talent), written by the persona service (apps/agent/app/memory.py) and
-- handed back to it on every turn: structured facts plus a rolling summary. The companion-home greeting is
-- cached here too, one per JST day and language. Mirrors ChatMemoryRow in src/db/types.ts.
CREATE TABLE chat_memory (
  owner_id      TEXT NOT NULL,                -- user id
  star          TEXT NOT NULL,
  facts         TEXT NOT NULL DEFAULT '{}',   -- JSON object of short strings (call_name, birthday, likes, job …)
  summary       TEXT,
  updated_at    TEXT NOT NULL,
  greeting_day  TEXT,                         -- JST day the cached greeting is for
  greeting_lang TEXT,
  greeting_text TEXT,
  PRIMARY KEY (owner_id, star)
);
