/**
 * Variant-card clips (#81, v1.1): each talent's variant card (VARIANT_CARDS in packages/shared/src/rules.ts —
 * provisionally her only UR, s1-<star>-30, until the owner picks, #84) is "another her": the same woman in the
 * outfit of that card. Per talent (the site picks by orientation, `mediaFor`, and falls back to the other ratio):
 *
 *   <star>-variant-enter-9x16   she walks into her room in the card's outfit: her empty night room → the home still
 *   <star>-variant-close-9x16   close shot, she talks to you softly (locked loop on the close still)
 *   <star>-variant-home-9x16    the level-10 home idle video (locked loop on the home still, which the entrance ends on)
 *   <star>-variant-home-16x9    the same idle for landscape screens, where the member home would otherwise crop the
 *                               9:16 loop to her chest: locked loop on a 16:9 home still in her 16:9 night room
 *
 * Ids follow `variantDef()` in packages/shared/src/catalog.ts (enterClip / closeClip / homeVideo + the ratio).
 *
 * Look: face and hair are her owner-approved v1 hero (the loop on the home page since #46), not the v2 or card
 * face; the outfit and prop are copied from the published card image. Stills are made by variant-keyframes.ts
 * (gpt-image-2 with a face close-up cut from her v1 hero frame, the card's outfit with the head blanked out, and
 * the empty room as the base picture) and judged by continuity.ts against the five v1 hero frames.
 *
 * The 16:9 home still is built the same way on frame 0 of her published night-16x9 loop, with her v1 hero 16:9 face
 * and the picked 9:16 home still as a fourth reference, so both ratios show the same outfit and prop.
 *
 * The entrance starts on frame 0 of the published night loop, so it can follow the room the site already shows.
 * gpt-image does not keep that camera exactly once she stands close to it, so the entrance is one continuous
 * walk-in with a slow push-in that lands on the home still (a locked-off camera between two stills that differ
 * is what made Seedance hard-cut in the #79 pilot).
 *
 * Loops are locked to one still at both ends, so they are published without a crossfade (xfade 0, like the HD hero
 * loops) and every clip is encoded 'hq' like the other clips that join the home page (#24 phase 4).
 *
 * Only `import type` from the manifest: manifest.ts spreads these lists, so a runtime import would be a cycle.
 */
import type { MotionKeyframe, Shot, Star } from '../manifest';

export interface VariantLook {
  star: Star;
  card: string;
  /** Her v1 hero hair, described from the published frame (the card's hair is a different, older look). */
  hair: string;
  /** Anything else of the v1 face that must stay (nana's glasses). */
  face?: string;
  /** The card's outfit in plain words: fully clothed, shoulders covered. */
  outfit: string;
  /** The card's prop and how she holds it in the home still; she carries it in the entrance. */
  prop: string;
  /** How she walks in with it (entrance, 2–6 s). */
  carry: string;
  /** Her night room (the published `<star>-night-9x16` loop), for the clip prompts. */
  room: string;
  /**
   * What the home still must keep of that room. Where the first home still changed the room (nana: lit and beige
   * instead of dim and purple; eimi: another suite and skyline), the entrance draft visibly morphed the room while
   * she walked in (#81 drafts, round 1).
   */
  roomNote?: string;
  /**
   * How the room gets from the empty frame to the home still's framing during the push-in. Where the two stills
   * disagree about what is near the camera, the 1080p entrance either hard-cut (alice: the foreground roses gave
   * way to a rose pillar with a pot at 4.6 s) or walked her through the furniture (eimi's chaise and glass).
   */
  enterNote?: string;
}

