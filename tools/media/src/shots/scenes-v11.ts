/**
 * v1.1 scene clips (#80): the shots the five scene scripts play (packages/shared/src/scenes/<star>/*.json,
 * `sceneClips()` / LANDED_SCENE_CLIPS in packages/shared/src/scenes/media.ts). Clip ids are `<star>-scene-<scene>-<shot>-9x16`; the
 * scripts name the family without the ratio and the player picks the 9:16 file in either orientation.
 *
 * Continuity is the bar: every scene opens on her owner-approved v1 hero loop (`<star>-hero`, restored in #46), so
 * each clip must look like that clip — same hair, outfit, room and light. Nothing here describes her hair or outfit
 * in words (the v2 wording in manifest.TALENTS is a different look: the #79 まひろ clip came out with wavy
 * shoulder-length hair against her straight v1 bob). Instead:
 * - clips that follow the hero start on frame 0 of the published v1 hero mp4 (`<star>-hero-9x16-v1`, the keyframe
 *   asset #88 registered; out/keyframes/v2/<star>-hero-9x16-v1-a.png);
 * - every other still of her is an edit of that v1 frame (or of another still made from it) by gpt-image-2, given
 *   only the v1 frame and a face crop of it (tools/media/src/scene-clips.ts keyframes), and judged by the continuity
 *   line-up against the five v1 frames (continuity.ts), not against the 4K interview refs;
 * - people-free stills come from her published night scene (the room her v1 hero was built on).
 *
 * The stills are MotionKeyframe records, so `media:talent -- keyframes <star> --motion <name>` registers them like
 * the #79 ones. Generate them with scene-clips.ts, never with `media:keyframes -- --motion` (whose prompt carries
 * the v2 hair and outfit text).
 *
 * This file imports only types from manifest.ts: manifest.ts imports it back (MOTION_KEYFRAMES, SHOTS), so a runtime
 * value from there would not exist yet when this module runs.
 */
import type { MotionKeyframe, Shot, Star } from '../manifest';

export interface SceneKeyframe extends MotionKeyframe {
  /**
   * A people-free still taken straight from a published clip (no generation): the frame `at` seconds into
   * apps/web/public/media/<media>/h264-1080x1920.mp4 — e.g. the empty alley where the scene has just cut to it.
   */
  extract?: { media: string; at: number };
  /** Another picked still whose camera (position, framing, background) this one must keep; her look comes from `from`. */
  camera?: string;
  /**
   * A new place and light for her (the morning clips): her face, hair, outfit and accessories still come from `from`,
   * but not its room or night light. The words name the light only; the brief names the place.
   */
  setting?: string;
  /** Her hands only (the piano close-up): no face to judge, so the still is picked by eye, not by the continuity line-up. */
  noFace?: boolean;
}

/** frame 0 of her published v1 hero loop, registered by #88 (media:keyframes -- --extract-v1); `v1w` is the 16:9 one. */
export const v1 = (star: Star) => `${star}-hero-9x16-v1`;
export const v1w = (star: Star) => `${star}-hero-16x9-v1`;

/** The outfit えいみ changes into (#70: a satin dress as the reward): covered shoulders, floor length, not the v1 rose slip dress she leaves in. */
export const EIMI_GOWN = 'a floor-length champagne satin evening gown with long fitted sleeves, a high modest neckline and a softly flowing skirt';

const k = (star: Star, name: string, brief: string, extra: Partial<SceneKeyframe> = {}): SceneKeyframe =>
  ({ name: `${star}-v11-${name}-9x16`, star, ratio: '9:16', person: true, from: v1(star), brief, ...extra });
/** The 16:9 still of a wide shot, edited from her 16:9 v1 frame (desktop plays the wide shots in 16:9). */
const kw = (star: Star, name: string, brief: string, extra: Partial<SceneKeyframe> = {}): SceneKeyframe =>
  ({ name: `${star}-v11-${name}-16x9`, star, ratio: '16:9', person: true, from: v1w(star), brief, ...extra });

