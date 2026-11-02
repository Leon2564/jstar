#!/usr/bin/env node
/**
 * 把入库哈希 CSV 转成 D1 导入用的 SQL（只含哈希，不含明文码）。
 *
 *   node scripts/code-gen/d1-sql.mjs out/2026A/db/codes-2026A-hashed.csv [--trial-days 7] [--draws 6] > out/2026A/db/codes-2026A.sql
 *   npx wrangler d1 execute jstar --remote -c ../../infra/cloudflare/wrangler.jsonc --file out/2026A/db/codes-2026A.sql
 *
 * INSERT OR IGNORE：重复导入同一批次是安全的，已兑换的码不会被重置。
 * 表结构见 apps/api/migrations/0001_init.sql（serial_batches / serials）。
 */
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: d1-sql.mjs <codes-XXXX-hashed.csv> [--trial-days 7] [--draws 6]'); process.exit(1); }
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? Number(rest[i + 1]) : d; };
const trialDays = opt('--trial-days', 7);
const draws = opt('--draws', 6);

const rows = readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
if (!rows.length) { console.error('empty CSV'); process.exit(1); }
const batch = rows[0][2];
for (const [serial, hash, b] of rows) {
  if (!/^[\w-]+$/.test(serial) || !/^[0-9a-f]{64}$/.test(hash) || b !== batch) { console.error(`bad row: ${serial}`); process.exit(1); }
}
const createdAt = new Date(Number(rows[0][3]) * 1000).toISOString();
const out = [
  `INSERT OR IGNORE INTO serial_batches (id, label, quantity, trial_days, draws, created_at) VALUES ('${batch}', 'Lucky cards ${batch}', ${rows.length}, ${trialDays}, ${draws}, '${createdAt}');`
];
// D1 限制单条语句大小，500 行一条。
for (let i = 0; i < rows.length; i += 500) {
  out.push(`INSERT OR IGNORE INTO serials (id, code_hash, batch_id) VALUES\n${rows.slice(i, i + 500).map(([s, h]) => `('${s}', '${h}', '${batch}')`).join(',\n')};`);
}
process.stdout.write(out.join('\n') + '\n');
console.error(`${batch}: ${rows.length} codes, ${trialDays} pass days, ${draws} draws`);
