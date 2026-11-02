/**
 * npm run media:faces
 *
 * Her face in each of her room's clips (room B「電影字幕」): apps/web/src/data/faces.gen.json, `{ "<clip id>": [x0, y0,
 * x1, y1] }`, the box her face must keep clear of every word, button and gradient, as fractions of the clip. Her room
 * crops each clip around that face (apps/web/src/pages/room.css), and the e2e geometry check reads the same file.
 *
 * Apple Vision (tools/media/face/face.swift, macOS) finds the largest face on each clip's published poster (the clip's
 * first frame); the box is grown a little by FACE_MARGIN (her fringe, her cheeks). A clip
 * where no face is found is left out: her room then uses the default for its ratio. Only her room's clip families are
 * read (ROOM_CLIP), so the file stays small; it is fetched by her room as a file, never bundled as code.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT } from './generate';
import { detect, type Detection } from './refs';

/** The clips her room's stage shows: her home loops, her talk / listen loops, her reactions, her variant home. */
export const ROOM_CLIP = /^[a-z]+-(?:herohd|hero|hero-(?:morning|day|evening)|breath|night|day|morning|talk|talkclose|idle|react-[a-z]|variant-home|enter)-(?:9x16|16x9)$/;
/** Vision's box already runs from her forehead to just under her chin: a little more above (her fringe) and aside. */
export const FACE_MARGIN = { top: 0.06, bottom: 0, side: 0.03 } as const;

export type FaceBox = [number, number, number, number];
const r3 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

/** The largest face of a detection, grown by FACE_MARGIN, as fractions of the picture (null: no face). */
export function faceBox(d: Pick<Detection, 'width' | 'height' | 'faces'>, m = FACE_MARGIN): FaceBox | null {
  const f = [...d.faces].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!f || !d.width || !d.height) return null;
  return [r3((f.x - f.w * m.side) / d.width), r3((f.y - f.h * m.top) / d.height), r3((f.x + f.w * (1 + m.side)) / d.width), r3((f.y + f.h * (1 + m.bottom)) / d.height)];
}

async function main() {
  const web = join(ROOT, 'apps/web');
  const core = await readFile(join(web, 'src/data/media.gen.ts'), 'utf8');
  const entries = {
    ...JSON.parse(core.slice(core.indexOf('= {') + 2, core.lastIndexOf('};') + 1)),
    ...JSON.parse(await readFile(join(web, 'src/data/media.scene.gen.json'), 'utf8'))
  } as Record<string, { id: string; poster: string }>;
  const clips = Object.values(entries).filter((e) => ROOM_CLIP.test(e.id) && existsSync(join(web, 'public', e.poster)));
  const found = await detect(clips.map((e) => join(web, 'public', e.poster)));
  const out: Record<string, FaceBox> = {};
  clips.forEach((e, i) => { const b = faceBox(found[i]); if (b) out[e.id] = b; else console.log(`  no face: ${e.id}`); });
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  await writeFile(join(web, 'src/data/faces.gen.json'), `${JSON.stringify(sorted).replace(/\],/g, '],\n ')}\n`);
  console.log(`faces: ${Object.keys(out).length} of ${clips.length} clips → apps/web/src/data/faces.gen.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) void main();
