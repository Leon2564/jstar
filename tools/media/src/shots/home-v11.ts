/**
 * Her everyday clips for v1.1 (#80 full scope, owner 2026-09-28), next to the scene clips in ./scenes-v11.ts:
 *
 * - `<star>-hero-morning-<r>`: her in her morning room — what the wake-up moment cuts to after the empty room
 *   (scene/wake.tsx, #57) and what the companion home plays before 11:00. まひろ's is the storyboard's wake-up at
 *   your pillow (her #66 promise), 奈々's the tea and fresh flowers (her #67 promise). These ids were once v2-look
 *   renders (never published since the v1 look came back, #46); they are v1-anchored now.
 * - `<star>-idle-<r>` / `<star>-talk-<r>`: the storyboard's two seated base loops (坐着待机 / 坐着说话), locked on
 *   her v1 hero frame — the frame her hero loop, the scenes' wide shot, starts on — so the scene player can cut
 *   between hero, idle and talk without a jump: talk while her line plays, idle while she listens.
 * - `<star>-talkclose-9x16`: the same talking loop in her close shot (`<star>-breath`, where the system scenes'
 *   lines and whispers play), locked on the keyframe her breathing loop opens on (asset `<star>-breath-9x16`).
 *
 * Sets first (owner): the morning room is built as its own people-free gpt-image-2 still from her published
 * morning room (`<star>-morning-9x16`, the empty shot the wake-up opens on), then she is placed in it — her look
 * from her v1 frame, the camera from the set. Her lips move only in the talk loops (no sound; generic mouth).
 */
import type { Shot, Star } from '../manifest';
import { v1, v1w, type SceneKeyframe } from './scenes-v11';

const STARS: Star[] = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
/** Morning light for her stills: soft, bright and airy (the agency's photobook look), still her colours. */
const MORNING_LIGHT = 'soft, bright, airy morning daylight from the window, gentle and diffused like a Japanese photobook shoot, pastel whites and blush pinks, with a soft fill light on her face';

interface Morning {
  /** The set: her morning room widened so she fits in it (people-free), from her published morning room. */
  room: string;
  /** Her in it (9:16; the 16:9 still says the same in a horizontal frame). */
  her: string;
  /** What she does in the 8 s loop (between holding the first frame and coming back to it). */
  action: string[];
  /** The 16:9 loop's action, where it must differ from the 9:16 one. */
  wideAction?: string[];
  /** Shot.retimeMax: she looks down at what her hands are doing, a glance media:process must not speed up as a blink. */
  retimeMax?: number;
  /** One line: where she is, for the clip prompt. */
  place: string;
}

