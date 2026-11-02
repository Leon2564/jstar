-- Web Push (#50): one row per browser that allowed notifications. The endpoint is the push service's URL for that
-- browser, so it is the key: signing in to another account in the same browser moves the row to that account.
-- Rows are removed when the push service answers 404/410 (the browser dropped the subscription) and on account
-- deletion. Mirrors PushSubscriptionRow in src/db/types.ts.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  keys       TEXT NOT NULL,          -- JSON {p256dh, auth}: the browser's encryption keys, base64url
  tz         TEXT,                   -- IANA zone the browser reported when it subscribed
  created_at TEXT NOT NULL,
  failed_at  TEXT                    -- last delivery that failed for another reason (5xx, network); cleared on success
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- The user's own clock (IANA zone, e.g. 'Asia/Taipei'), reported when push is turned on: wake-ups ring by it.
-- NULL = never reported; the business calendar (JST) applies.
ALTER TABLE users ADD COLUMN tz TEXT;
