-- Scene offers (#65): a scene she proposed, or the moment offered (a time window, the weather, a stage reached, an
-- inbox event). The start that accepts one records its source in `scene.trigger`; the rows also keep her proposals
-- within TRIGGER_RULES (packages/shared/src/rules.ts): the daily cap, the gap, and his "not now". Mirrors SceneOfferRow
-- in src/db/types.ts. Deleted with the account.
CREATE TABLE scene_offers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  star        TEXT NOT NULL,
  scene_id    TEXT NOT NULL,
  source      TEXT NOT NULL,                  -- proposed | time
  status      TEXT NOT NULL DEFAULT 'open',   -- open | accepted | declined
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX idx_scene_offers_user ON scene_offers(user_id, created_at);
