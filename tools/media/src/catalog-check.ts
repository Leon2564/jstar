/** Dev helper: per-talent checks while a source file is being written (npx tsx src/catalog-check.ts mahiro). */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BANNED, CATALOG_SRC, spokenSeconds, storyChars, tierOf } from './catalog';

const star = process.argv[2];
const src = JSON.parse(await readFile(join(CATALOG_SRC, `${star}.json`), 'utf8'));
console.log(`${star}: ${src.cards.length} cards`);
src.cards.forEach((c: any, i: number) => {
  const n = i + 1;
  const flags: string[] = [];
  if ([...c.title.ja].length > 14) flags.push('title>14');
  if (spokenSeconds(c.line.ja) > 12) flags.push('line>12s');
  if (BANNED.test(c.scene)) flags.push('banned');
  if ((tierOf(n) === 'SSR' || tierOf(n) === 'UR') !== !!c.story) flags.push('story?');
  const story = c.story ? c.story.ja.map(storyChars).join('/') : '';
  console.log(`${String(n).padStart(2)} ${tierOf(n).padEnd(3)} ${spokenSeconds(c.line.ja).toFixed(1)}s ${story.padEnd(8)} ${c.title.ja} ${flags.join(' ')}`);
});
