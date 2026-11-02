import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACE_MARGIN, ROOM_CLIP, faceBox } from '../src/faces';

/** Her face in her room's clips (room B「電影字幕」): the box her words must never cover, as fractions of the clip. */
describe('faces (npm run media:faces)', () => {
  it('the largest face, grown by the margin, in fractions of the picture; none when there is no face', () => {
    const d = { width: 1000, height: 2000, faces: [{ x: 100, y: 100, w: 50, h: 50 }, { x: 300, y: 400, w: 400, h: 500 }] };
    const [x0, y0, x1, y1] = faceBox(d)!;
    expect(x0).toBeCloseTo((300 - 400 * FACE_MARGIN.side) / 1000, 3);
    expect(y0).toBeCloseTo((400 - 500 * FACE_MARGIN.top) / 2000, 3);
    expect(x1).toBeCloseTo((700 + 400 * FACE_MARGIN.side) / 1000, 3);
    expect(y1).toBeCloseTo((900 + 500 * FACE_MARGIN.bottom) / 2000, 3);
    expect(faceBox({ width: 1000, height: 1000, faces: [{ x: -100, y: -100, w: 200, h: 200 }] })![0]).toBe(0);
    expect(faceBox({ width: 1000, height: 1000, faces: [] })).toBeNull();
  });

  it('her room has a face for each star\'s home, talk and listening loops, in both ratios where they exist', () => {
    const faces = JSON.parse(readFileSync(join(import.meta.dirname, '../../../apps/web/src/data/faces.gen.json'), 'utf8')) as Record<string, number[]>;
    for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi']) {
      for (const id of [`${star}-herohd-16x9`, `${star}-herohd-9x16`, `${star}-talk-16x9`, `${star}-talk-9x16`, `${star}-idle-16x9`, `${star}-idle-9x16`, `${star}-talkclose-9x16`]) {
        expect(faces[id], id).toHaveLength(4);
        const [x0, y0, x1, y1] = faces[id];
        expect(0 <= x0 && x0 < x1 && x1 <= 1 && 0 <= y0 && y0 < y1 && y1 <= 1, id).toBe(true);
      }
    }
    for (const id of Object.keys(faces)) expect(ROOM_CLIP.test(id), id).toBe(true);
  });
});
