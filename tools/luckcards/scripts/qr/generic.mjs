import QRCode from 'qrcode';
import { writeFileSync, mkdirSync } from 'node:fs';
const URL = 'https://jstarcards.ai/lucky';
// 通用码与批次无关，各批次共用一份
const OUT = 'out/qr-generic';
mkdirSync(OUT, { recursive: true });
for (const ecc of ['M', 'Q', 'H']) {
  const svg = await QRCode.toString(URL, { type: 'svg', errorCorrectionLevel: ecc, margin: 4 });
  writeFileSync(`${OUT}/jstarcards-generic-${ecc}.svg`, svg);
  await QRCode.toFile(`${OUT}/jstarcards-generic-${ecc}.png`, URL,
    { errorCorrectionLevel: ecc, margin: 4, width: 354, type: 'png' });   // 30mm@300dpi
  const m = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  console.log(`ECC ${ecc}: 版本 ${(m - 8 - 17) / 4}  ${m - 8}×${m - 8} 模块  (可容忍 ${ecc === 'M' ? 15 : ecc === 'Q' ? 25 : 30}% 遮挡)`);
}
console.log(`\n编码内容: ${URL}`);
