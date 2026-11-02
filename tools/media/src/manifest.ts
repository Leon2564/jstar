/**
 * World bible and shot list for the First Five (docs/asset-bible.md explains the choices).
 *
 * Rules that come from docs/JSTAR-关键产品决策.md:
 * - Content ceiling is 写真级 "sensual, not explicit"; nothing here goes past it.
 * - The talents themselves are only generated from their verified Seedance real-human assets
 *   (assets/talents.json, see src/talents.ts). A text prompt cannot reproduce a real person — it would
 *   invent a face and attach her name to it — so character shots are skipped until assets exist.
 * - Palette: navy #24284D base, rose #D38A97 warm light; first-person, looking into the lens.
 */
import { SYSTEM_V11_KEYFRAMES, SYSTEM_V11_SHOTS } from './shots/system-v11';
import type { Ratio, Resolution } from './ark';
import { VIDEO_ENDPOINT_ENV, type VideoTier } from './models';
import { VARIANT_KEYFRAMES, VARIANT_SHOTS } from './shots/variants-v11';
import { HOME_V11_KEYFRAMES, HOME_V11_SHOTS } from './shots/home-v11';
import { SCENE_V11_KEYFRAMES, SCENE_V11_SHOTS, SCENE_V11_WIDE_SHOTS } from './shots/scenes-v11';

export const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
export type Star = (typeof STARS)[number];
export type Category = 'scene' | 'costume' | 'prop' | 'ambient' | 'character';
export type ModelKey = VideoTier;

export interface Shot {
  id: string;
  category: Category;
  star?: Star;
  /** Where the asset appears in the product. */
  use: string;
  model: ModelKey;
  ratio: Ratio;
  resolution: Resolution;
  duration: number;
  prompt: string;
  /** Post-process into a seamless loop (crossfade the tail into the head). */
  loop: boolean;
  /** Extract this many evenly spaced stills as a multi-view sheet (turntables). */
  multiview?: number;
  /** Character shots: whose real-human assets to reference. The prompt's {WOMAN} names them as "Image N". */
  talent?: Star;
  /**
   * Loop anchored at both ends (Seedance first_frame + last_frame, no crossfade needed). Character shots use
   * their approved keyframe asset; scenes use their own published poster (no people, so a data: URL is accepted).
   */
  lock?: boolean;
  /** Seconds of tail crossfaded into the head when post-processing a loop (default: process.XFADE). */
  xfade?: number;
  /**
   * Stills the clip starts and ends on (Seedance first_frame / last_frame). Chaining (#79): `{ after: id }` is
   * the frame shot `id` ends on, so the next clip opens on exactly the still the previous one closed on and a
   * scene can cut between them without a jump. A loop with frames must start and end on the same still.
   * `end: 'empty'` (no `last`): she leaves and the clip ends on whatever empty frame Seedance renders; clips
   * chained after it start on that rendered frame (people-free, so it is sent inline).
   */
  frames?: { first: FrameRef; last?: FrameRef; end?: 'empty' };
  /**
   * 'hq': high-bitrate web encode (AV1 CRF 23, H.264 CRF 19/20, q 90 posters) written to NEW `-hq` file names
   * beside any earlier encode, so re-encoding never overwrites a published file (#24 phase 4).
   */
  encode?: 'hq';
  /**
   * Longest eyes-down run (s) media:process still speeds up as a slow blink (default: process.RETIME_MAX_S). For
   * clips where she looks down at something in her hands: a real glance of ~0.7 s sped up 3× reads as a jump.
   */
  retimeMax?: number;
}

/**
 * - a string: a keyframe asset in the talent's group (media:talent keyframes registers it with `shot` = this name);
 * - `{ still }`: a people-free keyframe (e.g. her empty room), picked in out/keyframes/v2/<still>.json and sent
 *   inline — no real person in it, so it needs no asset;
 * - `{ after }`: chained, the frame shot `after` ends on: its `last` still, or — for a clip that ends empty — the
 *   last frame it actually rendered.
 */
export type FrameRef = string | { still: string } | { after: string };
/** A resolved frame: a talent keyframe asset, a people-free still, or the rendered last frame of a clip that ends empty. */
export type Anchor = { keyframe: string } | { still: string } | { rendered: string };

export const STYLE = 'Photorealistic cinematic photography, deep navy blue shadows with warm rose-pink light accents, subtle star-like bokeh, fine film grain, natural textures, elegant and quiet mood. No text, no logos, no watermark.';
const NO_PEOPLE = 'The space is empty, no people, no hands, no silhouettes.';
// No equipment words at all (not even negated): the model draws them into the room (nana-day showed a camera on legs).
const STILL_CAMERA = 'Static locked-off shot, absolutely no camera movement or zoom; only gentle ambient motion.';
const TURNTABLE = 'The camera orbits smoothly and evenly 360 degrees around the subject at eye level; the subject stays centred on a low navy velvet plinth in a seamless dark navy studio with a soft rose-pink rim light.';

export interface Talent {
  star: Star;
  /** Persona in one line (from apps/agent/app/personas/<star>.yaml). */
  mood: string;
  /** Where "she" is when you open the app — the signature location. */
  place: { night: string; morning: string; day: string };
  /** On the dress form (costume turntable). */
  costume: string;
  /** Worn by her in keyframes and character videos: plain wording, fully clothed, nothing an image filter misreads. */
  wearing: string;
  prop: string;
  /** Her real hair (colour and cut) from the agency's 4K footage; drift here was a review finding (alice, unpai). */
  hair: string;
  /** The same small accessories in every ratio and time of day, so the four clips read as one person on one day. */
  accessories: string;
  /** Permanent features the generators drifted on (docs/asset-bible.md §5, likeness review 2026-09-25). */
  features: string;
  /** Her expression in keyframes and the first/last frame of every character clip. */
  expression: string;
}

