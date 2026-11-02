#!/usr/bin/env node
/**
 * 印厂打样确认页 —— 按 1:1 实际尺寸排 12 张幸运卡，A4 可直接打印。
 * 用途：印前用手机实扫，确认二维码尺寸够小又扫得动、码位不压出血线。
 *
 * 方案 1：二维码全批次通用（随底卡胶印），只有 12 位数字是可变数据。
 *
 * 用法: node scripts/qr/proof-sheet.mjs <codes.csv> <通用二维码.svg> > out/<批次>/proof-sheet.html
 */
import { readFileSync } from 'node:fs';

const [csvPath, svgPath = 'out/qr-generic/jstarcards-generic-Q.svg'] = process.argv.slice(2);
if (!csvPath) {
  console.error('用法: node scripts/qr/proof-sheet.mjs <codes.csv> [通用二维码.svg]');
  process.exit(1);
}
const qrSvg = readFileSync(svgPath, 'utf8')
  .replace(/<\?xml[^>]*\?>/, '').replace(/width="\d+"/, 'width="15mm"').replace(/height="\d+"/, 'height="15mm"');
const rows = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
// 批次号从 serial 前缀取，不写死：2026B 曾因写死 2026A 而印出错误标题
const BATCH = rows[0].split(',')[0].replace(/-\d+$/, '');
// 按行数比例取样：开头连续 6 张（看相邻卡是否有规律可循），
// 中间均匀 4 张，末尾 2 张。批次大小不同也不会越界。
const N = rows.length;
const pick = [...new Set([
  0, 1, 2, 3, 4, 5,
  ...[0.2, 0.4, 0.6, 0.8].map((f) => Math.floor(N * f)),
  N - 2, N - 1,
].filter((i) => i >= 0 && i < N))].slice(0, 12);

const cards = pick.map((i) => {
  const [serial, , formatted] = rows[i].split(',');
  return { serial, formatted };
});

process.stdout.write(`<!doctype html><html lang="ja"><meta charset="utf-8">
<title>jstarcards 幸运卡 二维码打样确认 / ${BATCH}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 0; padding: 10mm;
         background: #fff; color: #111; color-scheme: light only; }
  h1 { font-size: 14pt; margin: 0 0 2mm; }
  .meta { font-size: 8pt; color: #555; margin-bottom: 6mm; line-height: 1.6; }
  .grid { display: flex; flex-wrap: wrap; gap: 4mm; }
  .card {
    background: #fff; width: 63mm; height: 88mm; border: 0.2mm dashed #999; border-radius: 3mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    box-sizing: border-box; page-break-inside: avoid;
  }
  .brand { font-size: 7pt; letter-spacing: .18em; color: #888; margin-bottom: 4mm; }
  .qr { width: 15mm; height: 15mm; }
  .code { font-family: "SF Mono", Menlo, monospace; font-size: 11pt; letter-spacing: .06em; margin-top: 4mm; }
  .hint { font-size: 6.5pt; color: #888; margin-top: 1.5mm; }
  .serial { font-size: 5.5pt; color: #bbb; margin-top: auto; padding-bottom: 3mm; }
</style>
<h1>幸运卡 二维码打样确认表 — 批次 ${BATCH}（方案 1・通用二维码）</h1>
<div class="meta">
  卡面尺寸 63 × 88 mm（虚线为裁切位，实际印刷请按贵司出血规范）・二维码 15 × 15 mm（含 4 模块静区，<b>静区内不可压任何图文</b>）<br>
  <b>二维码全批次相同</b>，可随底卡一起胶印；<b>仅 12 位数字为可变数据</b>。二维码指向 https://jstarcards.ai/lucky ，用户在页面手动输入数字。<br>
  <b>确认要点：① 用 3 台以上不同手机实扫，均能跳转 ② 15mm 若扫不动可放大到 18mm，不可缩小</b>
</div>
<div class="grid">
`);

for (const c of cards) {
  process.stdout.write(`<div class="card">
  <div class="brand">JSTARCARDS</div>
  <div class="qr">${qrSvg}</div>
  <div class="code">${c.formatted}</div>
  <div class="hint">スキャンして特典を受け取る</div>
  <div class="serial">${c.serial}</div>
</div>\n`);
}
process.stdout.write('</div></html>\n');
