#!/usr/bin/env node
/** 交付前自检：格式、Luhn、唯一性、哈希与明文是否对得上。 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { isValidCode } from './luhn.mjs';

const [printPath, dbPath, secretPath] = process.argv.slice(2);
const rows = (p) => readFileSync(p, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));

const print = rows(printPath);
const db = rows(dbPath);
const secret = readFileSync(secretPath, 'utf8').trim();
const hash = (c) => createHmac('sha256', Buffer.from(secret, 'hex')).update(c).digest('hex');

const fail = [];
if (print.length !== db.length) fail.push(`行数不一致: print=${print.length} db=${db.length}`);

const seenCode = new Set(), seenHash = new Set();
print.forEach(([serial, code], i) => {
  if (!isValidCode(code)) fail.push(`${serial}: 格式或 Luhn 校验不通过 (${code})`);
  if (seenCode.has(code)) fail.push(`${serial}: 明文码重复 (${code})`);
  seenCode.add(code);
  const [dbSerial, dbHash] = db[i];
  if (dbSerial !== serial) fail.push(`第 ${i + 1} 行 serial 错位: ${serial} vs ${dbSerial}`);
  if (hash(code) !== dbHash) fail.push(`${serial}: 哈希对不上明文`);
  if (seenHash.has(dbHash)) fail.push(`${serial}: 哈希重复`);
  seenHash.add(dbHash);
});

console.log(`校验 ${print.length} 条 —— 唯一明文 ${seenCode.size} / 唯一哈希 ${seenHash.size}`);
if (fail.length) { console.error(`✗ ${fail.length} 项失败:`); fail.slice(0, 20).forEach((f) => console.error('  ' + f)); process.exit(1); }
console.log('✓ 全部通过');
