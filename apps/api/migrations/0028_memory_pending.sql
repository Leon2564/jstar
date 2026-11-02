-- Batched memory updates (cost work, 2026-09-29; apps/agent/app/memory.py `memory_due`). The persona service no longer
-- updates chat memory on every turn: the turns it has not taken in yet wait here, his and hers, oldest first, as a JSON
-- array of {role, text}. They are sent back with every turn (`unsaved`) and all of them go into the next update — on
-- his 5th message, sooner when a turn needs it, when he leaves the chat, or when the conversation has been quiet for a
-- while (tick job `memory.flush`). Kept in D1, so a restart of either service drops nothing. `pending_at` is when the
-- latest turn was added (the quiet timer). Deleted with the row (users.anonymise). Mirrors ChatMemoryRow in src/db/types.ts.
ALTER TABLE chat_memory ADD COLUMN pending TEXT NOT NULL DEFAULT '[]';
ALTER TABLE chat_memory ADD COLUMN pending_at TEXT;
CREATE INDEX chat_memory_pending ON chat_memory (pending_at) WHERE pending_at IS NOT NULL;
