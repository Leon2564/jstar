-- Product events behind the v1.1 success metrics and the admin 指標 page (#52). Written only by the API, never
-- reported by the browser. `props` holds ids and enums only (EVENT_PROPS in packages/shared/src/contracts.ts),
-- never chat text. Kept EVENT_RETENTION_DAYS (180) and deleted one JST day at a time; account deletion sets
-- `user_id` to NULL, so the counts survive but no row leads back to the person. Mirrors EventRow in src/db/types.ts.
CREATE TABLE IF NOT EXISTS events (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,                                          -- NULL once the account is deleted
  name       TEXT NOT NULL,
  props      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  day        TEXT NOT NULL,                                 -- JST day: the unit of every metric and of retention
  created_at TEXT NOT NULL
);
-- Per-period counts of one event name.
CREATE INDEX IF NOT EXISTS idx_events_name_day ON events(name, day);
-- Cohorts: a user's first day, and what that user did in a window of days (also the anonymisation update).
CREATE INDEX IF NOT EXISTS idx_events_user_day ON events(user_id, day);
-- Retention: the oldest day, deleted a day at a time.
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
