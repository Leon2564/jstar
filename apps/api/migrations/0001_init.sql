-- JSTAR API schema (Cloudflare D1 / SQLite). Applied by `wrangler d1 migrations apply` in the deploy
-- workflow and by the SQLite test harness (tests/sqlite.ts). Mirrors src/db/types.ts.
-- Times are ISO-8601 strings; JSON columns hold arrays/objects the API reads whole.

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT UNIQUE,
  line_sub         TEXT UNIQUE,
  nickname         TEXT NOT NULL,
  via              TEXT NOT NULL CHECK (via IN ('line', 'email')),
  lang             TEXT NOT NULL,
  age_confirmed_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  points           INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  free_pulls       INTEGER NOT NULL DEFAULT 0 CHECK (free_pulls >= 0),
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'moderator')),
  banned           INTEGER NOT NULL DEFAULT 0,
  pass_until       TEXT,
  chat_day         TEXT NOT NULL DEFAULT '',
  chat_used_today  INTEGER NOT NULL DEFAULT 0,
  bonus_day        TEXT
);

-- A visitor's browser: the trial allowance, and codes redeemed before sign-up.
CREATE TABLE devices (
  id         TEXT PRIMARY KEY,
  trial_used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE device_redemptions (
  serial_id  TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  card_ids   TEXT NOT NULL,          -- JSON array
  trial_days INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_device_redemptions_device ON device_redemptions(device_id);

CREATE TABLE otps (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- Printed lucky-card codes (tools/luckcards). Only HMAC-SHA256(key, code) is stored.
CREATE TABLE serial_batches (
  id         TEXT PRIMARY KEY,       -- '2026A'
  label      TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  trial_days INTEGER NOT NULL,
  draws      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE serials (
  id                 TEXT PRIMARY KEY,   -- printer's serial, '2026A-00001'
  code_hash          TEXT NOT NULL UNIQUE,
  batch_id           TEXT NOT NULL REFERENCES serial_batches(id),
  redeemed_by_user   TEXT,
  redeemed_by_device TEXT,
  redeemed_at        TEXT,
  draw_id            TEXT
);
CREATE INDEX idx_serials_user ON serials(redeemed_by_user);

CREATE TABLE cards (id TEXT PRIMARY KEY, data TEXT NOT NULL);   -- JSON CardDef
CREATE TABLE pools (id TEXT PRIMARY KEY, data TEXT NOT NULL);   -- JSON PoolRow

CREATE TABLE owned (
  user_id        TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  copies         INTEGER NOT NULL,
  first_owned_at TEXT NOT NULL,
  via_serial     INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  star       TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memories_user ON memories(user_id);

-- `n` keeps insertion order: a message and its reply share a timestamp.
CREATE TABLE messages (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  owner_id   TEXT NOT NULL,
  star       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_owner ON messages(owner_id, star, n);

CREATE TABLE affinity (
  user_id TEXT NOT NULL,
  star    TEXT NOT NULL,
  xp      INTEGER NOT NULL,
  PRIMARY KEY (user_id, star)
);

-- Every draw with its seed, for replay in a dispute (docs/compliance-jp.md).
CREATE TABLE draws (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  owner_id   TEXT NOT NULL,
  pool_id    TEXT NOT NULL,
  serial_id  TEXT,
  card_ids   TEXT NOT NULL,          -- JSON array
  tiers      TEXT,                   -- JSON array, lucky codes only
  cost       INTEGER NOT NULL,
  seed       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_draws_owner ON draws(owner_id, n);
CREATE INDEX idx_draws_serial ON draws(serial_id);

CREATE TABLE audit (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  actor_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  meta       TEXT NOT NULL,          -- JSON object
  created_at TEXT NOT NULL
);