/** Clothed-companion tone (2026-09-25): daily, date, home or formal wear; shoulders covered; nothing school-like. */
export const WARDROBE_RULE = 'fully clothed in everyday clothes, shoulders and neckline covered, modest and elegant';

export const TALENTS: Talent[] = [
  {
    star: 'mahiro', mood: 'calm, gently teasing, notices when you are tired',
    place: {
      night: 'a high-rise apartment balcony at blue hour in Tokyo, sheer white curtains breathing in the breeze at the open glass door, a small table with two ceramic mugs, the city lights below softly out of focus',
      morning: 'a bedroom with white linen sheets and a sheer curtain, pale morning sun sliding across the pillow, dust motes floating in the light',
      day: 'a quiet café window seat on a rainy afternoon, a half-finished latte, raindrops running down the glass, blurred umbrellas outside'
    },
    costume: 'an oversized cream cable-knit cardigan with long sleeves over a plain white camisole dress, displayed on a dress form',
    wearing: 'an oversized cream cable-knit cardigan, buttoned, over a simple white cotton dress',
    prop: 'two handmade ceramic mugs, one navy and one blush pink, steam rising from both',
    hair: 'dark chocolate-brown hair in soft loose waves just past the shoulders, with thin, airy wispy bangs',
    accessories: 'small pearl drop earrings; no headband or hair accessories',
    features: 'large round eyes with clear double eyelids and prominent puffy under-eye fullness (aegyo-sal), soft round face with full cheeks, a short softly rounded chin (not long, not pointed), small nose, full soft lips',
    expression: 'a gentle, warm closed-mouth smile that lifts her cheeks and under-eyes'
  },
  {
    star: 'nana', mood: 'a warm listener who wants to hear about your day',
    place: {
      night: 'a cosy living room at night lit by one warm floor lamp, rain streaking the big window, a sofa with a folded knit blanket and an open paperback',
      morning: 'a sunny kitchen counter with a kettle beginning to steam, fresh flowers in a glass jar, soft morning light',
      day: 'a bookshop corner with tall wooden shelves, afternoon light through a skylight, pages of an open book lifting slightly'
    },
    costume: 'a soft lavender lounge set: a loose knit top and matching wide trousers, displayed on a dress form',
    wearing: 'a soft lavender knit top with long sleeves and matching wide trousers',
    prop: 'a hardcover novel with a pressed rose as a bookmark, lying open under a brass reading lamp',
    hair: 'very dark brown, almost black, long straight hair with thin, airy bangs',
    accessories: 'a thin silver necklace; no headband or hair accessories',
    features: 'calm almond-shaped eyes with soft double eyelids, straight slim nose, full lips with a defined cupid\'s bow, soft oval face with a gently rounded jaw and chin (not V-shaped)',
    expression: 'a gentle, warm closed-mouth smile — both corners of her lips curve upward evenly and her eyes smile too (a real smile, not a neutral face and not a smirk)'
  },
  {
    star: 'unpai', mood: 'bright and playful, "you finally came!"',
    place: {
      night: 'a narrow Tokyo side street at night, rose-pink and blue neon signs reflected in wet asphalt, a vending machine glowing, light rain',
      morning: 'a sunny bedroom full of plush toys and polaroid photos on a string of fairy lights, morning light through pastel curtains',
      day: 'the rooftop of a building on a bright day, laundry and a pink scarf swaying gently on a line, blue sky with slow drifting clouds'
    },
    costume: 'an oversized navy varsity jacket with rose-pink sleeves and a pleated mini skirt, displayed on a dress form',
    wearing: 'an oversized navy varsity jacket with rose-pink sleeves over a white T-shirt',
    prop: 'retro over-ear headphones in pearl white, resting on a stack of vinyl records',
    hair: 'warm light orange-brown caramel hair, long and softly wavy, with wispy bangs',
    accessories: 'a small black velvet ribbon clip on one side of her hair',
    features: 'big bright doe eyes with double eyelids and puffy under-eye fullness (aegyo-sal), small nose, full rosy lips, soft oval face',
    expression: 'a lively, bright closed-mouth smile with sparkling eyes, full of energy, as if about to laugh'
  },
  {
    star: 'alice', mood: 'shy and sincere, "…I really mean it"',
    place: {
      night: 'a glass conservatory at night filled with white roses and fairy lights, rain tapping on the glass roof',
      morning: 'a window seat with lace curtains at dawn, a porcelain teacup and a small music box on the sill, pale pink sky',
      day: 'an old music room with a grand piano, sheet music on the stand, afternoon sun through tall windows'
    },
    costume: 'a white lace high-neck blouse with a navy ribbon and a long pleated skirt, displayed on a dress form',
    wearing: 'a white lace high-neck blouse with a small navy ribbon at the collar',
    prop: 'an antique silver music box with a tiny rotating dancer, lid open',
    hair: 'deep burgundy wine-red hair, soft and shoulder length, with thin, airy curtain bangs',
    accessories: 'small gold hoop earrings; no headband or hair accessories',
    features: 'large bright eyes with defined double eyelids, slim straight nose, full glossy lips, heart-shaped face with a small chin',
    expression: 'a shy, sincere closed-mouth smile, her eyes soft and a little bashful'
  },
  {
    star: 'eimi', mood: 'confident and alluring, "look at me"',
    place: {
      night: 'a luxury hotel suite at night, floor-to-ceiling windows over the glittering Tokyo skyline with Tokyo Tower glowing orange in the distance, velvet armchair, a glass of rosé wine catching the light',
      morning: 'a marble dressing-table vanity in soft morning light, a perfume bottle and pearl earrings on a tray, a round mirror catching the sun',
      day: 'a poolside terrace on a bright afternoon, water caustics dancing on white tiles, a sun lounger with a silk scarf'
    },
    costume: 'an elegant floor-length rose satin evening gown with thin straps and a navy silk wrap, displayed on a dress form',
    wearing: 'an elegant rose satin blouse with long sleeves and a high modest neckline, and a navy silk scarf loosely knotted at her neck',
    prop: 'a faceted crystal perfume bottle with a rose-gold cap, light refracting through it',
    hair: 'jet-black hair in a short, glossy chin-length bob with side-swept bangs',
    accessories: 'small pearl stud earrings',
    features: 'a youthful woman in her mid-twenties: bright upturned almond eyes with double eyelids, slim nose, full lips, smooth oval face with softly rounded cheeks',
    expression: 'a confident, playful closed-mouth smile with a warm, direct gaze'
  }
];

