-- Scene runs (#64): one row each time he plays a scene. Where the run stands in its script lives in `state`
-- (JSON RunState, packages/shared/src/scenes/engine.ts); `seq` counts accepted answers and guards every change, so a
-- repeated submission is recognised and two parallel ones cannot both apply. Mirrors SceneRunRow in src/db/types.ts.
CREATE TABLE scene_runs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  star       TEXT NOT NULL,
  scene_id   TEXT NOT NULL,
  step       TEXT NOT NULL,              -- the step waiting for him, or the end that was reached
  seq        INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL,              -- JSON RunState
  rewarded   INTEGER NOT NULL DEFAULT 0, -- 1 = this run pays its rewards (one per scene per JST day)
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at   TEXT,
  outcome    TEXT                        -- complete (or the end step's outcome) | left | idle | timeout | replaced
);
-- One active run per user: starting another scene closes the current one first.
CREATE UNIQUE INDEX idx_scene_runs_active ON scene_runs(user_id) WHERE ended_at IS NULL;
CREATE INDEX idx_scene_runs_user_scene ON scene_runs(user_id, scene_id, started_at);
