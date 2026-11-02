/**
 * Where her face goes on the home stage (H1/H2, the UI/UX acceptance of v1.1.0): the clip is cover-fitted to the
 * hero, and its crop (object-position) is chosen from her measured face box (data/faces.gen.json, cut down by
 * vite.config.ts) so her face lands in the part of the screen the copy leaves free, at every size.
 */
import { HERO_FACES } from 'virtual:hero-faces';

export type Box = [number, number, number, number];

const MAHIRO_FEEDBACK_FACE: Box = [0.56, 0.07, 0.70, 0.32];

/** Face measurements for owner-supplied masters that intentionally bypass the generated media pipeline. */
const APPROVED_FACES: Record<string, Box> = {
  'mahiro-enter-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-idle-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-a-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-b-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-c-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-d-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-e-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-f-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-g-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-h-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-i-16x9': MAHIRO_FEEDBACK_FACE,
  'mahiro-react-j-16x9': MAHIRO_FEEDBACK_FACE,
  'alice-enter-16x9': [0.47, 0.06, 0.67, 0.31],
  'alice-enter-9x16': [0.47, 0.06, 0.67, 0.31],
  'nana-enter-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-idle-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-a-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-b-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-c-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-d-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-e-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-f-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-g-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-h-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-i-16x9': [0.44, 0.12, 0.59, 0.46],
  'nana-react-j-16x9': [0.44, 0.12, 0.59, 0.46]
};

/** Her face box in a clip (0–1 of its frame), or a box typical of that ratio while a clip is not in the map yet. */
export const faceBox = (id: string | undefined, ratio: string): Box =>
  ((id && APPROVED_FACES[id]) as Box | undefined)
  ?? ((id && HERO_FACES[id]) as Box | undefined)
  ?? (ratio === '16:9' ? [0.6, 0.17, 0.82, 0.55] : [0.25, 0.23, 0.65, 0.46]);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Crops a cover-fitted clip in a W×H box so her face centre lands as close to (tx, ty) as the crop allows.
 * `scale` is the layer's own zoom about the box centre (the stage's parallax headroom). Returns the crop (0–1 per
 * axis, for object-position) and her face box on screen, in px of the box.
 */
export function placeFace(face: Box, ratio: string, W: number, H: number, tx: number, ty: number, scale = 1): { ox: number; oy: number; box: Box } {
  const ar = ratio === '16:9' ? 16 / 9 : 9 / 16;
  const dw = Math.max(W, H * ar), dh = dw / ar;
  // Targets in the unscaled layer (the layer zooms about the centre afterwards).
  const ux = W / 2 + (tx - W / 2) / scale, uy = H / 2 + (ty - H / 2) / scale;
  const cx = ((face[0] + face[2]) / 2) * dw, cy = ((face[1] + face[3]) / 2) * dh;
  const ox = dw - W > 0.5 ? clamp01((cx - ux) / (dw - W)) : 0.5;
  const oy = dh - H > 0.5 ? clamp01((cy - uy) / (dh - H)) : 0.5;
  const sx = (x: number) => W / 2 + (x * dw - (dw - W) * ox - W / 2) * scale;
  const sy = (y: number) => H / 2 + (y * dh - (dh - H) * oy - H / 2) * scale;
  return { ox, oy, box: [sx(face[0]), sy(face[1]), sx(face[2]), sy(face[3])] };
}

/**
 * The free band for her face on the home's first screen, [left, right] in px: right of the copy column on a desktop,
 * right of her vertical name on a phone or a small landscape window, and always left of the 序號 tab at the right edge.
 * Her face is centred in it (hair kept clear of both edges) and set at a third of the height where the clip is cropped
 * vertically, under the header and above the copy.
 */
export function heroTarget(W: number, H: number, faceW: number): { tx: number; ty: number } {
  const desk = W >= 1024;
  const left = desk ? Math.min(560, W * 0.42) : H > W ? (W < 600 ? 96 : 150) : Math.min(W * 0.42, 400);
  const right = W - 52; // the 序號 tab (44px) and a little air
  const pad = faceW * 0.62;
  const lo = left + pad, hi = right - pad;
  return { tx: lo <= hi ? (lo + hi) / 2 : (left + right) / 2, ty: H * (desk ? 0.38 : 0.33) };
}