/** Scenes whose motion never repeats (cloth in wind, drifting clouds) loop by returning to their own poster. */
const LOCKED_SCENES = new Set(['unpai-day-9x16']);

function sceneShots(t: Talent): Shot[] {
  const base = { category: 'scene' as const, star: t.star, loop: true };
  return ([
    { ...base, id: `${t.star}-night-16x9`, use: 'Home hero (desktop), full-screen background', model: 'sd25', ratio: '16:9', resolution: '1080p', duration: 8, prompt: `${t.place.night}. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}` },
    { ...base, id: `${t.star}-night-9x16`, use: 'Home hero (mobile) and companion home at night', model: 'sd25', ratio: '9:16', resolution: '1080p', duration: 8, prompt: `${t.place.night}. Vertical composition, upright and level: walls vertical, floor at the bottom, sky or ceiling at the top. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}` },
    { ...base, id: `${t.star}-morning-9x16`, use: 'Companion home, morning (before 11:00)', model: 'sd25', ratio: '9:16', resolution: '720p', duration: 8, prompt: `${t.place.morning}. Vertical composition, upright and level: walls vertical, floor at the bottom, sky or ceiling at the top. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}` },
    { ...base, id: `${t.star}-day-9x16`, use: 'Companion home, daytime (11:00–17:00)', model: 'sd25', ratio: '9:16', resolution: '720p', duration: 8, prompt: `${t.place.day}. Vertical composition, upright and level: walls vertical, floor at the bottom, sky or ceiling at the top. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}` }
  ] as Shot[]).map((s) => (LOCKED_SCENES.has(s.id) ? { ...s, lock: true } : s));
}

function assetShots(t: Talent): Shot[] {
  return [
    { id: `${t.star}-costume`, category: 'costume', star: t.star, use: 'Costume sheet: multi-view reference for card art and character shots', model: 'sd2', ratio: '1:1', resolution: '720p', duration: 10, loop: false, multiview: 8, prompt: `${t.costume}. ${TURNTABLE} ${NO_PEOPLE} ${STYLE}` },
    { id: `${t.star}-prop`, category: 'prop', star: t.star, use: 'Prop sheet: multi-view reference, card details and chat stickers', model: 'sd2', ratio: '1:1', resolution: '720p', duration: 10, loop: false, multiview: 8, prompt: `${t.prop}. ${TURNTABLE} ${NO_PEOPLE} ${STYLE}` }
  ];
}

/**
 * Character shots. Identity comes from an approved keyframe (media:keyframes, likeness-scored) that is
 * uploaded to her AIGC asset group; a text description never makes a real person.
 *
 * Loops (`lock`): the keyframe is both the first and the last frame (Seedance first_frame + last_frame), so
 * the clip returns to the exact still it started from and needs no crossfade — the 1 s crossfade of v1 made
 * smiles "melt" and eyes double. Seedance refuses reference images next to a last frame, so these clips carry
 * only the keyframe; eight seconds anchored at both ends keeps her face.
 *
 * Prompts follow the Seedance 2.5 guide's order: look → subject and scene → timeline in whole seconds →
 * what stays fixed → negative controls. Motion is small (breath, one quick blink, a slight head tilt, hair).
 */
const LOOK = 'Photorealistic live-action footage, Japanese photobook style, 85mm lens at f/2, shallow depth of field. Bright soft key light on her face, catchlights in her eyes; lightly retouched, luminous natural skin.';
const HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. Framing, clothing, accessories and background stay the same; only breath, eyes, a slight head tilt, hair strands and ambient light move.';
const NEGATIVE = 'Exactly one adult woman, fully clothed throughout. Her face stays exactly as in the first frame (same eye size, same face shape). Her eyes stay open except for that one fast blink: no slow blinks, no eyes held closed, no squinting. No subtitles, no text, no logo, no watermark, no music, no audio.';

/**
 * 8 s of steady eye contact. No emotional beats ("glad to see you", "her smile warms", "eyes smile"): Seedance
 * plays those as a blissful eyes-closed smile held for 0.5–2 s, which read as the v1 "sleepy blink".
 */
