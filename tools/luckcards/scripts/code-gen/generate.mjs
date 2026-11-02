#!/usr/bin/env node
/**
 * jstarcards — 幸运卡验证码生成器
 *
 * 生成 N 个互不重复的 12 位纯数字验证码（第 12 位为 Luhn 校验位），
 * 并产出两份文件：
 *   1) print/*.csv  —— 明文码，交给印厂。属于敏感资产，不入库、不进 git。
 *   2) db/*.csv     —— HMAC-SHA256(secret, code) 的哈希，导入 D1。
 *
 * 数据库只存哈希：即使 D1 被拖库，攻击者也拿不到任何一个可用的码。
 * 校验时对用户输入做同样的 HMAC 再查表，成本与明文查表相同。
 *
 * 加印批次必须用 --exclude 把已发批次的明文表带上做排重。
 * 12 位码带校验位后有效空间是 10^11，48,400 个码的生日碰撞概率约 1.2%，
 * 不排重就是拿"两张实体卡印了同一个码"去赌运气——一张被兑换，另一张作废。
 *
 * 用法:
 *   node scripts/code-gen/generate.mjs --count 38400 --batch 2026A
 *   node scripts/code-gen/generate.mjs --count 10000 --batch 2026B \
 *        --exclude out/2026A/print/codes-2026A-PLAINTEXT.csv
 */

import { createHmac, randomInt, createHash } from 'node:crypto';
import { luhnCheckDigit } from './luhn.mjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) {
      const next = arr[i + 1];
      acc.push([cur.slice(2), next === undefined || next.startsWith('--') ? true : next]);
    }
    return acc;
  }, [])
);

const COUNT     = Number(args.count ?? 38400);
const BATCH     = String(args.batch ?? '2026A');
const OUT_DIR   = String(args.out ?? 'out');
const QR_BASE   = String(args['qr-base'] ?? 'https://jstarcards.ai/r');
const SECRET_F  = String(args['secret-file'] ?? 'out/code-hmac.secret');
const EXCLUDE   = args.exclude ? String(args.exclude).split(',').filter(Boolean) : [];
const LENGTH    = 12;

// ---------- 观感过滤 ----------
// 排除看起来"像是假码"或容易被猜的形态，避免用户怀疑随机性，
// 也避免连号码被顺手试出来。
function looksBad(code) {
  if (/(\d)\1{3}/.test(code)) return true;                       // 任意数字连续出现 4 次
  for (let i = 0; i + 4 < code.length; i++) {                    // 5 位以上顺增/顺减
    const w = code.slice(i, i + 5).split('').map(Number);
    const up = w.every((d, j) => j === 0 || d === w[j - 1] + 1);
    const dn = w.every((d, j) => j === 0 || d === w[j - 1] - 1);
    if (up || dn) return true;
  }
  return false;
}

function genCode() {
  for (;;) {
    const digits = [randomInt(1, 10)];                            // 首位 1-9，防止 Excel 吃掉前导零
    for (let i = 1; i < LENGTH - 1; i++) digits.push(randomInt(0, 10));
    const code = digits.join('') + luhnCheckDigit(digits);
    if (!looksBad(code)) return code;
  }
}

// ---------- HMAC 密钥 ----------
// 同一批码的哈希必须用同一把密钥才能对上。密钥丢了 = 全部 38400 个码作废。
function loadOrCreateSecret(path) {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(join(path, '..'), { recursive: true });
  const secret = Buffer.from(Array.from({ length: 32 }, () => randomInt(0, 256))).toString('hex');
  writeFileSync(path, secret + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

const secret = loadOrCreateSecret(SECRET_F);
const hash = (code) => createHmac('sha256', Buffer.from(secret, 'hex')).update(code).digest('hex');

// ---------- 已发批次排重 ----------
const taken = new Set();
for (const f of EXCLUDE) {
  const prev = readFileSync(f, 'utf8').trim().split('\n').slice(1);
  for (const line of prev) taken.add(line.split(',')[1]);
  console.log(`排除已发批次 ${f} —— ${prev.length} 个码`);
}
if (EXCLUDE.length) console.log(`累计需回避 ${taken.size} 个码\n`);

// ---------- 生成 ----------
console.log(`生成 ${COUNT} 个 ${LENGTH} 位验证码 (批次 ${BATCH}) ...`);
const codes = new Set();
let collisions = 0;
while (codes.size < COUNT) {
  const c = genCode();
  if (taken.has(c) || codes.has(c)) { collisions++; continue; }
  codes.add(c);
}
const list = [...codes];
if (EXCLUDE.length) console.log(`  与已发批次/本批次撞号并重摇 ${collisions} 次`);

const now = Math.floor(Date.now() / 1000);
const pad = String(COUNT).length;

const printRows = ['serial,code,code_formatted,qr_url'];
const dbRows    = ['serial,code_hash,batch,created_at'];

list.forEach((code, i) => {
  const serial = `${BATCH}-${String(i + 1).padStart(pad, '0')}`;
  const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
  printRows.push(`${serial},${code},${formatted},${QR_BASE}/${code}`);
  dbRows.push(`${serial},${hash(code)},${BATCH},${now}`);
});

mkdirSync(join(OUT_DIR, 'print'), { recursive: true });
mkdirSync(join(OUT_DIR, 'db'), { recursive: true });

const printPath = join(OUT_DIR, 'print', `codes-${BATCH}-PLAINTEXT.csv`);
const dbPath    = join(OUT_DIR, 'db', `codes-${BATCH}-hashed.csv`);
writeFileSync(printPath, printRows.join('\n') + '\n', { mode: 0o600 });
writeFileSync(dbPath, dbRows.join('\n') + '\n');

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(join(OUT_DIR, `manifest-${BATCH}.json`), JSON.stringify({
  batch: BATCH, count: COUNT, length: LENGTH, checksum: 'luhn',
  qr_base: QR_BASE, generated_at: new Date(now * 1000).toISOString(),
  files: { print: { path: printPath, sha256: sha(printPath) }, db: { path: dbPath, sha256: sha(dbPath) } },
}, null, 2) + '\n');

console.log(`  印厂明文  → ${printPath}   (敏感，勿入库/勿进 git)`);
console.log(`  入库哈希  → ${dbPath}`);
console.log(`  HMAC 密钥 → ${SECRET_F}   (务必备份，丢失则全批码作废)`);