export const SCENE_V11_KEYFRAMES: SceneKeyframe[] = [
  // まひろ — balcony at night, straight dark bob, cream cardigan over a white dress.
  k('mahiro', 'cup', 'Same moment, same camera position, framing and lens as reference image 2. She now holds a navy ceramic mug of coffee in both hands in front of her chest, offering it slightly toward the lens, a thin wisp of steam rising from it; a blush-pink mug stays on the little table behind her.'),
  k('mahiro', 'rps', 'The camera moves closer along the same line of sight: she is framed from the chest up, her face in the upper third of the frame, large and clear; the balcony railing and the city lights are softly out of focus behind her. She raises her right hand in front of her chest in a loose, relaxed fist, ready to play rock-paper-scissors: a natural hand with five fingers, the thumb folded over the outside of the fingers, the fist fully inside the frame.'),
  k('mahiro', 'close', 'The camera moves much closer along the same line of sight: a close shot of her face and shoulders, her face large and clear in the upper half of the frame, as if she has leaned in right beside you; the balcony and the city lights are softly out of focus behind her. Her hands are out of the frame.'),
  { name: 'mahiro-v11-coffee-9x16', star: 'mahiro', ratio: '9:16', person: false, from: 'mahiro-night-9x16-poster', brief: 'A close-up of the small wooden table on this balcony: two handmade ceramic mugs side by side, one navy and one blush pink, filled with coffee, a thin wisp of steam rising from each; the railing, the edge of the sheer rose-lit curtain and the city lights softly out of focus behind them.' },
  // 奈々 — living room at night, long straight dark hair with bangs, round glasses, lavender knit.
  k('nana', 'read', 'The camera moves a little closer along the same line of sight: she sits on the same sofa, framed from the waist up. She holds an open paperback book in both hands at chest height, the pages facing her, and looks over it into the lens. Her glasses stay on.'),
  { name: 'nana-v11-book-9x16', star: 'nana', ratio: '9:16', person: false, from: 'nana-night-9x16-poster', brief: 'A close-up of the open paperback lying on the folded knit blanket on this sofa, the warm light of the floor lamp falling across its pages, the rain-streaked window softly out of focus behind.' },
  // うんぱい — neon alley at night, long light-brown hair with bangs, navy varsity jacket with pink sleeves.
  { name: 'unpai-v11-alley-9x16', star: 'unpai', ratio: '9:16', person: false, from: 'unpai-night-9x16', brief: 'The empty alley the scene cuts to just before she runs back (her published night loop, 2.5 s in).', extract: { media: 'unpai-night-9x16', at: 2.5 } },
  k('unpai', 'run', 'She stands in this alley close to the camera, framed from the waist up as in reference image 2, and holds a pair of pearl-white retro over-ear headphones in both hands in front of her chest.', { camera: 'unpai-v11-alley-9x16' }),
  k('unpai', 'share', 'The camera moves closer along the same line of sight: a chest-up close shot. She holds one earcup of a pair of pearl-white retro over-ear headphones against her right ear and holds the other earcup out toward the lens with her left hand, offering it to you; her head tilts slightly toward the lens.'),
  // アリス — glass greenhouse at night, white roses, fairy lights, dark brown shoulder-length hair, white lace blouse with a dark ribbon.
  k('alice', 'flowers', 'Same camera position, lens and light as reference image 2, but she now stands further back in the greenhouse, about three metres from the camera, among the white rose bushes and the fairy lights, seen from the thighs up, her back half turned to the camera, looking back over her shoulder into the lens.'),
  k('alice', 'piano', 'In the same greenhouse at night, closer: she sits at a small white upright piano among the white roses and fairy lights, seen from the front and a little to the side. Her hands rest on the keys in the lower part of the frame (natural hands, five fingers each); her face is in the upper part of the frame, turned to the lens.'),
  k('alice', 'sleeve', 'The camera moves closer along the same line of sight: a chest-up close shot. Her right hand reaches toward the camera and holds the cuff of a dark navy coat sleeve that enters the frame from the bottom edge (the viewer\'s own sleeve; no other person is visible), and she looks into the lens.'),
  // えいみ — hotel suite at night, velvet armchair, rosé, light-brown bob; she changes into the gown.
  k('eimi', 'gown', 'Same room, same camera direction, lens and light as reference image 2. She now stands in front of the velvet armchair, close to the camera, framed from mid-thigh up, her face in the upper third of the frame, large and clear; the armchair, the glass of rosé and the city skyline are softly out of focus behind her. Arms relaxed at her sides.', { wearing: EIMI_GOWN }),
  k('eimi', 'hug', 'The camera is very close: she has stepped right up to you and opens her arms to embrace you; her face, shoulders and forearms fill the frame, her hands reaching toward the edges of the frame, a warm, soft rose-gold glow blooming around her; her face large and clear in the upper half of the frame, her eyes on the lens.', { from: 'eimi-v11-gown-9x16', wearing: EIMI_GOWN }),

  // ── The rest of the storyboard's list (#80 full scope, 2026-09-28): her hands at the piano, the prop close-ups.
  // アリス: the storyboard's "her hands at the piano" close-up, the same piano, blouse and light as her piano still.
  k('alice', 'hands', 'A close-up of her two hands playing the keyboard of the white upright piano in reference image 3, seen from above and a little to the side: her fingers slightly curved on the keys, the white lace cuffs of her blouse at her wrists, the white roses and the fairy lights glowing softly out of focus behind. Her face is out of the frame. Natural, elegant hands with five fingers each, short natural nails. Copy the keys of reference image 3 exactly: the black keys are NOT evenly spaced — two black keys, a gap, three black keys, a gap, repeating — and in each gap two white keys touch with no black key between them.',
    { from: 'alice-v11-piano-9x16', camera: 'alice-v11-keyboard-9x16', noFace: true }),
  // Prop close-ups (no one in them; people-free stills sent inline).
  { name: 'unpai-v11-headphones-9x16', star: 'unpai', ratio: '9:16', person: false, from: 'unpai-v11-run-9x16', brief: 'A close-up of these same pearl-white retro over-ear headphones, set down on the ledge of the glowing vending machine in this alley, where she left them; raindrops glisten on them and on the ledge, and the neon-lit alley is softly out of focus behind. Nobody is holding them.' },
  { name: 'alice-v11-keyboard-9x16', star: 'alice', ratio: '9:16', person: false, from: 'alice-v11-piano-9x16', brief: 'The same small white upright piano among the white roses and fairy lights, seen a little closer from the front, its keyboard lid open, the bench in front of it empty (nobody is there yet); the fairy lights and the glass roof glow softly behind. The keyboard must be a real piano keyboard. The black keys are NOT evenly spaced: they come in groups — two black keys, a gap, three black keys, a gap, then again two, three — and in each gap two white keys touch with no black key between them (E–F and B–C). Count them along the keyboard: 2, 3, 2, 3.' },
  { name: 'eimi-v11-perfume-9x16', star: 'eimi', ratio: '9:16', person: false, from: 'eimi-night-9x16-poster', brief: 'A close-up of a faceted crystal perfume bottle with a rose-gold cap standing on the small side table next to a glass of rosé, the city skyline and Tokyo Tower glittering softly out of focus beyond the window, warm rose light glinting through the glass.' },
  // 16:9 stills of the wide shots (the enter and leave clips): the same moments, framed like her 16:9 v1 frame.
  kw('mahiro', 'cup', 'Same moment, same camera position, framing and lens as reference image 2 (a horizontal frame, she is on the right). She now holds a navy ceramic mug of coffee in both hands in front of her chest, offering it slightly toward the lens, a thin wisp of steam rising from it; a blush-pink mug stays on the little table beside her.'),
  { name: 'unpai-v11-alley-16x9', star: 'unpai', ratio: '16:9', person: false, from: 'unpai-night-16x9', brief: 'The empty alley in 16:9 (her published 16:9 night loop, 2.5 s in), where the desktop scene cuts before she runs back.', extract: { media: 'unpai-night-16x9', at: 2.5 } },
  kw('unpai', 'run', 'She stands in this alley close to the camera, framed from the waist up in the right half of this horizontal frame as in reference image 2, and holds a pair of pearl-white retro over-ear headphones in both hands in front of her chest.', { camera: 'unpai-v11-alley-16x9' }),
  kw('alice', 'flowers', 'Same camera position, lens and light as reference image 2 (a horizontal frame), but she now stands further back in the greenhouse, about three metres from the camera, among the white rose bushes and the fairy lights, seen from the thighs up, her back half turned to the camera, looking back over her shoulder into the lens.'),
  kw('eimi', 'gown', 'Same room, same camera direction, lens and light as reference image 2 (a horizontal frame). She now stands in front of the velvet armchair, close to the camera, just right of centre, framed from mid-thigh up, her face in the upper third of the frame, large and clear; the armchair, the glass of rosé and the city skyline are softly out of focus behind her. Arms relaxed at her sides.', { wearing: EIMI_GOWN })
];