export function companionTimeline(): string {
  return [
    '0-8s: she keeps steady eye contact with the lens the whole time, eyes open and bright, with the same soft closed-mouth smile as in the first frame; she breathes softly.',
    'Around 2s she blinks once, as fast as a real blink (a quarter of a second); her eyes never stay closed and never squint.',
    '3-6s: a very slight head tilt and back; a few strands of hair drift in a light breeze.',
    '6-8s: back to exactly the first frame\'s pose, expression and framing; she holds still.'
  ].join('\n');
}

export type CompanionTime = 'night' | 'morning' | 'day';
/** Keyframe kind (media:keyframes) → the loop it opens and closes. */
export const COMPANION_SHOTS = [
  { kind: 'hero-16x9', time: 'night', ratio: '16:9', use: 'Home hero (desktop): the talent inside her signature night scene' },
  { kind: 'hero-9x16', time: 'night', ratio: '9:16', use: 'Home hero (mobile) and companion home at night' },
  { kind: 'hero-morning-9x16', time: 'morning', ratio: '9:16', use: 'Companion home, morning (before 11:00): she is in her morning scene' },
  { kind: 'hero-day-9x16', time: 'day', ratio: '9:16', use: 'Companion home, daytime (11:00–17:00): she is in her day scene' }
] as const satisfies readonly { kind: string; time: CompanionTime; ratio: '16:9' | '9:16'; use: string }[];
export type CompanionKind = (typeof COMPANION_SHOTS)[number]['kind'];

const MOMENT: Record<CompanionTime, string> = {
  night: 'Night, blue-hour mood behind her, her face softly and brightly lit. First-person view: she is looking at you.',
  morning: 'Morning, soft bright sun. First-person view: she is looking at you.',
  day: 'Bright afternoon, soft daylight. First-person view: she is looking at you.'
};

/**
 * 恋与深空-style "presence" one-shots for the home page (#24 phase 3): pre-rendered camera moves and small
 * reactions, all anchored to the first frame of her owner-approved v1 hero loop (`<star>-hero-<r>-v1`, see
 * keyframes.ts V1_ANCHORS) so the site can cut between them and the hero loop without a jump.
 * Prompts describe no outfit, place or light: the anchor frames carry the v1 look, and text would fight it.
 */
export const PRESENCE = [
  { kind: 'enter', duration: 5, use: 'Home entrance: wide shot of her hero scene, the camera dollies in and ends on the hero keyframe' },
  { kind: 'react-a', duration: 4, use: 'Home reaction A: a shy smile, glancing away and back to the lens; starts and ends on the hero keyframe' },
  { kind: 'react-b', duration: 4, use: 'Home reaction B: a small wave near her cheek, "hi"; starts and ends on the hero keyframe' },
  { kind: 'react-c', duration: 4, use: 'Home reaction C: leans a little toward the camera with a soft laugh; starts and ends on the hero keyframe' }
] as const;
export type PresenceKind = (typeof PRESENCE)[number]['kind'];

/** One-shot rules shared by every presence clip: eyes open, no speech, same person as the hero keyframe. */
const PRESENCE_LOOK = 'Photorealistic live-action footage with exactly the look, light and colour grade of the first and last frames.';
const PRESENCE_NEGATIVE = 'Exactly one adult woman, fully clothed throughout, the same person, outfit, hair and accessories as in the last frame. Her eyes stay open except for quick natural blinks; no eyes held closed, no squinting. Her lips may part slightly but she does not speak: no talking, no lip-sync. Natural hands with five fingers. No subtitles, no text, no logo, no watermark, no music, no audio.';
const REACT_HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. The room, light, clothing and accessories stay the same; only she moves, gently.';

const REACTION: Record<Exclude<PresenceKind, 'enter'>, string[]> = {
  'react-a': [
    '0-1s: she holds the first frame\'s pose, looking into the lens with her soft closed-mouth smile.',
    '1-2.5s: with a shy little smile she turns her eyes and head slightly to the side, looking off to the side at eye level (not down), eyes clearly open the whole time; then her eyes come back to the lens.',
    '2.5-4s: she settles back into exactly the first frame\'s pose, expression and framing, and holds still.'
  ],
  'react-b': [
    '0-1s: she holds the first frame\'s pose, looking into the lens with her soft closed-mouth smile.',
    '1-3s: she lifts one hand up beside her cheek and gives a small, gentle wave, a friendly "hi", eyes on the lens; then her hand lowers out of frame.',
    '3-4s: she settles back into exactly the first frame\'s pose, expression and framing, and holds still.'
  ],
  'react-c': [
    '0-1s: she holds the first frame\'s pose, looking into the lens with her soft closed-mouth smile.',
    '1-3s: she leans a little toward the camera and gives a soft, quiet laugh, her shoulders moving lightly, eyes open and bright on the lens; then she leans back.',
    '3-4s: she settles back into exactly the first frame\'s pose, expression and framing, and holds still.'
  ]
};

/**
 * HD hero loops (#24 phase 4, owner's option A): a fresh 8 s render locked at both ends to the first frame of her
 * approved v1 hero loop (same face, outfit, room, framing), with living light and a slow breathing camera drift,
 * encoded at a much higher bitrate. New ids; the v1 `<star>-hero-*` files stay untouched.
 */