export const VARIANT_LOOKS: VariantLook[] = [
  {
    star: 'mahiro', card: 's1-mahiro-30',
    hair: 'dark brown, almost black, straight bob just above the shoulders with a centre parting and thin see-through bangs',
    outfit: 'an oversized cream cable-knit cardigan with long sleeves, worn open over a plain white cotton dress with a modest round neckline',
    prop: 'She holds two handmade ceramic mugs at chest height, a navy one in her right hand and a blush-pink one in her left, as in the outfit reference.',
    carry: 'she carries the two mugs, the navy one and the blush-pink one, steadily at chest height',
    room: 'her high-rise apartment by the balcony door at night, sheer curtains and the city lights beyond'
  },
  {
    star: 'nana', card: 's1-nana-30',
    hair: 'very dark brown, almost black, long straight hair falling past her shoulders, with full straight bangs',
    face: 'She wears the same thin gold-rimmed oval glasses as in reference images 1 and 2.',
    outfit: 'a soft lavender knit top with long sleeves and matching lavender wide-leg knit trousers',
    prop: 'She holds a hardcover novel with a pressed rose on its cover against her chest with both hands, as in the outfit reference.',
    carry: 'she holds the hardcover novel against her chest with both hands',
    room: 'her cosy living room at night: the sofa with a knit blanket, the glowing floor lamp and rain on the big window',
    roomNote: 'Keep the room as dim and as purple-navy as in reference image 3: the same dark purple armchair with the knit blanket and the open book on it, the pink floor lamp in the same place, the rainy window behind; do not brighten the room or change the colour of the furniture.'
  },
  {
    star: 'unpai', card: 's1-unpai-30',
    hair: 'medium chestnut brown, long straight hair past her shoulders with soft face-framing layers and wispy bangs',
    outfit: 'an oversized navy varsity jacket with rose-pink sleeves and white-trimmed ribbed cuffs, over a plain white crew-neck T-shirt',
    prop: 'Pearl-white retro over-ear headphones rest around her neck, as in the outfit reference; her hands are relaxed at her sides.',
    carry: 'the pearl-white headphones rest around her neck; her arms swing naturally',
    room: 'her narrow Tokyo side street at night: pink and blue neon, a glowing vending machine, wet asphalt'
  },
  {
    star: 'alice', card: 's1-alice-30',
    hair: 'dark chocolate brown, shoulder-length layered bob with soft wispy bangs',
    outfit: 'an opaque, fully lined white lace blouse with a high neck and long sleeves, a thin navy ribbon tied in a bow at the collar, and a long navy pleated skirt',
    prop: 'She holds an open antique silver music box with a tiny dancer in both hands at chest height, as in the outfit reference.',
    carry: 'she holds the open silver music box carefully in both hands at chest height',
    room: 'her glass conservatory at night: white roses, strings of fairy lights, rain on the glass',
    enterNote: 'As the camera pushes in, the big white roses at the left edge slide out of frame to the left and the rose-covered pillar with the flower pot comes into view, as in the last frame.'
  },
  {
    star: 'eimi', card: 's1-eimi-30',
    hair: 'light chestnut brown bob between chin and shoulder length, with see-through bangs',
    outfit: 'an elegant floor-length rose satin evening gown with long fitted sleeves and a high modest neckline, with a navy silk wrap draped over both shoulders',
    prop: 'The glass of rosé stays where it stands in the room (on the velvet chaise); her hands rest relaxed and loosely together in front of her.',
    carry: 'her arms move naturally and the glass of rosé stays where it is on the chaise',
    room: 'her hotel suite at night: the purple velvet chaise with a glass of rosé on it, the floor-to-ceiling window and the city lights',
    roomNote: 'Keep the room exactly as in reference image 3: the purple velvet chaise in the lower left with the glass of rosé on it, the same floor-to-ceiling window and the same city skyline behind her, the same deep navy night; she stands just behind and to the right of the chaise.',
    enterNote: 'She passes behind and to the right of the chaise, never through it; the push-in slides the solid chaise and glass toward the lower left corner, as in the last frame.'
  }
];

/** Her empty night room (people-free, sent inline), her home still and her close still; room16/home16 for landscape. */
export const variantStill = {
  room: (star: Star) => `${star}-variant-room-9x16`,
  home: (star: Star) => `${star}-variant-9x16`,
  close: (star: Star) => `${star}-variant-close-still-9x16`,
  room16: (star: Star) => `${star}-variant-room-16x9`,
  home16: (star: Star) => `${star}-variant-16x9`
};

/**
 * Registered with media:talent (`keyframes <star> --motion …`): the stills of her become keyframe assets named
 * after the still. Made by variant-keyframes.ts, not by media:keyframes (whose motion prompt uses the 4K refs and
 * the v2 hair); `from` and `brief` document what each is built on.
 */
export const VARIANT_KEYFRAMES: MotionKeyframe[] = VARIANT_LOOKS.flatMap((v): MotionKeyframe[] => [
  { name: variantStill.room(v.star), star: v.star, ratio: '9:16', person: false, from: `${v.star}-night-9x16`, brief: 'Frame 0 of her published night-9x16 loop (extracted, not generated).' },
  { name: variantStill.home(v.star), star: v.star, ratio: '9:16', person: true, from: variantStill.room(v.star), wearing: v.outfit, brief: 'She stands in her empty night room, waist up, facing the lens, in the outfit of her variant card, holding its prop.' },
  { name: variantStill.close(v.star), star: v.star, ratio: '9:16', person: true, from: variantStill.home(v.star), wearing: v.outfit, brief: 'The home still photographed closer: chest up, no hands, no prop.' },
  { name: variantStill.room16(v.star), star: v.star, ratio: '16:9', person: false, from: `${v.star}-night-16x9`, brief: 'Frame 0 of her published night-16x9 loop (extracted, not generated).' },
  { name: variantStill.home16(v.star), star: v.star, ratio: '16:9', person: true, from: variantStill.room16(v.star), wearing: v.outfit, brief: 'The home still for landscape: she stands in her empty 16:9 night room, waist up, centred, facing the lens, in the outfit of her variant card, holding its prop.' }
]);