// Prompt parts (copies of manifest.ts's #79 wording; see the note at the top on why they are not imported).
const LOOK = 'Photorealistic live-action footage with exactly the look, light and colour grade of the first frame, Japanese photobook style.';
const HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. The room and light stay the same.';
const NEGATIVE = 'Exactly one adult woman, fully clothed throughout; the same face, hair, outfit and accessories as in the frames. Her eyes stay open except for quick natural blinks: no slow blinks, no eyes held closed, no squinting. Natural hands with five fingers each. She does not speak. No subtitles, no text, no logo, no watermark, no music, no audio.';
const LOOP = 'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.';
const ENDS = 'Start exactly from the first frame and end exactly on the last frame; the camera and the room never change.';
const NO_PEOPLE = 'The space is empty, no people, no hands, no silhouettes.';
const STILL_CAMERA = 'Static locked-off shot, absolutely no camera movement or zoom; only gentle ambient motion.';
const STYLE = 'Photorealistic cinematic photography, deep navy blue shadows with warm rose-pink light accents, fine film grain, natural textures, elegant and quiet mood. No text, no logos, no watermark.';

// Every clip cuts to or from her HD hero / presence clips, so it gets the same high-quality web encode (`-hq` files, #24 phase 4).
// Loops are locked to one still at both ends (seams ~1): they play whole, no crossfade (`xfade: 0`, like herohd), so the
// published first frame is the still the scene cuts on.
const id = (star: Star, scene: string, shot: string) => `${star}-scene-${scene}-${shot}-9x16`;
const her = (star: Star, clip: string, use: string, duration: number, loop: boolean, frames: Shot['frames'], lines: string[]): Shot =>
  ({ id: clip, category: 'character', star, talent: star, model: 'sd25', ratio: '9:16', resolution: '1080p', duration, loop, ...(loop ? { xfade: 0 } : {}), use, frames, prompt: lines.join('\n'), encode: 'hq' });