function heroHdShots(t: Talent): Shot[] {
  return (['16:9', '9:16'] as const).map((ratio): Shot => {
    const r = ratio === '16:9' ? '16x9' : '9x16';
    const anchor = `${t.star}-hero-${r}-v1`;
    return {
      category: 'character', star: t.star, talent: t.star, model: 'sd25', resolution: '1080p', ratio, duration: 8,
      id: `${t.star}-herohd-${r}`, use: `Home hero (${ratio === '16:9' ? 'desktop' : 'mobile'}), HD: her approved v1 frame come alive; preferred over ${t.star}-hero-${r}`,
      loop: true, xfade: 0, frames: { first: anchor, last: anchor }, encode: 'hq',
      prompt: [
        'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.',
        PRESENCE_LOOK,
        '{WOMAN} is in the same room as in the frames, in the same clothes. First-person view: she is looking at you.',
        '0-8s: steady eye contact with the lens the whole time, eyes open and bright, with the same soft closed-mouth smile as in the first frame; she breathes naturally, her shoulders rising and falling gently, with tiny natural micro-expressions around her eyes and lips.',
        'Around 3s she blinks once, as fast as a real blink (a quarter of a second).',
        'The camera drifts very slowly and gently closer and a little to the side, like a slow breath, then eases back so that at 8s it is exactly on the first frame\'s framing.',
        'Living light: the city lights and bokeh behind her twinkle softly, the light sources in the room flicker gently, a soft band of light glides slowly across her, and a few strands of her hair and the fabric nearby stir in a light breeze.',
        'Her face, clothing and the room stay exactly the same; no cut, no zoom blur.',
        PRESENCE_NEGATIVE
      ].join('\n')
    };
  });
}

function presenceShots(t: Talent): Shot[] {
  const base = { category: 'character' as const, star: t.star, talent: t.star, model: 'sd25' as const, resolution: '1080p' as const, loop: false, encode: 'hq' as const };
  return (['16:9', '9:16'] as const).flatMap((ratio) => {
    const r = ratio === '16:9' ? '16x9' : '9x16';
    const hero = `${t.star}-hero-${r}-v1`;
    const scene = '{WOMAN} is in the same room as in the frames, in the same clothes. First-person view: she is looking at you.';
    return PRESENCE.map(({ kind, duration, use }): Shot => {
      const id = `${t.star}-${kind}-${r}`;
      if (kind === 'enter') {
        return {
          ...base, id, use, ratio, duration, frames: { first: id, last: hero },
          prompt: [
            'The first frame is a wide shot of the scene; the last frame is the close shot of the same woman in the same place. The camera dollies in smoothly along a straight line from the first frame and ends exactly on the last frame\'s framing, pose and expression.',
            PRESENCE_LOOK,
            scene,
            `0-${duration}s: one smooth, continuous, cinematic push-in with gentle parallax: foreground elements slide past the edges of the frame and the background shifts slightly behind her. She stays in the same pose, looking into the lens with her soft closed-mouth smile, breathing softly.`,
            `${duration}s: the camera comes to rest exactly on the last frame.`,
            'Only the camera moves; no cut, no zoom blur, no change of scene, light or clothing.',
            PRESENCE_NEGATIVE
          ].join('\n')
        };
      }
      return {
        ...base, id, use, ratio, duration, frames: { first: hero, last: hero },
        prompt: [
          'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it.',
          PRESENCE_LOOK,
          scene,
          ...REACTION[kind],
          REACT_HOLD,
          PRESENCE_NEGATIVE
        ].join('\n')
      };
    });
  });
}

function characterShots(t: Talent): Shot[] {
  const base = { category: 'character' as const, star: t.star, talent: t.star, model: 'sd25' as const };
  // `<star>-hero-morning-9x16` is v1-anchored now (shots/home-v11.ts, #80); the v2-look render of this id was never republished.
  const companion = COMPANION_SHOTS.filter(({ kind }) => kind !== 'hero-morning-9x16').map(({ kind, time, ratio, use }): Shot => ({
    ...base, id: `${t.star}-${kind}`, use, ratio, resolution: '1080p', duration: 8, loop: true, lock: true,
    prompt: [
      LOOK,
      `{WOMAN}, wearing ${t.wearing} (${t.accessories}), is in ${t.place[time]}. ${MOMENT[time]}`,
      companionTimeline(),
      HOLD,
      NEGATIVE
    ].join('\n')
  }));
  return [
    ...companion,
    ...presenceShots(t),
    ...heroHdShots(t),
    {
      ...base, id: `${t.star}-turnaround`, use: 'Character sheet: identity-consistent multi-view for all later generations',
      ratio: '9:16', resolution: '1080p', duration: 10, loop: false, multiview: 8,
      prompt: [
        'Photorealistic studio footage, full-frame cinema camera, 50mm lens, soft even key light with a warm rose-pink rim light, seamless dark navy backdrop, natural skin texture.',
        `{WOMAN} stands relaxed in the centre wearing ${t.wearing}, fully clothed, calm friendly expression, full body visible.`,
        '0-10s: the camera orbits smoothly and evenly 360 degrees around her at eye level while she stays still in the same pose, so her front, three-quarter, side and back are all seen.',
        NEGATIVE
      ].join('\n')
    },
    {
      ...base, id: `${t.star}-breath-9x16`, use: 'Talent frame and card detail: head-and-shoulders portrait with micro-motion',
      ratio: '9:16', resolution: '1080p', duration: 8, loop: true,
      prompt: [
        LOOK,
        `{WOMAN}, head-and-shoulders portrait, wearing ${t.wearing}, in ${t.place.night}, softly out of focus behind her.`,
        companionTimeline(),
        HOLD,
        NEGATIVE
      ].join('\n')
    }
  ];
}

