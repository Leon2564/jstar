-- Voice minutes (#74, docs/requirements.md §13.6): one row per charge against his voice time — seconds of her runtime
-- voice (#73, `tts`) or of his voice input in a scene (#72, `input`) — and one per extension he bought with points
-- (`extend`, VOICE_RULES.extendCostPoints for VOICE_RULES.extendMinutes). Today's balance is the sum over his rows of
-- the JST `day`, so it resets at 0:00 JST by itself.
--
-- Idempotent per (user_id, request_id): the client's request id, or `scene:<run>:<seq>` for what a scene step charges.
-- A repeat is ignored, so a retried request is charged once. `nonce` is written by the attempt that inserted the row;
-- the points of an extension are taken in the same batch only when this attempt's nonce is the row's, so a replay
-- never takes them twice. Mirrors VoiceLedgerRow in src/db/types.ts. Deleted with the account (users.anonymise).
CREATE TABLE voice_ledger (
  user_id    TEXT NOT NULL,
  request_id TEXT NOT NULL,
  day        TEXT NOT NULL,       -- JST day the charge belongs to
  kind       TEXT NOT NULL,       -- tts | input | extend
  seconds    INTEGER NOT NULL,    -- used (tts, input) or added (extend)
  points     INTEGER NOT NULL DEFAULT 0,  -- points spent (extend)
  nonce      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX idx_voice_ledger_user_day ON voice_ledger(user_id, day);