const empty = (star: Star, clip: string, use: string, duration: number, frames: Shot['frames'], place: string): Shot =>
  ({ id: clip, category: 'scene', star, model: 'sd25', ratio: '9:16', resolution: '1080p', duration, loop: true, xfade: 0, use, frames, prompt: `${place} ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}`, encode: 'hq' });

const MAHIRO = 'is on her balcony at night: the small table with two ceramic mugs, the railing, the city lights below.';
const NANA = 'sits on the sofa in her living room at night: the floor lamp glowing, rain streaking the big window.';
const UNPAI = 'is in the narrow neon-lit alley at night: wet asphalt, the glowing vending machine, light rain.';
const ALICE = 'is in the glass greenhouse at night among white roses and fairy lights.';
const EIMI = 'is in her hotel suite at night: the velvet armchair, the glass of rosé, the city skyline glittering beyond the windows.';

const cup = id('mahiro', 'welcome-home', 'cup'), rps = id('mahiro', 'welcome-home', 'rps');
const run = id('unpai', 'private-stream', 'run'), unpaiLeave = id('unpai', 'private-stream', 'leave');
const leave = id('eimi', 'ogiri', 'leave'), gone = id('eimi', 'ogiri', 'empty'), back = id('eimi', 'ogiri', 'return');