/**
 * Motion pilot (#79): can Seedance play actions — leaving, entering, an outfit change, hands — well enough
 * to replace a reshoot? Every clip starts and ends on a judged still; eimi's four clips are chained
 * (each opens on the still the previous one closed on), so a scene can hard-cut between them.
 *
 * Stills (media:keyframes -- --motion …): `from` is the picked keyframe the new still is built on — the same
 * room seen by the same camera — so the room in every still of a chain is one room.
 */
export interface MotionKeyframe {
  name: string;
  star: Star;
  ratio: '9:16' | '16:9';
  /** false: a people-free still (her empty room); never judged for likeness, sent inline, never uploaded. */
  person: boolean;
  /** Keyframe record (out/keyframes/v2/<from>.json) whose pick is the base picture: location, camera, light. */
  from: string;
  /** What changes from the base picture: framing, pose, outfit. */
  brief: string;
  wearing?: string;
}

/** Her usual look for the room (the hero loops' blouse and scarf) with trousers, now that she is seen full length. */
const EIMI_HOME = 'an elegant rose satin blouse with long sleeves and a high modest neckline, a navy silk scarf loosely knotted at her neck, and navy wide-leg trousers';
/** The outfit she changes into: covered shoulders and neckline, floor length (clothed-companion tone). */
const EIMI_GOWN = 'a floor-length rose satin evening gown with long fitted sleeves, a high modest neckline and a softly flowing skirt; no scarf';

export const MOTION_KEYFRAMES: MotionKeyframe[] = [
  ...SYSTEM_V11_KEYFRAMES,
  {
    name: 'eimi-room-9x16', star: 'eimi', ratio: '9:16', person: false, from: 'eimi-hero-16x9',
    brief: 'The same hotel suite, now empty, seen from further back in a vertical wide shot at standing eye level: the burgundy velvet armchair stands in the middle ground slightly left of centre, facing the camera, with the small side table, the glowing pink cylinder lamp and a glass of rosé beside it; floor-to-ceiling windows with sheer curtains behind, Tokyo Tower glowing orange in the night skyline. The right third of the frame is open floor leading out of the frame (the way to the rest of the suite), and the floor is visible in front of the armchair.'
  },
  {
    name: 'eimi-seated-9x16', star: 'eimi', ratio: '9:16', person: true, from: 'eimi-room-9x16', wearing: EIMI_HOME,
    brief: 'Keep this exact room, camera position, framing, lens and light. She sits relaxed in the burgundy velvet armchair, her whole figure visible from head to feet, knees together and angled slightly, hands resting in her lap, facing the camera.'
  },
  {
    name: 'eimi-gown-9x16', star: 'eimi', ratio: '9:16', person: true, from: 'eimi-room-9x16', wearing: EIMI_GOWN,
    brief: 'Keep this exact room, camera direction, lens and light. She stands close to the camera, just right of centre, framed from mid-thigh up in a medium shot, her face in the upper third of the frame and large and clear; the armchair, lamp and Tokyo Tower are softly out of focus behind her. Arms relaxed at her sides.'
  },
  {
    name: 'mahiro-rps-9x16', star: 'mahiro', ratio: '9:16', person: true, from: 'mahiro-hero-9x16',
    brief: 'Keep this exact balcony, outfit, framing and light: chest-up in the upper half of the frame. She raises her right hand in front of her chest in a loose, relaxed fist, ready to play rock-paper-scissors (jan-ken-pon) with you: a natural hand with five fingers, the thumb folded over the outside of the fingers, the fist fully inside the frame.'
  },
  ...VARIANT_KEYFRAMES,
  ...SCENE_V11_KEYFRAMES,
  ...HOME_V11_KEYFRAMES
];

/** Exits and entrances are wider than a companion loop, so the face may be small; the rules for hands are new. */
const MOTION_LOOK = 'Photorealistic live-action footage with exactly the look, light and colour grade of the first frame, Japanese photobook style.';
const MOTION_NEGATIVE = 'Exactly one adult woman, fully clothed throughout; the same face, hair and accessories as in the frames. Her eyes stay open except for quick natural blinks: no slow blinks, no eyes held closed, no squinting. Natural hands with five fingers each. She does not speak. No subtitles, no text, no logo, no watermark, no music, no audio.';
const MOTION_HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. The room and light stay the same.';
const EIMI_ROOM = 'her hotel suite at night: the burgundy velvet armchair, the pink lamp and the glass of rosé, Tokyo Tower glowing beyond the windows';

