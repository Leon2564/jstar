-- v1.1 (#51): his memories as assets — what each memory card is, where his files live, his exports, and the files
-- still to be erased after he left. Mirrors MemoryRow, ConfessionVoiceRow and Repos.memoryAssets in src/db/types.ts;
-- rules in docs/compliance-jp.md §7.6.

-- What a memory card came from (packages/shared/src/memories.ts MEMORY_KINDS), the scene it was made in, and the
-- file key of that scene's still once stills exist (#64/#80; the memory store, src/lib/memoryAssets.ts).
ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'scene', 'confession', 'promise'));
ALTER TABLE memories ADD COLUMN scene_id TEXT;
ALTER TABLE memories ADD COLUMN still TEXT;

-- Existing cards are chat cards unless they can be told apart exactly: the confession card his yes became (#55), a
-- scene's card (its id is in the run's rewards, #64), and a promise kept (written in the same statement as kept_at, #59).
UPDATE memories SET kind = 'scene', scene_id = (
  SELECT r.scene_id FROM scene_runs r, json_each(r.state, '$.rewards.memories') j
  WHERE r.user_id = memories.user_id AND json_extract(j.value, '$.id') = memories.id LIMIT 1
) WHERE EXISTS (
  SELECT 1 FROM scene_runs r, json_each(r.state, '$.rewards.memories') j
  WHERE r.user_id = memories.user_id AND json_extract(j.value, '$.id') = memories.id
);
UPDATE memories SET kind = 'confession' WHERE id IN (SELECT memory_id FROM confession_voice);
UPDATE memories SET kind = 'promise' WHERE kind = 'chat' AND EXISTS (
  SELECT 1 FROM promises p WHERE p.user_id = memories.user_id AND p.star = memories.star AND p.status = 'kept' AND p.kept_at = memories.created_at
);

-- The recording of his yes in the memory store (R2 bucket MEMORY, through the Worker's memory.internal relay): its
-- key, `<user_id>/confession/<memory_id>/<random>`. NULL with `audio` set = still base64 in this row (#55, and the
-- fallback while no bucket is bound); the store takes it over on the next read or tick.
ALTER TABLE confession_voice ADD COLUMN audio_key TEXT;
CREATE INDEX idx_confession_voice_legacy ON confession_voice(created_at) WHERE audio IS NOT NULL;
CREATE INDEX idx_confession_voice_kept ON confession_voice(consented_at) WHERE audio_type IS NOT NULL;

-- His exports, one row per JST day he asked for one (MEMORY_RULES.exportsPerDay): the key makes a second one that
-- day impossible. Pruned after a week by the tick; deleted with the account.
CREATE TABLE memory_exports (
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- Accounts deleted whose files may still be in the memory store: written in the deletion's own batch, removed once
-- everything under `<user_id>/` is gone. The deletion tries at once; the tick retries whatever is left.
CREATE TABLE memory_purges (
  user_id       TEXT PRIMARY KEY,
  requested_at  TEXT NOT NULL,
  tried_at      TEXT
);