export const SCENE_V11_SHOTS: Shot[] = [
  // ── まひろ「おかえりと、罰ゲーム」(#66)
  her('mahiro', cup, 'Scene #66 (enter): from her hero loop she picks up your mug and holds it out to you', 6, false,
    { first: v1('mahiro'), last: 'mahiro-v11-cup-9x16' }, [
      ENDS, LOOK, `{WOMAN} ${MAHIRO}`,
      '0-1s: she holds the first frame\'s pose, looking into the lens with a soft closed-mouth smile.',
      '1-3s: she turns a little to the small table beside her and picks up the navy mug with both hands, her eyes coming back to the lens.',
      '3-5s: she holds the mug out toward the lens at chest height, a thin wisp of steam rising from it.',
      '5-6s: she settles exactly into the last frame\'s pose and holds still, her eyes on the lens.',
      HOLD, NEGATIVE]),
  empty('mahiro', id('mahiro', 'welcome-home', 'coffee'), 'Scene #66 (detail): the pair of mugs, navy for you and blush pink for her, steaming on the balcony table; loops', 5,
    { first: { still: 'mahiro-v11-coffee-9x16' }, last: { still: 'mahiro-v11-coffee-9x16' } },
    'A close-up of two handmade ceramic mugs, one navy and one blush pink, on the small table on a balcony at night, thin wisps of steam rising and curling from both, the city lights softly out of focus behind, the edge of a sheer curtain stirring very slightly.'),
  her('mahiro', rps, 'Scene #66 (close): "jan, ken…" — her fist ready for rock-paper-scissors while you choose; loops', 5, true,
    { first: 'mahiro-v11-rps-9x16', last: 'mahiro-v11-rps-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${MAHIRO} She is ready to play rock-paper-scissors with you.`,
      '0-1s: she holds the first frame\'s pose: her right hand raised in a loose fist in front of her chest, her eyes on the lens, a playful closed-mouth smile.',
      '1-3.5s: she bounces the fist gently up and down twice in rhythm, "jan, ken", her eyes on the lens.',
      '3.5-5s: she brings the fist back to exactly the first frame\'s position and expression and holds still.',
      HOLD, NEGATIVE]),
  her('mahiro', id('mahiro', 'welcome-home', 'pout'), 'Scene #66 (close): she lost — a puffed-cheek pout, then her fist comes back up for another round; loops', 6, true,
    { first: { after: rps }, last: 'mahiro-v11-rps-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${MAHIRO} She has just lost at rock-paper-scissors.`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      '1-3.5s: she lowers her fist a little, puffs out her cheeks and presses her lips into a small pout, eyebrows drawn together, her eyes open and on the lens, with a small shake of her head.',
      '3.5-5s: her cheeks relax into a soft closed-mouth smile and she raises her fist again, ready for another round.',
      '5-6s: back to exactly the first frame\'s pose and expression; she holds still.',
      HOLD, NEGATIVE]),
  her('mahiro', id('mahiro', 'welcome-home', 'close'), 'Scene #66 (close): her penalty — she comes close to you; loops under her lines', 5, true,
    { first: 'mahiro-v11-close-9x16', last: 'mahiro-v11-close-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${MAHIRO} She is very close to the lens, as if sitting right beside you.`,
      '0-5s: her eyes stay open and on the lens, with the same soft closed-mouth smile as in the first frame; she breathes softly.',
      'Around 1.5s she blinks once, as fast as a real blink.',
      '2-4s: she leans in a little closer and tilts her head slightly, then comes back.',
      '4-5s: back to exactly the first frame\'s pose and expression; she holds still.',
      HOLD, NEGATIVE]),

  // ── 奈々「あなたへの朗読」(#67, also the rain variant)
  empty('nana', id('nana', 'read-aloud', 'book'), 'Scene #67 (detail): the open book under the lamp while you choose what she reads; loops', 5,
    { first: { still: 'nana-v11-book-9x16' }, last: { still: 'nana-v11-book-9x16' } },
    'A close-up of an open paperback book lying on a folded knit blanket on a sofa at night, the warm light of a floor lamp on its pages, one page lifting very slightly and settling, rain running down the window softly out of focus behind.'),
  her('nana', id('nana', 'read-aloud', 'read'), 'Scene #67 (close): she reads to you over the top of the book; loops under the story', 8, true,
    { first: 'nana-v11-read-9x16', last: 'nana-v11-read-9x16' }, [
      LOOP, LOOK, `{WOMAN}, in her glasses, ${NANA} She is reading a story aloud to you.`,
      '0-7s: she holds the open book at chest height and reads from it softly, as if she knows the lines by heart: her lips move gently and calmly, with a short closed-mouth pause between sentences, her eyes open and on the lens over the top of the book.',
      'Around 2s and around 5.5s she blinks once, as fast as a real blink.',
      '3-5s: she lifts the book a little and lowers it again.',
      '7-8s: back to exactly the first frame\'s pose and expression; she holds still.',
      HOLD,
      NEGATIVE.replace('She does not speak.', 'Her lips move as she reads, but there is no sound.')]),
  her('nana', id('nana', 'read-aloud', 'shy'), 'Scene #67 (close): you noticed the detail — she hides behind the book, eyes above it; loops', 5, true,
    { first: 'nana-v11-read-9x16', last: 'nana-v11-read-9x16' }, [
      LOOP, LOOK, `{WOMAN}, in her glasses, ${NANA}`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      '1-3s: she raises the open book to hide her mouth and nose behind it, only her eyes and glasses showing above the pages, her eyes open and on the lens.',
      '3-5s: she lowers the book back to exactly the first frame\'s pose and holds still.',
      HOLD, NEGATIVE]),

  // ── うんぱい「あなただけの配信」(#68)
  her('unpai', run, 'Scene #68 (enter): the empty alley — she runs back to you with her headphones', 6, false,
    { first: { still: 'unpai-v11-alley-9x16' }, last: 'unpai-v11-run-9x16' }, [
      'The first frame is the empty alley; the last frame shows the woman standing in the same alley close to the camera. Start exactly from the first frame and end exactly on the last frame; the camera never moves.',
      LOOK, `{WOMAN}, holding a pair of pearl-white over-ear headphones, comes running back up the narrow neon-lit alley at night.`,
      '0-1s: the empty alley exactly as in the first frame, rain glistening on the asphalt.',
      '1-4s: she runs up the alley toward the camera with light, quick steps, the headphones in her hands, her hair and jacket swaying.',
      '4-6s: she slows down, stops close to the camera and settles exactly into the last frame\'s pose and bright closed-mouth smile, her eyes on the lens, and holds still.',
      HOLD, NEGATIVE]),
  her('unpai', id('unpai', 'private-stream', 'headphones'), 'Scene #68 (detail): she holds the headphones out to you; loops', 5, true,
    { first: { after: run }, last: 'unpai-v11-run-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${UNPAI} She holds a pair of pearl-white over-ear headphones.`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      '1-3s: she holds the headphones out toward the lens with both hands, so they come close to the camera and fill the lower foreground, her eyes on the lens above them.',
      '3-5s: she brings them back to exactly the first frame\'s position and holds still.',
      HOLD, NEGATIVE]),
  her('unpai', id('unpai', 'private-stream', 'share'), 'Scene #68 (close): one earcup each — she leans in to listen with you; loops', 6, true,
    { first: 'unpai-v11-share-9x16', last: 'unpai-v11-share-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${UNPAI} She is close to the lens, one earcup of the pearl-white headphones at her ear, the other held out toward you.`,
      '0-6s: her eyes stay open and on the lens with a bright closed-mouth smile; she sways gently to the music.',
      'Around 1.5s she blinks once, as fast as a real blink.',
      '2-4s: she tilts her head toward the lens and leans a little closer, then comes back.',
      '5-6s: back to exactly the first frame\'s pose and expression; she holds still.',
      HOLD, NEGATIVE]),

  // ── アリス「夜の温室と、延長」(#69)
  her('alice', id('alice', 'night-greenhouse', 'flowers'), 'Scene #69 (enter): "this way" — she walks into the white roses and looks back at you', 6, false,
    { first: v1('alice'), last: 'alice-v11-flowers-9x16' }, [
      ENDS, LOOK, `{WOMAN} ${ALICE}`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      '1-4s: she turns and walks a few unhurried steps away from the camera into the white roses, her back to the lens, the lace of her blouse catching the fairy lights.',
      '4-6s: she stops among the roses, looks back over her shoulder into the lens and settles exactly into the last frame\'s pose, holding still.',
      HOLD, NEGATIVE]),
  her('alice', id('alice', 'night-greenhouse', 'piano'), 'Scene #69 (detail): she plays for you at the piano among the roses; loops', 6, true,
    { first: 'alice-v11-piano-9x16', last: 'alice-v11-piano-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${ALICE} She sits at a white upright piano, her hands on the keys in the foreground.`,
      '0-5s: her fingers play slowly and gracefully across the keys, natural hands with five fingers each; her eyes stay open and on the lens with a shy closed-mouth smile.',
      'Around 2s she blinks once, as fast as a real blink.',
      '5-6s: her hands and pose come back to exactly the first frame; she holds still.',
      HOLD, NEGATIVE]),
  her('alice', id('alice', 'night-greenhouse', 'sleeve'), 'Scene #69 (close): "stay a little longer" — she holds your sleeve and looks aside; loops', 6, true,
    { first: 'alice-v11-sleeve-9x16', last: 'alice-v11-sleeve-9x16' }, [
      LOOP, LOOK, `{WOMAN} ${ALICE} She stands close to you, her right hand holding the cuff of the dark navy coat sleeve that reaches into the frame from the bottom edge (your sleeve; no other person is visible).`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      // First take (09-27): "turns her face a little to the side … glancing sideways" came out as a head turn past 30°
      // with her eyes closed, which the blink check does not see. Now only her eyes and chin move, at eye level.
      '1-3s: she gives the sleeve a small tug and, a little sulky, lips pressed together, looks away to the side: her face stays almost toward the camera (only her chin turns slightly), and her eyes, wide open and bright, move sideways at eye level toward the white roses — not down, not closed.',
      '3-5s: her eyes come back to the lens, still wide open, and she holds the sleeve a moment longer.',
      '5-6s: back to exactly the first frame\'s pose and expression; she holds still.',
      HOLD, NEGATIVE]),

  // ── えいみ「大喜利お姉さん」(#70): leave → empty room → back in the gown → twirl; the hug after her lines.
  her('eimi', leave, 'Scene #70 (wide): "no peeking" — she gets up from the armchair and leaves to change', 6, false,
    { first: v1('eimi'), end: 'empty' }, [
      'Start exactly from the first frame. The camera and the room never change; only she moves, and at the end the room is empty.',
      LOOK, `{WOMAN} ${EIMI}`,
      '0-1s: she sits in the armchair looking into the lens with a soft closed-mouth smile.',
      '1-2.5s: she rises smoothly from the armchair to standing.',
      '2.5-5s: she turns and walks out of the frame past the right edge with natural, graceful steps; by 5s she is completely gone.',
      '5-6s: the same room, empty, from the same camera; only the city lights twinkle.',
      HOLD, NEGATIVE]),
  empty('eimi', gone, 'Scene #70 (empty): her empty suite while she changes; loops until she walks back in', 5,
    { first: { after: leave }, last: { after: leave } },
    'The same hotel suite at night: the velvet armchair, the glass of rosé, the city skyline glittering beyond the windows, the lights twinkling softly.'),
  her('eimi', back, 'Scene #70 (enter): she walks back in wearing the satin gown and stops close to you', 8, false,
    { first: { after: gone }, last: 'eimi-v11-gown-9x16' }, [
      'The first frame is the empty room; the last frame shows the woman standing close to the camera in the same room. Start exactly from the first frame and end exactly on the last frame.',
      LOOK, `{WOMAN}, wearing ${EIMI_GOWN}, comes back into her hotel suite at night.`,
      '0-1s: the empty room exactly as in the first frame.',
      '1-2s: she walks into the frame from the right edge.',
      '2-6s: she walks toward the camera with graceful, unhurried steps, the satin skirt swaying, her eyes on the lens.',
      '6-8s: she stops close to the camera and settles exactly into the last frame\'s pose, framing and confident closed-mouth smile, and holds still.',
      HOLD, NEGATIVE]),
  her('eimi', id('eimi', 'ogiri', 'twirl'), 'Scene #70 (close): she turns around once to show you the gown; loops', 6, true,
    { first: { after: back }, last: 'eimi-v11-gown-9x16' }, [
      LOOP, LOOK, `{WOMAN}, wearing ${EIMI_GOWN}, stands close to the camera in her hotel suite at night.`,
      '0-1s: she holds the first frame\'s pose, looking into the lens with her confident closed-mouth smile.',
      '1-5s: she turns slowly around on the spot in one smooth, continuous turn, so the back of the gown and its flowing satin skirt are seen, and comes round to face the lens again.',
      '5-6s: back to exactly the first frame\'s pose, expression and framing; she holds still.',
      HOLD, NEGATIVE]),
  her('eimi', id('eimi', 'ogiri', 'hug'), 'Scene #70 (close, the ceiling of the tone): she steps in and opens her arms to hug you, warm glow; shoulders-up at most', 6, false,
    { first: 'eimi-v11-gown-9x16', last: 'eimi-v11-hug-9x16' }, [
      ENDS, LOOK, `{WOMAN}, wearing ${EIMI_GOWN}, ${EIMI.replace(/^is /, 'stands ')}`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      '1-4s: she steps slowly toward the camera and opens her arms to embrace you, coming so close that her face, shoulders and arms fill the frame, a warm, soft glow blooming around her.',
      '4-6s: she settles exactly into the last frame\'s pose and holds still, her eyes on the lens.',
      HOLD, NEGATIVE]),

  // ── #80 full scope (2026-09-28): the rest of the storyboard's list.
  // うんぱい runs out of the frame to fetch her headphones (the scene used to cut straight from her to the empty alley).
  her('unpai', unpaiLeave, 'Scene #68 (wide): "wait for me" — she runs off into the alley to fetch her headphones; the alley is empty at the end', 6, false,
    { first: v1('unpai'), end: 'empty' }, [
      'Start exactly from the first frame. The camera and the alley never change; only she moves, and at the end the alley is empty.',
      LOOK, `{WOMAN} ${UNPAI}`,
      '0-1s: she holds the first frame\'s pose, looking into the lens with a bright closed-mouth smile.',
      '1-2s: she turns away from the camera.',
      // Draft 1: seen from behind she had bare legs in short shorts and a heavier build than her v1 look. Below the v1
      // frame's edge nothing anchors her, so the prompt says what is there (no "wearing": the v1 frame carries the rest).
      '2-4.5s: she runs off into the alley with light, quick steps, her slim figure in the same varsity jacket with long dark denim jeans and white sneakers, her hair and jacket swaying, and out of the frame; by 4.5s she is completely gone.',
      '4.5-6s: the same alley, empty, from the same camera; rain glistens on the asphalt and the vending machine glows.',
      HOLD, NEGATIVE]),
  empty('unpai', id('unpai', 'private-stream', 'headphones-prop'), 'Scene #68 (detail, prop): her pearl-white headphones on the vending machine ledge — what she ran to fetch; loops', 5,
    { first: { still: 'unpai-v11-headphones-9x16' }, last: { still: 'unpai-v11-headphones-9x16' } },
    'A close-up of a pair of pearl-white retro over-ear headphones resting on the ledge of a glowing vending machine in a narrow alley at night, raindrops glistening on them, neon reflections sliding softly across them, light rain falling out of focus behind.'),
  // アリス: the empty piano she leads you to, then her hands at the keys (the storyboard's 特写：钢琴).
  empty('alice', id('alice', 'night-greenhouse', 'piano-prop'), 'Scene #69 (empty, prop): the white piano among the roses, its bench still empty — "follow me"; loops', 5,
    { first: { still: 'alice-v11-keyboard-9x16' }, last: { still: 'alice-v11-keyboard-9x16' } },
    'A small white upright piano with its keyboard lid open stands among white rose bushes in a glass greenhouse at night, the bench in front of it empty, tiny fairy lights twinkling softly among the roses, a single petal drifting down.'),
  // Her hands (the storyboard's 手部特写): the camera glides from her at the piano down to her hands on the keys. It
  // opens on her piano still (her asset) and ends on the hands still, which shows no face and is sent inline.
  her('alice', id('alice', 'night-greenhouse', 'hands'), 'Scene #69 (detail): from her at the piano, the camera glides down to a close-up of her hands playing for you', 6, false,
    { first: 'alice-v11-piano-9x16', last: { still: 'alice-v11-hands-9x16' } }, [
      'The first frame shows the woman at the piano; the last frame is a close-up of her hands on the keys. Start exactly from the first frame and end exactly on the last frame.',
      LOOK, `{WOMAN} ${ALICE} She plays the small white upright piano for you.`,
      '0-1s: she plays softly, as in the first frame, her eyes on the lens.',
      '1-4.5s: the camera glides slowly and smoothly down and in toward the keyboard while her fingers keep playing a gentle, flowing melody, natural hands with five fingers each, until her hands and the lace cuffs fill the frame and her face has left the top of the frame.',
      '4.5-6s: a close-up of her hands playing, settling exactly into the last frame.',
      'No cut; the greenhouse, the roses and the fairy lights stay the same.',
      NEGATIVE]),
  // えいみ: her new perfume, the beat before the hug (「香水、変えたの」).
  empty('eimi', id('eimi', 'ogiri', 'perfume'), 'Scene #70 (detail, prop): her new perfume beside the rosé — "did you notice?"; loops', 5,
    { first: { still: 'eimi-v11-perfume-9x16' }, last: { still: 'eimi-v11-perfume-9x16' } },
    'A close-up of a faceted crystal perfume bottle with a rose-gold cap on a small side table beside a glass of rosé in a hotel suite at night, light glinting and shifting softly through the crystal, the city skyline glittering out of focus beyond the window.'),
  // 奈々: the storyboard's "reads, then looks up at you", after the last line of the story.
  her('nana', id('nana', 'read-aloud', 'lookup'), 'Scene #67 (close): she finishes the passage — her eyes on the page, then up to you', 5, true,
    { first: 'nana-v11-read-9x16', last: 'nana-v11-read-9x16' }, [
      LOOP, LOOK, `{WOMAN}, in her glasses, ${NANA} She has just read the last line of a story to you.`,
      '0-1s: she holds the first frame\'s pose, her eyes on the lens.',
      '1-3s: she lowers her gaze to the open page and reads the last line once more to herself, her eyes open behind her glasses and following the words.',
      '3-4s: she lifts her eyes from the book to the lens with a soft closed-mouth smile.',
      '4-5s: back to exactly the first frame\'s pose and expression; she holds still.',
      HOLD, NEGATIVE])
];