const LOOK = 'Photorealistic live-action footage with exactly the look, light and colour grade of the first and last frames, Japanese photobook style.';
const HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. The room, light, clothing and accessories stay the same.';
const NEGATIVE = 'Exactly one adult woman, fully clothed throughout, the same face, hair, clothing and accessories as in the frames. Her eyes stay open except for quick natural blinks: no slow blinks, no eyes held closed, no squinting. Natural hands with five fingers each. No subtitles, no text, no logo, no watermark, no music, no audio.';

function variantShots(v: VariantLook): Shot[] {
  const base = { category: 'character' as const, star: v.star, talent: v.star, model: 'sd25' as const, ratio: '9:16' as const, resolution: '1080p' as const, encode: 'hq' as const };
  const home = variantStill.home(v.star), close = variantStill.close(v.star), home16 = variantStill.home16(v.star);
  const idle = [
    'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.',
    LOOK,
    `{WOMAN}, wearing ${v.outfit}, is in ${v.room}. First-person view: she is looking at you.`,
    '0-8s: she keeps steady eye contact with the lens the whole time, eyes open and bright, with the same soft closed-mouth smile as in the first frame; she breathes softly and holds what is in her hands still.',
    'Around 2s she blinks once, as fast as a real blink (a quarter of a second); her eyes never stay closed and never squint.',
    '3-6s: a very slight head tilt and back; a few strands of hair drift in a light breeze.',
    '6-8s: back to exactly the first frame\'s pose, expression and framing; she holds still.',
    'Locked-off shot: no camera movement, no zoom, no cut. Framing, clothing, accessories and background stay the same; only breath, eyes, a slight head tilt, hair strands and ambient light move.',
    `${NEGATIVE} She does not speak.`
  ].join('\n');
  return [
    {
      ...base, id: `${v.star}-variant-enter-9x16`, duration: 8, loop: false,
      use: `Variant card ${v.card} (#76 layer 1): she walks into her night room in the card's outfit and stops close to you; ends on the home idle's first frame`,
      frames: { first: { still: variantStill.room(v.star) }, last: home },
      prompt: [
        'The first frame is the empty room; the last frame shows the woman standing close to the camera in the same room. Start exactly from the first frame and end exactly on the last frame.',
        LOOK,
        `{WOMAN}, wearing ${v.outfit}, comes into ${v.room}.`,
        '0-1s: the empty room exactly as in the first frame.',
        '1-2s: she walks into the frame from the right edge.',
        `2-6s: she walks toward the camera with calm, unhurried steps, her eyes on the lens; ${v.carry}. The camera slowly and smoothly pushes in toward her in one continuous move.`,
        ...(v.enterNote ? [v.enterNote] : []),
        '6-8s: she stops close to the camera and settles exactly into the last frame\'s pose, framing and soft closed-mouth smile; the camera comes to rest exactly on the last frame and she holds still.',
        'One continuous shot: no cut, no jump, no change of room or light; only the slow push-in and her walk.',
        `${NEGATIVE} She does not speak.`
      ].join('\n')
    },
    {
      ...base, id: `${v.star}-variant-close-9x16`, duration: 6, loop: true, xfade: 0,
      use: `Variant card ${v.card} (#76): close shot in the card's outfit, she talks to you softly while her voice plays; loops`,
      frames: { first: close, last: close },
      prompt: [
        'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.',
        LOOK,
        `{WOMAN}, wearing ${v.outfit}, is in ${v.room}, framed close from the chest up, talking to you.`,
        '0-1s: she holds the first frame\'s pose, looking into the lens with lips closed.',
        '1-5s: she talks to you quietly, as in a calm conversation: her lips part and move gently and naturally with small, soft mouth movements, her head moving very slightly with her words; her eyes stay open and on the lens, with one quick natural blink.',
        '5-6s: her lips close and she settles back into exactly the first frame\'s pose, expression and framing, and holds still.',
        HOLD,
        NEGATIVE
      ].join('\n')
    },
    {
      ...base, id: `${v.star}-variant-home-9x16`, duration: 8, loop: true, xfade: 0,
      use: `Variant card ${v.card} (#76 level 10): her home idle video in the card's outfit, in her night room; loops`,
      frames: { first: home, last: home },
      prompt: idle
    },
    {
      ...base, id: `${v.star}-variant-home-16x9`, ratio: '16:9', duration: 8, loop: true, xfade: 0,
      use: `Variant card ${v.card} (#76 level 10): her home idle video for landscape screens, in the card's outfit; loops`,
      frames: { first: home16, last: home16 },
      prompt: idle
    }
  ];
}

export const VARIANT_SHOTS: Shot[] = VARIANT_LOOKS.flatMap(variantShots);
