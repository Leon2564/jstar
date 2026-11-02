/**
 * Gift icons (#77): the twenty gifts of packages/shared/src/gifts.ts drawn with openai/gpt-image-2 (config/models.json
 * — the owner's rule: every image is gpt-image-2) in one style, on a transparent background, for the gift sheet in
 * place of emoji. The first icon drawn (the bouquet) is the style reference for the other nineteen.
 *
 *   npm run gifts -w @jstar/media -- [--only=bouquet,teddy] [--force] [--quality=medium] [--process]
 *
 * Raw 1024² PNGs go to tools/media/out/gifts/ (gitignored); the site's files are apps/web/public/gifts/<id>.webp,
 * 192² (a 2× icon for a 48 px tile), trimmed and centred, with alpha. Every call's cost is logged (out/spend.jsonl,
 * docs/SPEND.md). Never prints the key.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GIFT_IDS, type GiftId } from '@jstar/shared/gifts';
import { OUT } from './generate';
import { OutOfCredit, images } from './openrouter';

const MODEL = 'openai/gpt-image-2';
const RAW = join(OUT, 'gifts');
const SITE = resolve(import.meta.dirname, '../../../apps/web/public/gifts');
/** The site's icon: 192² with a little air around the object. */
const SIZE = 192;
const INNER = 172;

/** What each gift looks like. No words anywhere: the catalogue is the same in every language. */
export const GIFT_SUBJECTS: Record<GiftId, string> = {
  bouquet: 'a bouquet of soft pink and white flowers wrapped in pale paper and tied with a satin ribbon',
  macarons: 'three pastel macarons stacked slightly askew',
  candle: 'an aroma candle in a small frosted glass jar with a gentle flame',
  teddy: 'a small, soft teddy bear plush sitting upright',
  alarm: 'a retro twin-bell alarm clock',
  melonpan: 'a Japanese melon bread bun with a crackly criss-cross sugar-cookie top',
  cocoa: 'a mug of hot cocoa topped with whipped cream and a wisp of steam',
  'cat-plush': 'a round, chubby cat plush toy sitting',
  yakiniku: 'a small plate of Japanese yakiniku: thin slices of marbled beef beside a little tabletop grill',
  'karaoke-mic': 'a handheld karaoke microphone with a subtle sparkle',
  'fes-towel': 'a rolled-up music-festival towel with a simple two-colour stripe pattern',
  'new-game': 'a video-game cartridge in a small box decorated only with an abstract star shape',
  'konbini-sweets': 'a Japanese convenience-store custard pudding in a clear cup with dark caramel on top and a small spoon',
  blanket: 'a neatly folded, cozy chunky-knit blanket',
  'tea-leaves': 'a small round tin of black tea, lid ajar, with a few loose tea leaves beside it',
  paperback: 'a small Japanese paperback novel (bunkobon) with a plain cover and a ribbon bookmark',
  'letter-set': 'a letter set: a cream envelope closed with a wax seal, and folded stationery peeking out',
  lipstick: 'a lipstick in an elegant gold case with its cap set beside it',
  'travel-guide': 'a travel guidebook lying open with a folded map and a small location pin',
  'night-view': 'a night-view dinner: a single wine glass in front of a tiny glittering city skyline at night, framed in a circle'
};

const STYLE = [
  'One small icon for the gift picker of a gentle, romantic companion app.',
  'Style: soft, elegant flat illustration with delicate gradients and a warm rim light; rounded shapes; hairline outlines at most.',
  'Palette: the object\'s own colours kept soft, harmonised with ivory (#EFE8ED), dusty rose (#F2A7B6), muted gold (#E8C77A) and deep navy (#24284D) accents.',
  'Composition: the object alone, centred, three-quarter view, filling about 80% of the square.',
  'Absolutely no text, letters, numbers, logos or brands; no people, no hands; no ground shadow; no frame or background shape.',
  'Transparent background.'
].join(' ');

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

/**
 * Trims, centres and shrinks a raw icon to the site's WebP with alpha. gpt-image-2 on OpenRouter takes no
 * `background: transparent`, so the model paints a backdrop: a flat one is flood-filled away from the corners; a
 * painted "transparency" checkerboard (#E8E8E8 / white) is first flattened to white, filled gently (so a white object
 * keeps its edge), and the specks left at the squares' edges are opened away from the alpha.
 */
export function toSiteIcon(raw: string, out: string) {
  const corner = execFileSync('magick', [raw, '-crop', '48x48+0+0', '-format', '%[fx:minima.r*255]', 'info:']).toString().trim();
  const checker = Number(corner) > 225 && Number(corner) < 240;
  const fill = (fuzz: string, max: number) => ['-alpha', 'set', '-fuzz', fuzz, '-fill', 'none',
    '-draw', 'color 0,0 floodfill', '-draw', `color ${max},0 floodfill`, '-draw', `color 0,${max} floodfill`, '-draw', `color ${max},${max} floodfill`];
  const clear = checker
    ? ['-shave', '12x12', '-fuzz', '2.5%', '-fill', 'white', '-opaque', '#E8E8E8', ...fill('4%', 999), '-channel', 'A', '-morphology', 'Open', 'Disk:3', '+channel']
    : fill('6%', 1023);
  execFileSync('magick', [raw, ...clear, '-trim', '+repage', '-resize', `${INNER}x${INNER}`, '-background', 'none', '-gravity', 'center', '-extent', `${SIZE}x${SIZE}`,
    '-quality', '86', '-define', 'webp:alpha-quality=95', '-define', 'webp:method=6', out]);
}

async function main() {
  const only = arg('only')?.split(',') as GiftId[] | undefined;
  const force = process.argv.includes('--force');
  const quality = arg('quality') ?? 'medium';
  await mkdir(RAW, { recursive: true });
  await mkdir(SITE, { recursive: true });
  const ids = (only ?? [...GIFT_IDS]).filter((id) => (GIFT_IDS as readonly string[]).includes(id));
  // --process: only re-make the site's files from the raw drawings (no model calls).
  if (process.argv.includes('--process')) {
    for (const id of ids) if (existsSync(join(RAW, `${id}.png`))) toSiteIcon(join(RAW, `${id}.png`), join(SITE, `${id}.webp`));
    return;
  }
  // The style reference: the bouquet, drawn first.
  const refPath = join(RAW, 'bouquet.png');
  let total = 0;
  for (const id of ['bouquet' as GiftId, ...ids.filter((i) => i !== 'bouquet')]) {
    if (!ids.includes(id) && existsSync(refPath)) continue;
    const raw = join(RAW, `${id}.png`);
    if (!existsSync(raw) || force) {
      const ref = id !== 'bouquet' && existsSync(refPath) ? [await readFile(refPath)] : [];
      const prompt = `${STYLE} The object: ${GIFT_SUBJECTS[id]}.${ref.length ? ' Match the reference image\'s illustration style, palette, lighting and level of detail exactly; draw only the new object.' : ''}`;
      try {
        const r = await images({ model: MODEL, prompt, refs: ref, refMime: 'image/png', aspect: '1:1', quality, format: 'png', purpose: 'gift icon (#77)', id });
        total += r.cost;
        await writeFile(raw, r.images[0]);
        console.log(`${id}: drawn ($${r.cost.toFixed(4)})`);
      } catch (e) {
        if (e instanceof OutOfCredit) { console.error('out of credit — stopping'); break; }
        console.error(`${id}: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
    }
    toSiteIcon(raw, join(SITE, `${id}.webp`));
  }
  console.log(`total $${total.toFixed(4)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) void main();