const MORNING: Record<Star, Morning> = {
  mahiro: {
    room: 'Her bedroom in the morning, seen from pillow height on the bed, as if you are lying in it: rumpled white washed-linen sheets and a white pillow soft in the foreground, the edge of the bed, a window with a sheer white curtain glowing with pale morning sun, a light-oak bedside table with a small ceramic mug. Real materials, real scale. There is room on the edge of the bed in the middle of the frame for a person to sit.',
    her: 'She sits on the edge of the bed and leans over you (you are lying with your head on the pillow, the camera looking up at her): framed from the chest up, her face large and clear in the upper half of the frame, turned to the lens. Her hands are out of the frame.',
    action: [
      '1-3s: she leans a little closer to the lens and tilts her head, as if checking whether you are awake, her eyes open and on the lens.',
      '3-6s: she comes back up a little, the sheer curtain stirring behind her and sunlight flickering softly across the sheets.'
    ],
    place: 'sits on the edge of your bed in the morning and leans over you: you are lying with your head on the pillow.'
  },
  nana: {
    room: 'Her kitchen in the morning, seen a little wider than reference image 1: the same copper gooseneck kettle with a thin wisp of steam and the same glass vase of pink roses on the wooden counter, a white teacup on a saucer and a small jar of baby\'s breath beside them, a bright window with a sheer curtain behind. Real materials, real scale. There is room behind the counter in the middle of the frame for a person to stand.',
    her: 'She stands behind the wooden counter, framed from the waist up, her face in the upper third of the frame, turned to the lens; the copper kettle and the vase of roses and baby\'s breath are on the counter in front of her, and she holds the white teacup on its saucer in both hands at chest height. Her glasses stay on.',
    action: [
      '1-3.5s: she sets the cup down on the counter and, keeping her eyes open, tucks a small sprig of baby\'s breath in among the roses in the vase with one hand, then her eyes come back to the lens.',
      '3.5-6s: she picks the cup up again and holds it out a little toward the lens, a thin wisp of steam rising from it.'
    ],
    place: 'stands at the counter in her kitchen in the morning: the copper kettle, a vase of roses, a bright window.',
    // Setting the cup down and tucking in the flower, she looks down for 0.5–0.8 s in every take (2026-09-29); sped
    // up 3× as a "blink" that glance jumped (frame step 6.4 against 4.3 anywhere else). Real blinks stay under 0.45 s.
    retimeMax: 0.45
  },
  unpai: {
    room: 'Her bedroom in the morning, seen a little wider than reference image 1: the same window with the fairy lights and the string of polaroid photos, the plush bears and bunnies on the window seat, the edge of her bed with a soft pastel duvet, morning light through the curtain. Real materials, real scale. There is room on the edge of the bed by the window for a person to sit.',
    her: 'She sits on the edge of her bed by the window, framed from the waist up, her face in the upper third of the frame, turned to the lens, a small plush bear held loosely in her lap with both hands.',
    action: [
      '1-3.5s: she hugs the plush bear a little closer and sways from side to side, her eyes bright and open on the lens.',
      '3.5-6s: she tilts her head with a bright closed-mouth smile and settles the bear back in her lap.'
    ],
    place: 'sits on the edge of her bed by the window in the morning: fairy lights, polaroid photos, plush toys.'
  },
  alice: {
    room: 'Her room in the morning, seen a little wider than reference image 1: the same lace-curtained window, the windowsill with the porcelain teacup on its saucer and the antique silver music box, a small upholstered chair by the window, soft pink dawn light through the lace. Real materials, real scale. There is room by the window for a person to sit.',
    her: 'She sits by the lace-curtained window, framed from the waist up, her face in the upper third of the frame, turned to the lens; the porcelain teacup and the silver music box are on the sill beside her.',
    action: [
      // Asked to hold the cup near her chin, both drafts (2026-09-29) sipped with her eyes closed for ~0.6 s: she no longer drinks.
      '1-3.5s: she lifts the teacup from its saucer with one hand and holds it in front of her chest, offering it a little toward the lens without drinking, her eyes open and bright on the lens the whole time.',
      '3.5-6s: she sets the cup back on its saucer on the sill without looking away from the lens.'
    ],
    place: 'sits by her lace-curtained window in the morning: a porcelain teacup and a silver music box on the sill.'
  },
  eimi: {
    room: 'Her dressing room in the morning, seen a little wider than reference image 1: the same pale marble vanity with the mirrored tray of crystal perfume bottles, a large mirror, a tall window with sheer curtains and soft morning light, a velvet stool in front of the vanity. Real materials, real scale. There is room at the vanity for a person to sit.',
    her: 'She sits on the velvet stool at the marble vanity, turned toward the lens, framed from the waist up, her face in the upper third of the frame; the tray of perfume bottles is on the vanity beside her.',
    action: [
      '1-3.5s: she picks up a crystal perfume bottle from the tray and turns it slowly in her fingers, the light glinting through it, her eyes on the lens with a confident closed-mouth smile.',
      '3.5-6s: she sets the bottle back on the tray.'
    ],
    // In 16:9 the smile cue played as a ~1 s eyes-closed smile in three takes (media:check, 2026-09-29): no smile cue there.
    wideAction: [
      '1-3.5s: she picks up a crystal perfume bottle from the tray and turns it slowly in her fingers, the light glinting through it, her eyes open, bright and on the lens the whole time.',
      '3.5-6s: she sets the bottle back on the tray, her eyes still on the lens.'
    ],
    place: 'sits at her marble vanity in the morning: crystal perfume bottles on a mirrored tray, a tall bright window.'
  }
};

const morningRoom = (star: Star, r: '9x16' | '16x9') => `${star}-v11-morningroom-${r}`;
const morningHer = (star: Star, r: '9x16' | '16x9') => `${star}-v11-morning-${r}`;

export const HOME_V11_KEYFRAMES: SceneKeyframe[] = STARS.flatMap((star): SceneKeyframe[] => {
  const m = MORNING[star];
  return [
    { name: morningRoom(star, '9x16'), star, ratio: '9:16', person: false, from: `${star}-morning-9x16-poster`, brief: m.room },
    { name: morningRoom(star, '16x9'), star, ratio: '16:9', person: false, from: morningRoom(star, '9x16'), brief: `The same room as reference image 1, the same furniture, objects, materials and light, seen by a camera a little further back in a horizontal 16:9 frame, so more of the room shows on both sides. ${m.room.replace(/seen [^:]*:/, 'with')}` },
    { name: morningHer(star, '9x16'), star, ratio: '9:16', person: true, from: v1(star), camera: morningRoom(star, '9x16'), setting: MORNING_LIGHT, brief: `Morning, in the room of reference image 3. ${m.her}` },
    { name: morningHer(star, '16x9'), star, ratio: '16:9', person: true, from: v1w(star), camera: morningRoom(star, '16x9'), setting: MORNING_LIGHT, brief: `Morning, in the room of reference image 3, a horizontal frame with her in the right half. ${m.her}` }
  ];
});

