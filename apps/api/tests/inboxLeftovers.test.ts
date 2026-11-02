import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteClient } from './sqlite';

/**
 * Migration 0029 (v1.1.1, item 8 of the 278d0e2 acceptance): the inbox leftovers of older builds are read (or, for a
 * snoozed call of a morning already answered, dropped) — only those, and running it again changes nothing.
 */
const MIGRATION = readFileSync(join(import.meta.dirname, '..', 'migrations', '0029_inbox_leftovers.sql'), 'utf8');
const D = '2026-10-03T10:00:00.000Z';
const row = (id: string, star: string, kind: string, payload: object, delivered: string | null = D, read: string | null = null) =>
  `('${id}', 'usr_1', '${star}', '${kind}', '${JSON.stringify(payload)}', '${D}', ${delivered ? `'${delivered}'` : 'NULL'}, ${read ? `'${read}'` : 'NULL'}, '${D}')`;
const BEFORE = `
  INSERT INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at) VALUES
    ${row('inv_played', 'nana', 'event', { text: '雨だね', sceneId: 'rainy-night-nana' })},
    ${row('inv_left', 'unpai', 'message', { text: '配信するよ', sceneId: 'private-stream' })},
    ${row('inv_unplayed', 'eimi', 'message', { text: '大喜利しよ', sceneId: 'ogiri' })},
    ${row('conf_lover', 'alice', 'message', { text: '今夜、大事なお話が', scene: 'confession-alice' })},
    ${row('conf_due', 'mahiro', 'message', { text: '今夜ね', scene: 'confession-mahiro' })},
    ${row('wake_read', 'nana', 'wakeup', { text: 'おはよ', lineId: 'a', day: '2026-10-03' }, D, '2026-10-03T10:01:00.000Z')},
    ${row('wake_snoozed', 'nana', 'wakeup', { text: 'まだ？', lineId: 'b', day: '2026-10-03', snooze: true })},
    ${row('wake_waiting', 'nana', 'wakeup', { text: 'ほら', lineId: 'c', day: '2026-10-03', snooze: true }, null)},
    ${row('wake_other_day', 'nana', 'wakeup', { text: 'おはよう', lineId: 'd', day: '2026-10-04' })},
    ${row('note', 'nana', 'message', { text: 'ふつうの手紙' })};
  INSERT INTO scene_runs (id, user_id, star, scene_id, step, state, started_at, updated_at, ended_at, outcome) VALUES
    ('run_done', 'usr_1', 'nana', 'rainy-night-nana', 'end', '{}', '2026-10-03T11:00:00.000Z', 'x', '2026-10-03T11:05:00.000Z', 'complete'),
    ('run_left', 'usr_1', 'unpai', 'private-stream', 'x', '{}', '2026-10-03T11:10:00.000Z', 'x', '2026-10-03T11:12:00.000Z', 'left');
  INSERT INTO relationship (user_id, star, stage, stage_since) VALUES ('usr_1', 'alice', 'lover', '${D}'), ('usr_1', 'mahiro', 'confession_ready', '${D}');
`;

describe('migration 0029: the inbox leftovers of older builds', () => {
  it('reads what the current code would have read, drops a snoozed call of an answered morning, and nothing else; idempotent', async () => {
    const db = createSqliteClient({ before: { '0029_inbox_leftovers.sql': BEFORE } });
    const state = async () => Object.fromEntries((await db.batch([{ sql: 'SELECT id, read_at FROM inbox ORDER BY id', params: [] }]))[0].rows.map((r) => [r.id, r.read_at ? 'read' : 'unread']));
    const after = await state();
    expect(after).toEqual({
      inv_played: 'read', inv_left: 'unread', inv_unplayed: 'unread', conf_lover: 'read', conf_due: 'unread',
      wake_read: 'read', wake_snoozed: 'read', wake_other_day: 'unread', note: 'unread'
    });
    // Run again: nothing changes.
    await db.batch(MIGRATION.split(/;\s*\n/).map((s) => s.replace(/^(\s*--.*\n)*/g, '').trim()).filter(Boolean).map((sql) => ({ sql, params: [] })));
    expect(await state()).toEqual(after);
  });
});
