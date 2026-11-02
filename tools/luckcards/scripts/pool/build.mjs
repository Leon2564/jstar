#!/usr/bin/env node
/**
 * 卡池构建器 —— 把 config/pool.<series>.json 展开成设计清单 + 发行量配额。
 *
 * 设计原则：卡池是"数据"不是"代码"。首期封顶多少、几位女優、每档几个设计，
 * 全部由 config 决定；将来出第二弹只是新增一个 config + 新的码批次，
 * 抽卡引擎一行都不用改。
 *
 * 用法: node scripts/pool/build.mjs config/pool.S1.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const cfgPath = process.argv[2] ?? 'config/pool.S1.json';
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

const actors = cfg.actors;
const totalQuota = cfg.codes * cfg.cards_per_redeem;   // 首期总发行量 = 与实体卡 1:1

const rateSum = cfg.tiers.reduce((s, t) => s + t.rate, 0);
if (Math.abs(rateSum - 1) > 1e-9) {
  console.error(`✗ 概率表合计 ${rateSum}，必须等于 1`);
  process.exit(1);
}

const designs = [];
const summary = [];

for (const tier of cfg.tiers) {
  const designCount = tier.designs_per_actor * actors.length;
  const tierQuota = Math.round(totalQuota * tier.rate);
  const base = Math.floor(tierQuota / designCount);
  // 除不尽的余数摊给该档前若干个设计，保证总量分毫不差
  let remainder = tierQuota - base * designCount;

  let idx = 0;
  for (const actor of actors) {
    for (let i = 1; i <= tier.designs_per_actor; i++) {
      const quota = base + (idx < remainder ? 1 : 0);
      designs.push({
        design_id: `${cfg.series}-${actor.id}-${tier.id}-${String(i).padStart(2, '0')}`,
        series: cfg.series,
        actor_id: actor.id,
        tier: tier.id,
        seq: i,
        quota,
      });
      idx++;
    }
  }

  summary.push({
    tier: tier.id,
    rate: tier.rate,
    designs: designCount,
    per_actor: tier.designs_per_actor,
    quota_each: remainder ? `${base}~${base + 1}` : String(base),
    tier_total: tierQuota,
  });
}

// 总量必须严格等于实体卡数量，差一张都说明配置有问题
const issuedTotal = designs.reduce((s, d) => s + d.quota, 0);
if (issuedTotal !== totalQuota) {
  console.error(`✗ 发行量合计 ${issuedTotal} ≠ 目标 ${totalQuota}`);
  process.exit(1);
}

console.log(`\n卡池 ${cfg.series}（${cfg.title}）  ${actors.length} 位女優`);
console.log(`码 ${cfg.codes} × 每码 ${cfg.cards_per_redeem} 抽 = 总发行量 ${totalQuota.toLocaleString()}\n`);
console.log('档位   掉率     设计数  每人  每设计发行量   本档发行量');
console.log('─'.repeat(62));
for (const s of summary) {
  console.log(
    `${s.tier.padEnd(6)} ${(s.rate * 100).toFixed(1).padStart(5)}%  ${String(s.designs).padStart(6)}  ${String(s.per_actor).padStart(4)}  ${s.quota_each.padStart(12)}   ${s.tier_total.toLocaleString().padStart(10)}`
  );
}
console.log('─'.repeat(62));
console.log(`${'合计'.padEnd(5)} ${'100.0'.padStart(6)}%  ${String(designs.length).padStart(6)}  ${String(designs.length / actors.length).padStart(4)}  ${''.padStart(12)}   ${issuedTotal.toLocaleString().padStart(10)}\n`);

const outDir = join('out', 'pool');
mkdirSync(outDir, { recursive: true });

const csv = ['design_id,series,actor_id,tier,seq,quota',
  ...designs.map((d) => `${d.design_id},${d.series},${d.actor_id},${d.tier},${d.seq},${d.quota}`)];
writeFileSync(join(outDir, `${cfg.series}-designs.csv`), csv.join('\n') + '\n');
console.log(`设计清单 → ${join(outDir, `${cfg.series}-designs.csv`)}  (${designs.length} 行)`);