// Prompt parts (the same wording as ./scenes-v11.ts and manifest.ts's presence clips).
const LOOP = 'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.';
const LOOK = 'Photorealistic live-action footage with exactly the look, light and colour grade of the first frame, Japanese photobook style.';
const HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. The place and light stay the same; only she moves, gently.';
const NEGATIVE = 'Exactly one adult woman, fully clothed throughout; the same face, hair, outfit and accessories as in the frames. Her eyes stay open except for quick natural blinks: no slow blinks, no eyes held closed, no squinting. Natural hands with five fingers each. She does not speak. No subtitles, no text, no logo, no watermark, no music, no audio.';
const SILENT_LIPS = NEGATIVE.replace('She does not speak.', 'Her lips move as she talks, but there is no sound.');
/** Generic mouth for any line: real speech rhythm (phrases and pauses), no exaggerated shapes, never singing. */
const TALKING = [
  '0-7.5s: she talks to you in a calm, warm, natural way, as in a real conversation: her lips move clearly and naturally with the rhythm of ordinary speech, in short phrases with small pauses where her mouth closes; small natural nods and eyebrow movements as she speaks; her eyes stay open and on the lens.',
  'Around 2.5s and around 5.5s she blinks once, as fast as a real blink.',
  '7.5-8s: she finishes the phrase, closes her mouth into the first frame\'s soft closed-mouth smile and settles exactly into the first frame\'s pose.'
];
const LISTENING = [
  // Draft 1 had two small nods: each lowered her eyelids for ~0.8 s (measured as slow blinks). Her chin stays level now.
  '0-7s: she listens to you attentively, her eyes open and bright on the lens, with the same soft closed-mouth smile as in the first frame; she breathes naturally, her chin level, with a very slight sideways tilt of her head around 3-5s and tiny natural micro-expressions around her eyes and lips, as if taking in what you say.',
  'Around 2s and around 6s she blinks once, as fast as a real blink.',
  '7-8s: back to exactly the first frame\'s pose and expression; she holds still.'
];

const base = (star: Star, id: string, ratio: '9:16' | '16:9', use: string, anchor: string, lines: string[]): Shot => ({
  id, category: 'character', star, talent: star, model: 'sd25', ratio, resolution: '1080p', duration: 8, loop: true, xfade: 0, encode: 'hq',
  use, frames: { first: anchor, last: anchor }, prompt: lines.join('\n')
});

const RATIOS = [['9:16', '9x16'], ['16:9', '16x9']] as const;

export const HOME_V11_SHOTS: Shot[] = STARS.flatMap((star): Shot[] => {
  const m = MORNING[star];
  const scene = '{WOMAN} is in the same place as in the frame, in the same clothes and pose. First-person view: she is with you.';
  return [
    ...RATIOS.map(([ratio, r]) => base(star, `${star}-hero-morning-${r}`, ratio,
      `Her morning (#57 wake-up after the empty room; the home before 11:00)${star === 'mahiro' ? ': she wakes you at your pillow (#66 promise)' : star === 'nana' ? ': tea and fresh flowers (#67 promise)' : ''}; loops`,
      morningHer(star, r), [
        LOOP, LOOK, `{WOMAN} ${m.place}`,
        '0-1s: she holds the first frame\'s pose, looking into the lens with a soft closed-mouth smile.',
        ...(r === '16x9' && m.wideAction ? m.wideAction : m.action),
        'Around 2s and around 5.5s she blinks once, as fast as a real blink.',
        '6-8s: she settles back into exactly the first frame\'s pose, expression and framing, and holds still.',
        HOLD, NEGATIVE])).map((s) => (m.retimeMax ? { ...s, retimeMax: m.retimeMax } : s)),
    ...RATIOS.map(([ratio, r]) => base(star, `${star}-idle-${r}`, ratio,
      'Seated base loop, listening (坐着待机): her v1 hero frame, locked camera; the scene player shows it on her wide shot while he talks',
      ratio === '9:16' ? v1(star) : v1w(star), [LOOP, LOOK, scene, ...LISTENING, HOLD, NEGATIVE])),
    ...RATIOS.map(([ratio, r]) => base(star, `${star}-talk-${r}`, ratio,
      'Seated base loop, talking (坐着说话, generic mouth): her v1 hero frame, locked camera; the scene player shows it on her wide shot while her line plays',
      ratio === '9:16' ? v1(star) : v1w(star), [LOOP, LOOK, scene, ...TALKING, HOLD, SILENT_LIPS])),
    base(star, `${star}-talkclose-9x16`, '9:16',
      'Close talking loop (generic mouth): the keyframe her breathing close-up opens on; the scene player shows it on her close shot while her line plays',
      `${star}-breath-9x16`, [LOOP, LOOK, scene, ...TALKING, HOLD, SILENT_LIPS])
  ];
});