export const MOTION_SHOTS: Shot[] = [
  {
    id: 'eimi-leave-9x16', category: 'character', star: 'eimi', talent: 'eimi', model: 'sd25', ratio: '9:16', resolution: '1080p', duration: 6, loop: false,
    use: 'Scene (#70): she gets up from the armchair and leaves the room — "no peeking" before the outfit change',
    // v1 of this clip ended on the eimi-room-9x16 still: that still and the seated keyframe are two separate
    // gpt-image renders whose camera differs slightly, and Seedance joined them with a hard cut at 5.0 s (thumbnail
    // step 21.5, caught by media:check's cut detector). Now she simply leaves and the empty frame she leaves
    // behind is the one the next clips start on.
    frames: { first: 'eimi-seated-9x16', end: 'empty' },
    prompt: [
      'Start exactly from the first frame. The camera and the room never change; only she moves, and at the end the room is empty.',
      MOTION_LOOK,
      `{WOMAN}, wearing ${EIMI_HOME}, is in ${EIMI_ROOM}.`,
      '0-1s: she sits in the armchair looking into the lens with a soft closed-mouth smile.',
      '1-2.5s: she rises smoothly from the armchair to standing.',
      '2.5-5s: she turns to her left and walks out of the frame past the right edge with natural, graceful steps; by 5s she is completely gone.',
      '5-6s: the same room, empty, from the same camera; only the city lights twinkle.',
      MOTION_HOLD,
      MOTION_NEGATIVE
    ].join('\n')
  },
  {
    id: 'eimi-empty-9x16', category: 'scene', star: 'eimi', model: 'sd25', ratio: '9:16', resolution: '1080p', duration: 5, loop: true,
    use: 'Scene (#70): the empty room while she changes; loops until she walks back in',
    frames: { first: { after: 'eimi-leave-9x16' }, last: { after: 'eimi-leave-9x16' } },
    prompt: `The same hotel suite at night: the burgundy velvet armchair, the pink lamp glowing softly, the glass of rosé, Tokyo Tower and the city lights twinkling beyond the windows, the sheer curtains stirring very slightly. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}`
  },
  {
    id: 'eimi-return-9x16', category: 'character', star: 'eimi', talent: 'eimi', model: 'sd25', ratio: '9:16', resolution: '1080p', duration: 8, loop: false,
    use: 'Scene (#70): she walks back in wearing the rose satin gown and stops close to you',
    frames: { first: { after: 'eimi-empty-9x16' }, last: 'eimi-gown-9x16' },
    prompt: [
      'The first frame is the empty room; the last frame shows the woman standing close to the camera in the same room. Start exactly from the first frame and end exactly on the last frame.',
      MOTION_LOOK,
      `{WOMAN}, wearing ${EIMI_GOWN}, comes back into ${EIMI_ROOM}.`,
      '0-1s: the empty room exactly as in the first frame.',
      '1-2s: she walks into the frame from the right edge.',
      '2-6s: she walks toward the camera with graceful, unhurried steps, the satin skirt swaying, her eyes on the lens.',
      '6-8s: she stops close to the camera and settles exactly into the last frame\'s pose, framing and confident closed-mouth smile, and holds still.',
      MOTION_HOLD,
      MOTION_NEGATIVE
    ].join('\n')
  },
  {
    id: 'eimi-twirl-9x16', category: 'character', star: 'eimi', talent: 'eimi', model: 'sd25', ratio: '9:16', resolution: '1080p', duration: 6, loop: true,
    use: 'Scene (#70): close shot, she turns around once to show the gown; loops',
    frames: { first: { after: 'eimi-return-9x16' }, last: 'eimi-gown-9x16' },
    prompt: [
      'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.',
      MOTION_LOOK,
      `{WOMAN}, wearing ${EIMI_GOWN}, stands close to the camera in ${EIMI_ROOM}.`,
      '0-1s: she holds the first frame\'s pose, looking into the lens with her confident closed-mouth smile.',
      '1-5s: she turns slowly around on the spot in one smooth, continuous turn, so the back of the gown and its flowing satin skirt are seen, and comes round to face the lens again.',
      '5-6s: back to exactly the first frame\'s pose, expression and framing; she holds still.',
      MOTION_HOLD,
      MOTION_NEGATIVE
    ].join('\n')
  },
  {
    id: 'mahiro-rps-9x16', category: 'character', star: 'mahiro', talent: 'mahiro', model: 'sd25', ratio: '9:16', resolution: '1080p', duration: 6, loop: false,
    use: 'Scene (#66): rock-paper-scissors — she throws scissors, loses, and pouts',
    frames: { first: 'mahiro-rps-9x16' },
    prompt: [
      'Start exactly from the first frame.',
      MOTION_LOOK,
      `{WOMAN}, wearing ${TALENTS.find((t) => t.star === 'mahiro')!.wearing}, is on her balcony at night, playing rock-paper-scissors with you.`,
      '0-1.5s: she bounces her raised fist twice in rhythm, "jan, ken", looking into the lens with a playful closed-mouth smile.',
      '1.5-2s: on the third beat, "pon", she throws scissors toward the lens: index and middle fingers straight and spread in a clear V, ring and little fingers folded down under the thumb, the hand steady at chest height and fully in frame.',
      // Draft 1 had her "glance down at your hand": lowered eyelids measured as a 0.9 s blink. Eyes stay on the lens.
      '2-3s: she holds the scissors still, her eyes open and on the lens.',
      '3-6s: she has lost: she puffs out her cheeks and presses her lips into a small pout, eyebrows drawn together, eyes open and on the lens, gives a small shake of her head and lowers her hand.',
      MOTION_HOLD,
      MOTION_NEGATIVE
    ].join('\n')
  }
];

/** First and last frame of a shot, with chains followed back to the still they refer to. */
export function anchorsOf(shot: Shot, shots: Shot[] = SHOTS): { first?: Anchor; last?: Anchor } {
  const resolve = (ref: FrameRef | undefined, seen: Set<string>): Anchor | undefined => {
    if (ref === undefined) return undefined;
    if (typeof ref === 'string') return { keyframe: ref };
    if ('still' in ref) return { still: ref.still };
    if (seen.has(ref.after)) throw new Error(`frame chain loops back to ${ref.after}`);
    const prev = shots.find((s) => s.id === ref.after);
    if (prev?.frames?.end === 'empty' && !prev.frames.last) return { rendered: prev.id };
    if (!prev?.frames?.last) throw new Error(`${shot.id}: chained after ${ref.after}, which has no last frame (give it one, or end: 'empty')`);
    return resolve(prev.frames.last, new Set([...seen, ref.after]));
  };
  return { first: resolve(shot.frames?.first, new Set([shot.id])), last: resolve(shot.frames?.last, new Set([shot.id])) };
}

