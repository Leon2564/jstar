import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { SqlClient } from '../src/db/sql';

/** Minimal typing for node:sqlite (Node ≥ 22.13); @types/node 20 does not ship it. */
interface Statement { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): { changes: number | bigint } }
interface Database { exec(sql: string): void; prepare(sql: string): Statement }
// Loaded through require: vite-node does not resolve the `node:sqlite` builtin in an import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Database };

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

/**
 * A fresh in-memory SQLite database with the D1 migrations applied; each batch is one transaction, as on D1.
 * `before` runs SQL right before the named migration file: data an account had before an upgrade, so a migration's
 * backfill is tested on the rows it will really meet.
 */
export function createSqliteClient(opts: { before?: Record<string, string> } = {}): SqlClient {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (opts.before?.[f]) db.exec(opts.before[f]);
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return {
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(({ sql, params }) => {
          const st = db.prepare(sql);
          if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) { const rows = st.all(...params); return { rows, changes: rows.length }; }
          return { rows: [], changes: Number(st.run(...params).changes) };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
}
