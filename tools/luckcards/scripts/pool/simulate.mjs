#!/usr/bin/env node
/**
 * 抽卡模型对照实验。
 *
 * 争议点：「某档抽完就不再出现」有两种实现，结果差别很大。
 *   A 按剩余库存加权   —— 等价于把 230,400 张卡洗好牌顺序发（无放回抽样）
 *   B 按固定掉率 + 抽空后重新归一化
 *
 * 这个脚本跑完整的 38,400 码 × 6 抽，分别看「前 10% 兑换的人」和
 * 「后 10% 兑换的人」拿到各档的实际比例，验证尾部用户会不会被饿死。
 *
 * 用法: node scripts/pool/simulate.mjs out/pool/S1-designs.csv
 */

import { readFileSync } from 'node:fs';

const csvPath = process.argv[2] ?? 'out/pool/S1-designs.csv';
const rows = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
const TIERS = ['N', 'R', 'SR', 'SSR', 'UR'];
const RATES = { N: 0.55, R: 0.28, SR: 0.12, SSR: 0.045, UR: 0.005 };

const base = rows.map((l) => {
  const [design_id, , actor_id, tier, , quota] = l.split(',');
  return { design_id, actor_id, tier, quota: Number(quota) };
});

const TOTAL = base.reduce((s, d) => s + d.quota, 0);
const CODES = TOTAL / 6;

function run(mode) {
  const pool = base.map((d) => ({ ...d, left: d.quota }));
  const tierLeft = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const d of pool) tierLeft[d.tier] += d.left;

  const head = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const tail = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const headEnd = Math.floor(CODES * 0.1);
  const tailStart = Math.floor(CODES * 0.9);
  let starved = 0;                       // 抽的时候目标档位已空的次数

  for (let c = 0; c < CODES; c++) {
    for (let s = 0; s < 6; s++) {
      let tier;
      if (mode === 'A') {
        // 剩余库存即权重：档位与设计一起加权，等价于洗牌发牌
        let total = 0;
        for (const t of TIERS) total += tierLeft[t];
        let r = Math.random() * total;
        for (const t of TIERS) { r -= tierLeft[t]; if (r < 0) { tier = t; break; } }
      } else {
        // 固定掉率；命中空档则在非空档位间按原始掉率重新归一化
        let r = Math.random();
        for (const t of TIERS) { r -= RATES[t]; if (r < 0) { tier = t; break; } }
        if (tierLeft[tier] === 0) {
          starved++;
          const alive = TIERS.filter((t) => tierLeft[t] > 0);
          const sum = alive.reduce((a, t) => a + RATES[t], 0);
          let rr = Math.random() * sum;
          for (const t of alive) { rr -= RATES[t]; if (rr < 0) { tier = t; break; } }
        }
      }

      // 档位内按各设计剩余量加权
      let sub = 0;
      for (const d of pool) if (d.tier === tier) sub += d.left;
      let r2 = Math.random() * sub;
      for (const d of pool) {
        if (d.tier !== tier) continue;
        r2 -= d.left;
        if (r2 < 0) { d.left--; tierLeft[tier]--; break; }
      }

      if (c < headEnd) head[tier]++;
      else if (c >= tailStart) tail[tier]++;
    }
  }

  return { head, tail, starved, leftover: TIERS.map((t) => `${t}:${tierLeft[t]}`).join(' ') };
}

const pct = (o) => {
  const n = TIERS.reduce((s, t) => s + o[t], 0);
  return TIERS.map((t) => `${((o[t] / n) * 100).toFixed(2)}%`.padStart(8)).join('');
};

console.log(`\n总发行量 ${TOTAL.toLocaleString()} / ${CODES.toLocaleString()} 个码 × 6 抽`);
console.log(`目标掉率      ` + TIERS.map((t) => `${(RATES[t] * 100).toFixed(2)}%`.padStart(8)).join(''));
console.log('─'.repeat(60));

for (const mode of ['A', 'B']) {
  const label = mode === 'A' ? 'A 剩余库存加权' : 'B 固定掉率+归一化';
  const r = run(mode);
  console.log(`\n【${label}】`);
  console.log(`  前 10% 用户  ` + pct(r.head));
  console.log(`  后 10% 用户  ` + pct(r.tail));
  console.log(`  抽空重定向 ${r.starved} 次   收官剩余 ${r.leftover}`);
}
console.log();