export const sameAnchor = (a?: Anchor, b?: Anchor) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
export const hasPerson = (a?: Anchor) => !!a && 'keyframe' in a;

/** Who is on screen at each end: the motion check lets a face disappear only where the frames say she leaves. */
export function presenceOf(shot: Shot): 'on' | 'exits' | 'enters' | 'empty' {
  if (!shot.frames) return shot.talent ? 'on' : 'empty';
  const { first, last } = anchorsOf(shot);
  const a = hasPerson(first), b = shot.frames.end === 'empty' ? false : last ? hasPerson(last) : a;
  return a && b ? 'on' : a ? 'exits' : b ? 'enters' : 'empty';
}

const AMBIENT: Shot[] = [
  { id: 'loading-stars', category: 'ambient', use: 'Loading screen and age gate background', model: 'sd25', ratio: '9:16', resolution: '720p', duration: 8, loop: true, prompt: `Tiny four-pointed rose-pink stars and soft light dust drifting slowly through a deep navy night sky, gentle twinkling, depth of field. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}` },
  { id: 'reveal-burst', category: 'ambient', use: 'Card reveal / serial result background', model: 'sd25', ratio: '9:16', resolution: '720p', duration: 5, loop: false, prompt: `A single four-pointed star of rose-pink light blooms in the centre of a navy darkness and bursts into soft glittering particles that drift outward. ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}` }
];

/** Video tier → the .env.seedance variable holding its endpoint id (config/models.json). */
export const MODELS: Record<ModelKey, string> = VIDEO_ENDPOINT_ENV;

export const SHOTS: Shot[] = [
  ...TALENTS.flatMap(sceneShots),
  ...TALENTS.flatMap(assetShots),
  ...AMBIENT,
  ...SYSTEM_V11_SHOTS,
  ...TALENTS.flatMap(characterShots),
  ...MOTION_SHOTS,
  ...VARIANT_SHOTS,
  ...SCENE_V11_SHOTS,
  ...SCENE_V11_WIDE_SHOTS,
  ...HOME_V11_SHOTS
];

/** Guards that catch mistakes before credits are spent. */
export function validate(shots: Shot[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of shots) {
    if (!/^[a-z0-9-]+$/.test(s.id)) problems.push(`${s.id}: id must be kebab-case`);
    if (seen.has(s.id)) problems.push(`${s.id}: duplicate id`);
    seen.add(s.id);
    if (s.duration < 4 || s.duration > 12) problems.push(`${s.id}: duration ${s.duration}s outside 4–12`);
    if (s.prompt.length > 1800) problems.push(`${s.id}: prompt too long`);
    if (s.category === 'character' && (!s.talent || !s.prompt.includes('{WOMAN}'))) problems.push(`${s.id}: a real person may only be generated from her verified assets ({WOMAN} + talent)`);
    if (s.category !== 'character' && (s.talent || s.prompt.includes('{WOMAN}'))) problems.push(`${s.id}: only character shots reference a talent`);
    if (s.category !== 'character' && !/no people/i.test(s.prompt)) problems.push(`${s.id}: non-character shots must state "no people"`);
    if (s.loop && s.multiview) problems.push(`${s.id}: a loop cannot also be a turntable`);
    if (s.lock && !s.loop) problems.push(`${s.id}: only loops are locked to a first/last frame`);
    if (s.frames) {
      try {
        const { first, last } = anchorsOf(s, shots);
        if (s.lock) problems.push(`${s.id}: use frames or lock, not both`);
        if (s.frames.end === 'empty' && (s.frames.last || !hasPerson(first) || s.loop)) problems.push(`${s.id}: end 'empty' is for a clip that starts on her and has no last frame`);
        if (s.loop && !sameAnchor(first, last)) problems.push(`${s.id}: a loop must start and end on the same still`);
        if (s.category !== 'character' && (hasPerson(first) || hasPerson(last))) problems.push(`${s.id}: only character shots may start or end on a keyframe of her`);
        if (s.category === 'character' && !hasPerson(first) && !hasPerson(last)) problems.push(`${s.id}: a character shot needs her keyframe at one end`);
        // The v1 hero frame carries her outfit and light; words for them fight the anchor (#24).
        const onV1 = [first, last].some((a) => !!a && 'keyframe' in a && a.keyframe.endsWith('-v1'));
        if (onV1 && /wearing|Bright soft key light/.test(s.prompt)) problems.push(`${s.id}: prompts anchored to the v1 hero frame must not describe outfit or light`);
      } catch (e) {
        problems.push(`${s.id}: ${(e as Error).message}`);
      }
    }
    if (s.xfade !== undefined && (s.xfade < 0 || s.xfade > 0.3)) problems.push(`${s.id}: crossfade ${s.xfade}s outside 0–0.3 (longer ones melt faces and ghost moving cloth)`);
    if (s.category !== 'ambient' && s.category !== 'character' && !s.star) problems.push(`${s.id}: missing star`);
  }
  return problems;
}