/**
 * 16:9 versions of the wide shots (enter / leave / the empty room): the scripts name the family, so a landscape
 * screen plays these and a portrait one the 9:16 files. Same prompts; their frames are the 16:9 v1 frame and the
 * 16:9 stills. Close and detail shots stay 9:16 only (the player crops them in landscape, as before).
 */
const wide = (base: string, frames: Shot['frames'], prompt?: (p: string) => string): Shot => {
  const s = SCENE_V11_SHOTS.find((x) => x.id === base)!;
  return { ...s, id: base.replace(/-9x16$/, '-16x9'), ratio: '16:9', frames, use: `${s.use} (16:9 for landscape screens)`, ...(prompt ? { prompt: prompt(s.prompt) } : {}) };
};
const w = (clip: string) => clip.replace(/-9x16$/, '-16x9');

/**
 * うんぱい running back, 16:9: its two stills do not share a camera (the alley is frame 2.5 s of her 16:9 night
 * loop; her still is a closer, lower view with the vending machines larger on the right), so a locked-off camera
 * made Seedance join them with a hard cut at 3.3–3.9 s in both drafts (media:check, 2026-09-29). Here the camera
 * glides forward up the alley instead, one take from the first framing to the last. The action is the 9:16 one.
 */
export const RUN_16X9_CAMERA = 'One continuous take with no cut: the camera glides slowly and smoothly forward up the alley, turning very slightly to the right and lowering a little, so the view changes gradually from the first frame\'s framing to the last frame\'s, and it arrives exactly on the last frame as she stops. The alley and its light stay the same.';
const runCamera = (p: string) => p
  .replace('Start exactly from the first frame and end exactly on the last frame; the camera never moves.', 'Start exactly from the first frame and end exactly on the last frame.')
  .replace(HOLD, RUN_16X9_CAMERA);

export const SCENE_V11_WIDE_SHOTS: Shot[] = [
  wide(cup, { first: v1w('mahiro'), last: 'mahiro-v11-cup-16x9' }),
  wide(unpaiLeave, { first: v1w('unpai'), end: 'empty' }),
  wide(run, { first: { still: 'unpai-v11-alley-16x9' }, last: 'unpai-v11-run-16x9' }, runCamera),
  wide(id('alice', 'night-greenhouse', 'flowers'), { first: v1w('alice'), last: 'alice-v11-flowers-16x9' }),
  wide(leave, { first: v1w('eimi'), end: 'empty' }),
  wide(gone, { first: { after: w(leave) }, last: { after: w(leave) } }),
  wide(back, { first: { after: w(gone) }, last: 'eimi-v11-gown-16x9' })
];
