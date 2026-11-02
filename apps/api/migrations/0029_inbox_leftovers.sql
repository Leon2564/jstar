-- v1.1.1, item 8 of the 278d0e2 acceptance: inbox rows left behind by builds before the v1.1 round-2 fixes, which
-- read them as they happen now (U-29: a scene played to its end reads what invited him; U-41: an answered morning
-- reads its other calls and calls off its snooze). Data only, no schema change. Idempotent: every statement touches
-- only rows still unread (or still undelivered) that the current code would have read (or dropped) — run again, it
-- changes nothing. Nothing is deleted except a snoozed call that can no longer ring for a morning already answered.
-- Read means `read_at` set to now, as opening it would; the rows stay in his history and export.

-- 1. Her invitation (an item naming a scene: payload.scene / payload.sceneId) to a scene he has since played to its end
--    after it came (not left, gone quiet, timed out or replaced): her room no longer leads with it.
UPDATE inbox SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE read_at IS NULL AND delivered_at IS NOT NULL
  AND coalesce(json_extract(payload, '$.scene'), json_extract(payload, '$.sceneId')) IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM scene_runs r
    WHERE r.user_id = inbox.user_id
      AND r.scene_id = coalesce(json_extract(inbox.payload, '$.scene'), json_extract(inbox.payload, '$.sceneId'))
      AND r.ended_at IS NOT NULL AND r.ended_at >= inbox.delivered_at
      AND coalesce(r.outcome, '') NOT IN ('left', 'idle', 'timeout', 'replaced'));

-- 2. Her confession-day message once they are lovers (his yes, whenever and however it was given): nothing left to ask.
UPDATE inbox SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE read_at IS NULL AND delivered_at IS NOT NULL
  AND json_extract(payload, '$.scene') LIKE 'confession-%'
  AND EXISTS (SELECT 1 FROM relationship rel WHERE rel.user_id = inbox.user_id AND rel.star = inbox.star AND rel.stage = 'lover');

-- 3. A wake-up of a morning he already answered (another call of that morning is read): never shown later as ②.
UPDATE inbox SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'wakeup' AND read_at IS NULL AND delivered_at IS NOT NULL
  AND json_extract(payload, '$.day') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM inbox o
    WHERE o.user_id = inbox.user_id AND o.kind = 'wakeup' AND o.id <> inbox.id AND o.read_at IS NOT NULL
      AND json_extract(o.payload, '$.day') = json_extract(inbox.payload, '$.day'));

-- 4. A snoozed call still waiting for a morning he already answered: it would only ring for nothing.
DELETE FROM inbox
WHERE kind = 'wakeup' AND delivered_at IS NULL AND json_extract(payload, '$.snooze') = 1
  AND EXISTS (
    SELECT 1 FROM inbox o
    WHERE o.user_id = inbox.user_id AND o.kind = 'wakeup' AND o.id <> inbox.id AND o.read_at IS NOT NULL
      AND json_extract(o.payload, '$.day') = json_extract(inbox.payload, '$.day'));
