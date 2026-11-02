/**
 * v1.1 system scenes and confession (#55, #71; owner 2026-09-28): dedicated clips for the moments the five share,
 * which played stand-ins until now (`<star>-hero` wide, `<star>-breath` close, `<star>-night` for the lights out).
 * Clip ids are `<star>-sys-<moment>-<ratio>` and `<star>-confession-<shot>-<ratio>`; the scripts name the family
 * (no ratio) and the player picks the screen's orientation. Wide shots come in 16:9 too; close shots are 9:16 only.
 *
 * How each clip is built (owner, 2026-09-28: every set built true to the real world as a still first, then animated):
 * 1. The SET: a people-free still of the place (gpt-image-2 only), edited from her published room where one exists
 *    (`<media>-poster`) so it stays her world — the same balcony at sunset, her bedroom at night — or from another set
 *    still (the dark room is her bedroom with the lamp turned down).
 * 2. HER in the set: an edit by gpt-image-2 given a face crop of her owner-approved v1 hero frame (ref 1), the v1
 *    frame itself for her hair, outfit and accessories (ref 2) and the set still for place, camera and light (ref 3).
 *    Her hair and outfit are never described in words (the v2 wording in manifest.TALENTS is another look; see
 *    shots/scenes-v11.ts on media/scene-clips). Judged by the continuity line-up against the five v1 frames
 *    (continuity.ts), pass 4, then registered in her asset group like the #79 stills.
 * 3. The CLIP: Seedance 2.5 from her still (asset://) — locked loops (same still at both ends, no crossfade) where
 *    the scene idles, one-shots between two stills where something happens (she steps in to hug you; the promise:
 *    from waiting to the v1 hero frame, so the scene cuts straight into her HD hero loop).
 *
 * Tone ceiling (docs/compliance-jp.md §6): a close-up, a whisper at the ear, a hug. Fully clothed in her v1 look
 * throughout (えいみ with her navy wrap over both shoulders). Weather: the world she already has (her room, her
 * window, her alley); no landmark that would place an unconfirmed hometown (#48) — えいみ's Tokyo Tower is her v1 view.
 *
 * Like shots/scenes-v11.ts, this module imports only types from manifest.ts (manifest.ts imports it back).
 */
import type { MotionKeyframe, Shot, Star } from '../manifest';

export type R = '9x16' | '16x9';
export const SET_KINDS = ['dusk', 'bedroom', 'dark', 'herbday', 'hisbday', 'snow', 'rain', 'typhoon'] as const;
export type SetKind = (typeof SET_KINDS)[number];

export interface SystemKeyframe extends MotionKeyframe {
  /** Person stills: the people-free set (or another still of her) whose place, camera and light she is put into. */
  camera?: string;
  /** Person stills: the camera is at the set's position (false) or has moved in closer along the same line (true). */
  closer?: boolean;
  /**
   * Person stills: a head crop of her retouched card photo (assets/agency/refs/<star>/photo/head, #135), sent as one
   * more likeness reference for her face only — the photos' hair, make-up and stickers are not her look here.
   */
  photo?: string;
}

const ratioOf = (r: R) => (r === '9x16' ? '9:16' : '16:9') as '9:16' | '16:9';
/** frame 0 of her published v1 hero loop (#46, registered by #88): her approved look. */
export const v1 = (star: Star, r: R = '9x16') => `${star}-hero-${r}-v1`;
export const setName = (star: Star, kind: SetKind, r: R) => `${star}-sysset-${kind}-${r}`;
export const stillName = (star: Star, kind: string, r: R) => `${star}-sys-${kind}-${r}`;

// ─────────────────────────────────────────────────────────────── her world, per talent
interface World {
  /** One line for Seedance: where she is (no outfit or light words; the frames carry them). */
  place: Record<SetKind | 'hero', string>;
  /** Set stills: [base picture, what the set is]. The base is a published poster (`<media>-poster`) or another set. */
  sets: Record<SetKind, [string, string]>;
  /** His birthday: what she has made ready for him (#61 lines/system.json), held out toward the lens. */
  gift: string;
  /** How she moves in the his-birthday wide shot. */
  giftMotion: string;
  /** Rainy night: what she holds or does by the window (her own lines). */
  rainProp: string;
  /** First snow, wide: her pose. */
  snowPose: string;
  snowMotion: string;
}

/** Real-world set craft, shared by every set still. */
const SET_CRAFT = 'Build it like a real, lived-in location on a professional photobook shoot: real materials and textures (wood grain, linen, glass, painted plaster, metal), true-to-life scale and proportions, practical light sources that actually exist in the room, believable small details of daily life; nothing fantastical, no CGI look.';

const WORLD: Record<Star, World> = {
  mahiro: {
    place: {
      hero: 'is on her apartment balcony high above the city at night',
      dusk: 'is on her apartment balcony at sunset, the city below turning gold and pink',
      bedroom: 'is in her bedroom at night, lit only by the small bedside lamp',
      dark: 'her bedroom at night with the lights out',
      herbday: 'is on her balcony at night, a small birthday cake with lit candles on the table',
      hisbday: 'is on her balcony at night, fairy lights along the railing',
      snow: 'is inside her apartment by the glass balcony door, snow falling over the city lights outside',
      rain: 'is inside her apartment by the glass balcony door, rain running down the glass',
      typhoon: 'is inside her apartment by the glass balcony door, a typhoon\'s wind and rain lashing the balcony outside'
    },
    sets: {
      dusk: ['mahiro-night-9x16-poster', 'The same high-rise apartment balcony at sunset instead of night: the low sun has just touched the horizon, the sky glows apricot and rose near the skyline and deepens to soft blue above, a few thin clouds lit pink; the city below is hazy gold with the first windows lighting up. The sheer white curtains at the open glass door, the small wooden table with two ceramic mugs, a potted olive tree and the dark metal railing with frosted glass panels are all lit by warm, low sunlight.'],
      bedroom: ['mahiro-morning-9x16-poster', 'The same bedroom late at night: the bed with white linen duvet and pillows (unmade, soft), a wooden nightstand with a small ceramic bedside lamp under a linen shade glowing warm amber, a paperback and a glass of water beside it; the sheer curtains are drawn, the city\'s faint blue glow behind them. The room is dim, lit only by that lamp: warm pool of light on the pillows, soft navy shadows everywhere else.'],
      dark: ['bedroom', 'The same bedroom, same camera, but the lights are out: a genuinely dark room. Most of the frame falls into deep navy-black shadow; the only light is the small bedside lamp turned down to a faint warm glow (a tiny pool of amber on the nightstand and the edge of the pillow) and a thin line of cool blue city light at the edge of the curtain. Nothing else is lit.'],
      herbday: ['mahiro-night-9x16-poster', 'The same balcony at night, ready for a birthday: on the small wooden table a small round strawberry shortcake (white cream, fresh strawberries) on a white plate with three thin lit candles, two small plates and forks, the two ceramic mugs pushed aside; a string of warm fairy lights along the railing, the city lights below softly out of focus.'],
      hisbday: ['mahiro-night-9x16-poster', 'The same balcony at night, made festive: a string of warm fairy lights along the railing, a small jar of white flowers on the wooden table next to two ceramic mugs and two small plates with forks; the city lights below softly out of focus.'],
      snow: ['mahiro-night-9x16-poster', 'Inside the apartment, looking out through the closed floor-to-ceiling glass balcony door at night: large soft snowflakes falling past the glass over the city lights, a thin layer of fresh snow on the balcony railing, the little table and the olive tree outside; inside, the sheer curtain gathered to one side and a floor lamp glowing warm. The first snow of the year.'],
      rain: ['mahiro-night-9x16-poster', 'Inside the apartment, looking out through the closed floor-to-ceiling glass balcony door at night: rain streaming down the glass in beads and rivulets, the city lights blurred into soft bokeh through the wet glass, the balcony wet outside; inside, the sheer curtain gathered to one side and a floor lamp glowing warm.'],
      typhoon: ['mahiro-night-9x16-poster', 'Inside the apartment, looking out through the closed floor-to-ceiling glass balcony door on a stormy night: a typhoon\'s wind-driven rain streaks sideways across the glass, the potted olive tree on the balcony bent hard by the wind, the city lights smeared and dim through the storm; inside, safe and warm, the sheer curtain gathered to one side and a floor lamp glowing.']
    },
    gift: 'a small round strawberry shortcake on a white plate with one lit candle, held in both hands',
    giftMotion: 'she holds the cake out toward the lens in both hands, the candle flame flickering, then brings it back',
    rainProp: 'a folded, fluffy white towel held against her chest in both hands, ready for you',
    snowPose: 'standing just inside the glass door, turned toward the lens, snow falling over the city behind her',
    snowMotion: 'she glances back over her shoulder at the falling snow at eye level, then turns back to the lens with a delighted closed-mouth smile and points lightly at the glass with one finger'
  },
  nana: {
    place: {
      hero: 'sits in her living room at night by the big window',
      dusk: 'is in her living room at dusk, the big window glowing violet and peach',
      bedroom: 'is in her small bedroom at night, lit only by the reading lamp',
      dark: 'her bedroom at night with the lights out',
      herbday: 'is in her living room at night, a small birthday cake with lit candles on the coffee table',
      hisbday: 'is in her living room at night, a tea set for two on the coffee table',
      snow: 'is in her living room by the big window, snow falling outside in the dark',
      rain: 'is in her living room by the big window, rain streaking the glass',
      typhoon: 'is in her living room by the big window, a typhoon\'s wind and rain lashing the glass'
    },
    sets: {
      dusk: ['nana-night-9x16-poster', 'The same cosy living room at dusk instead of night: through the big window a violet-and-peach dusk sky over a quiet residential town of low houses and dark distant hills, the first street lights coming on; inside, the floor lamp has just been switched on, the sofa with a folded knit blanket and an open paperback, bookshelves, a mug on the side table. No rain.'],
      bedroom: ['nana-night-9x16-poster', 'Her small bedroom at night, in the same style as this living room: a wooden bed with cream linen and a lavender knit throw, a bookshelf crammed with paperbacks, a brass reading lamp on the wooden nightstand glowing warm with a stack of books and a glasses case beside it, a window with the curtain half drawn and rain on the glass. The room is dim, lit only by that lamp.'],
      dark: ['bedroom', 'The same bedroom, same camera, but the lights are out: a genuinely dark room. Most of the frame falls into deep navy-black shadow; the only light is the brass reading lamp turned down to a faint warm glow on the nightstand and the edge of the pillow, and a faint cool blue light at the rain-streaked window. Nothing else is lit.'],
      herbday: ['nana-night-9x16-poster', 'The same living room at night, ready for a birthday: on the low wooden coffee table in front of the sofa, a small round cake with white cream and berries on a cake stand with three thin lit candles, a teapot and two cups, an open book; the floor lamp glowing, rain softly on the big window.'],
      hisbday: ['nana-night-9x16-poster', 'The same living room at night, ready for a small celebration: on the low wooden coffee table a white porcelain tea set for two (teapot, two cups on saucers, a little jug of milk) and a slim hardcover book tied with a pale ribbon; the floor lamp glowing, rain softly on the big window.'],
      snow: ['nana-night-9x16-poster', 'The same living room at night, the big window now showing heavy soft snow falling in the dark over the quiet town, snow gathering on the window ledge outside and on the roofs; inside, the floor lamp glowing warm, the sofa with the folded knit blanket. The first snow of the year.'],
      rain: ['nana-night-9x16-poster', 'The same living room at night, the rain on the big window heavier: beads and rivulets running down the glass, the street lights outside blurred into soft bokeh; inside, the floor lamp glowing warm, the sofa with the folded knit blanket and an open paperback.'],
      typhoon: ['nana-night-9x16-poster', 'The same living room on a stormy night: through the big window a typhoon\'s wind-driven rain slants hard across the glass, trees outside bent by the wind, the street lights smeared; inside, safe and warm, the floor lamp glowing and the sofa with the folded knit blanket.']
    },
    gift: 'a white porcelain teacup of warm tea on its saucer, held in both hands',
    giftMotion: 'she holds the teacup out toward the lens in both hands, a thin wisp of steam rising, then brings it back to her chest',
    rainProp: 'an open paperback held in both hands at chest height, the pages facing her',
    snowPose: 'standing by the big window, turned toward the lens, snow falling in the dark behind her',
    snowMotion: 'she turns to look out of the window at the falling snow at eye level, then back to the lens with a bright, excited closed-mouth smile and a little bounce on her toes'
  },
  unpai: {
    place: {
      hero: 'is in the narrow neon-lit alley at night',
      dusk: 'is on the rooftop at sunset, the city lights coming on below',
      bedroom: 'is in her bedroom at night, lit by fairy lights and a small lamp',
      dark: 'her bedroom at night with the lights out',
      herbday: 'is in her bedroom at night, a small birthday cake with lit candles on the low table',
      hisbday: 'is in her bedroom at night among plush toys and fairy lights',
      snow: 'is in the narrow neon-lit alley at night, snow falling',
      rain: 'is in her bedroom at night by the window, rain on the glass and neon outside',
      typhoon: 'is in her bedroom at night by the window, a typhoon\'s wind and rain lashing the glass'
    },
    sets: {
      dusk: ['unpai-day-9x16-poster', 'The same rooftop at sunset instead of day: the sky blazing pink, coral and orange behind the city, thin clouds lit from below, the first neon signs and windows lighting up in the streets below; the laundry line with the pink scarf, a water tank, the metal railing and concrete floor lit by warm low sun.'],
      bedroom: ['unpai-morning-9x16-poster', 'The same bedroom late at night: the bed piled with plush toys and a soft pink blanket, polaroid photos clipped to a string of warm fairy lights, a small desk with a microphone on a boom arm and a closed laptop, a pink LED strip glowing softly behind the desk, a small bedside lamp glowing warm; the curtains half open to the neon city at night. The room is dim, lit by the fairy lights and the lamp.'],
      dark: ['bedroom', 'The same bedroom, same camera, but the lights are out: a genuinely dark room. Most of the frame falls into deep navy-black shadow; the only light is the small bedside lamp turned down to a faint warm glow and a few fairy lights on their lowest setting, with a faint pink-and-blue neon glow at the edge of the curtain. Nothing else is lit.'],
      herbday: ['unpai-morning-9x16-poster', 'The same bedroom at night, ready for a birthday: on a low round table in front of the bed a small round cake with pink cream and strawberries and three thin lit candles, a pair of pearl-white over-ear headphones beside it; the bed piled with plush toys, polaroids on the fairy-light string glowing warm, the neon city through the window.'],
      hisbday: ['unpai-morning-9x16-poster', 'The same bedroom at night: the bed piled with plush toys, polaroids on the fairy-light string glowing warm, the desk with the microphone on its boom arm and a phone lying face down, a low round table with two cans of soda and a bag of snacks; the neon city through the window.'],
      snow: ['unpai-night-9x16-poster', 'The same narrow neon-lit alley at night, now in falling snow: large soft snowflakes drifting down through the pink and blue neon light, a thin layer of fresh snow on the vending machine roof, the air-conditioner units and the edges of the wet asphalt, the neon reflected in the wet ground. The first snow of the year.'],
      rain: ['unpai-morning-9x16-poster', 'The same bedroom at night, seen toward its window: rain streaming down the glass in beads and rivulets, the pink and blue neon of the city outside blurred through the wet glass; inside, the fairy lights and polaroids, plush toys on the bed, the desk with the microphone on its boom arm, a small lamp glowing warm.'],
      typhoon: ['unpai-morning-9x16-poster', 'The same bedroom on a stormy night, seen toward its window: a typhoon\'s wind-driven rain slanting hard across the glass, the neon of the city outside smeared and flickering through the storm; inside, safe and warm, the fairy lights and polaroids, plush toys on the bed, a small lamp glowing.']
    },
    gift: 'one small white wireless earbud on the open palm of her hand, held out toward the lens, her phone in her other hand with its screen facing her',
    giftMotion: 'she holds the earbud out toward the lens on her open palm, offering it to you, then brings her hand back',
    rainProp: 'a pair of pearl-white over-ear headphones resting around her neck, one hand on an earcup',
    snowPose: 'standing in the alley under a clear vinyl umbrella, turned toward the lens, snowflakes drifting through the neon behind her',
    snowMotion: 'she tilts the clear umbrella aside and holds out her free hand palm-up to catch a snowflake, looking at the lens with a bright closed-mouth smile, then brings the umbrella back'
  },
  alice: {
    place: {
      hero: 'is in the glass greenhouse at night among white roses and fairy lights',
      dusk: 'is in the glass greenhouse at sunset, golden light through the glass',
      bedroom: 'is in her bedroom at night, lit only by the small porcelain lamp',
      dark: 'her bedroom at night with the lights out',
      herbday: 'is in the glass greenhouse at night, a small birthday cake with lit candles on the white garden table',
      hisbday: 'is in the glass greenhouse at night at the small white upright piano',
      snow: 'is in the glass greenhouse at night, snow settling on the glass roof',
      rain: 'is in the glass greenhouse at night, rain running down the glass',
      typhoon: 'is in the glass greenhouse at night, a typhoon\'s wind and rain lashing the glass'
    },
    sets: {
      dusk: ['alice-night-9x16-poster', 'The same glass greenhouse at sunset instead of night: low golden-pink sunlight streaming through the glass panes and the white-painted iron frame, long warm light across the white roses and green leaves, the sky beyond the glass apricot fading to lavender; the fairy lights are on but faint in the sunlight.'],
      bedroom: ['alice-morning-9x16-poster', 'Her bedroom late at night, in the same style: an antique white iron bed with lace-trimmed white linen, the lace curtains drawn, an antique silver music box and a small porcelain bedside lamp with a pleated shade glowing warm on the nightstand, a vase of white roses. The room is dim, lit only by that lamp.'],
      dark: ['bedroom', 'The same bedroom, same camera, but the lights are out: a genuinely dark room. Most of the frame falls into deep navy-black shadow; the only light is the small porcelain lamp turned down to a faint warm glow on the silver music box and the edge of the pillow, and a faint cool moonlight through the lace curtains. Nothing else is lit.'],
      herbday: ['alice-night-9x16-poster', 'The same glass greenhouse at night, ready for a birthday: among the white roses a small round white garden table with a small white cake decorated with a few white roses and three thin lit candles, a porcelain teapot and two cups; the fairy lights glowing, the glass roof dark above.'],
      hisbday: ['alice-night-9x16-poster', 'The same glass greenhouse at night: a small white upright piano among the white roses with its keyboard lid open and a sheet of music on the stand, a white bench in front of it, the fairy lights glowing, the glass roof dark above.'],
      snow: ['alice-night-9x16-poster', 'The same glass greenhouse at night in the first snow: snow settling in soft white drifts on the glass roof panes and against the lower glass walls, snowflakes melting into beads on the glass, the dark garden outside dusted white; inside, warm among the white roses and the glowing fairy lights.'],
      rain: ['alice-night-9x16-poster', 'The same glass greenhouse at night in the rain: raindrops running down the glass walls and roof in beads and rivulets, the dark garden outside blurred through the wet glass; inside, warm among the white roses and the glowing fairy lights.'],
      typhoon: ['alice-night-9x16-poster', 'The same glass greenhouse on a stormy night: a typhoon\'s wind-driven rain streaking hard across the glass walls, trees in the dark garden outside bent by the wind; inside, the white roses and the fairy lights still glowing warm.']
    },
    gift: 'sitting at the small white upright piano, her hands resting on the keys, turned to the lens',
    giftMotion: 'her fingers play slowly and gracefully across the keys (natural hands, five fingers each) while she looks at the lens with a shy closed-mouth smile',
    rainProp: 'standing close to the rain-streaked glass wall among the white roses, one hand resting lightly on a rose stem',
    snowPose: 'standing among the white roses, turned toward the lens, the snow-covered glass roof behind and above her',
    snowMotion: 'she looks up at the snow on the glass roof at eye level and to the side, then back to the lens with a shy closed-mouth smile, holding her hands together in front of her chest'
  },
  eimi: {
    place: {
      hero: 'is in her hotel suite at night, the city skyline glittering beyond the windows',
      dusk: 'is in her hotel suite at dusk, the skyline at magic hour beyond the windows',
      bedroom: 'is in the suite\'s bedroom at night, lit only by the bedside lamp',
      dark: 'the suite\'s bedroom at night with the lights out',
      herbday: 'is in her hotel suite at night, a small birthday cake with lit candles on the side table',
      hisbday: 'is in her hotel suite at night, the city skyline glittering beyond the windows',
      snow: 'is by the floor-to-ceiling window of her hotel suite, snow falling over the city lights',
      rain: 'is by the floor-to-ceiling window of her hotel suite, raindrops on the glass and the city lights beyond',
      typhoon: 'is by the floor-to-ceiling window of her hotel suite, a typhoon\'s wind and rain lashing the glass'
    },
    sets: {
      dusk: ['eimi-night-9x16-poster', 'The same luxury hotel suite at dusk instead of night: beyond the floor-to-ceiling windows the Tokyo skyline at magic hour, the sky rose-gold at the horizon deepening to indigo above, Tokyo Tower just lit orange, the first office windows glowing; inside, the burgundy velvet armchair, the side table with a glass of rosé and a pink cylinder lamp just switched on.'],
      bedroom: ['eimi-night-9x16-poster', 'The bedroom of the same luxury hotel suite at night: a king bed with crisp white linens and a tall upholstered headboard in navy velvet, a marble-topped nightstand with a small brass bedside lamp glowing warm, sheer curtains half open over a floor-to-ceiling window with the city lights far below. The room is dim, lit only by that lamp.'],
      dark: ['bedroom', 'The same bedroom, same camera, but the lights are out: a genuinely dark room. Most of the frame falls into deep navy-black shadow; the only light is the small brass bedside lamp turned down to a faint warm glow on the marble nightstand and the edge of the pillow, and the faint distant glow of the city through the sheer curtains. Nothing else is lit.'],
      herbday: ['eimi-night-9x16-poster', 'The same hotel suite at night, ready for a birthday: on the small side table a small elegant round cake with glossy pink glaze and three thin lit candles on a glass stand, two champagne coupes of rosé beside it; the burgundy velvet armchair, the pink cylinder lamp, Tokyo Tower and the city glittering beyond the windows.'],
      hisbday: ['eimi-night-9x16-poster', 'The same hotel suite at night: on the small side table two glasses of rosé and a small square gift box wrapped in navy paper with a rose-gold satin ribbon; the burgundy velvet armchair, the pink cylinder lamp, Tokyo Tower and the city glittering beyond the windows.'],
      snow: ['eimi-night-9x16-poster', 'The same hotel suite at night, seen toward the floor-to-ceiling window: large soft snowflakes falling past the glass over the glittering city lights and the orange glow of Tokyo Tower, a few flakes clinging to the glass; inside, the pink cylinder lamp and the edge of the velvet armchair. The first snow of the year.'],
      rain: ['eimi-night-9x16-poster', 'The same hotel suite at night, seen toward the floor-to-ceiling window: raindrops beaded on the glass and running down it, the city lights and Tokyo Tower blurred into soft bokeh through the wet glass; inside, the pink cylinder lamp and the edge of the velvet armchair.'],
      typhoon: ['eimi-night-9x16-poster', 'The same hotel suite on a stormy night, seen toward the floor-to-ceiling window: a typhoon\'s wind-driven rain streaking sideways across the glass, the city lights smeared and dim through the storm, low clouds racing; inside, safe and warm, the pink cylinder lamp and the edge of the velvet armchair.']
    },
    gift: 'a small square gift box wrapped in navy paper with a rose-gold satin ribbon, held in both hands',
    giftMotion: 'she holds the gift box out toward the lens in both hands with a playful, confident closed-mouth smile, then brings it back',
    rainProp: 'standing by the rain-beaded window, one hand resting lightly on the glass',
    snowPose: 'standing by the floor-to-ceiling window, turned toward the lens, snow falling over the city lights behind her',
    snowMotion: 'she glances at the falling snow beyond the glass at eye level, then back to the lens with a warm closed-mouth smile and a small tilt of her head'
  }
};

// ─────────────────────────────────────────────────────────────── promises kept (#59, #67; 2026-09-30)
/**
 * The two promise moments that still played stand-ins. Both reuse stills already in her asset group where they can:
 * - promise kept, close: a locked loop on the keyframe her close breathing loop opens on (`<star>-breath-9x16`, her
 *   own room at night — the room the promise-kept wide ends in): the moment she sees you came, relief and warmth.
 * - the morning promise (#67), wide: a locked loop on her morning still (`<star>-v11-morning-<r>`, #144: her morning
 *   home look), acting out the promise her morning lines keep (lines/system.json talents.<star>.promiseMorning;
 *   奈々's is the one read-aloud names: 「明日の朝、お茶を淹れて続きを読む」 — tea, and the rest of the story).
 * - the morning promise, close: a new still, the camera moved in on that morning still (her face also judged
 *   against her retouched card photos, #135), locked loop.
 */
export const morningStill = (star: Star, r: R) => `${star}-v11-morning-${r}`;
/** Her retouched card photo head crop (front where there is one; アリス's card photos are all three-quarter). */
const PHOTO: Record<Star, string> = {
  mahiro: 'mahiro/photo/head/front-01.jpg', nana: 'nana/photo/head/front-01.jpg', unpai: 'unpai/photo/head/front-01.jpg',
  alice: 'alice/photo/head/right34-02.jpg', eimi: 'eimi/photo/head/front-01.jpg'
};

interface PromiseMorning { place: string; wide: string[]; /** The 16:9 wide's action, where it must differ. */ wide16?: string[]; close: string; closeAction: string[]; retimeMax?: number }
const EYES = 'her eyes open and on the lens';
const PROMISE_MORNING: Record<Star, PromiseMorning> = {
  mahiro: {
    // 「約束、覚えててくれたんだ。朝いちばんに会えるの、うれしい」
    place: 'sits on the edge of your bed in the morning and leans over you: you are lying with your head on the pillow',
    wide: [
      `1-2.5s: her smile grows, delighted that you remembered, ${EYES}.`,
      '2.5-4.5s: she lifts one hand beside her cheek and gives a small, soft "good morning" wave, tilting her head, then lowers the hand out of the frame.'
    ],
    close: 'The camera has moved in close along the same line of sight, at pillow height: a close shot of her face and shoulders as she leans over you, her face large and clear in the upper half of the frame, lit by the soft morning sun from the window, the white sheets softly out of focus. A happy, tender closed-mouth smile, eyes open on the lens. Her hands are out of the frame.',
    closeAction: [
      `1-3s: she tilts her head a little toward the lens, her smile softening with happiness, ${EYES}; her shoulders and the neckline of her cardigan and top stay exactly as in the first frame; a strand of hair falls forward.`,
      '3-4.5s: she tilts her head a little as if saying good morning, sunlight shimmering softly on her hair.'
    ]
  },
  nana: {
    // 「約束どおり、お茶淹れたよ。あったかいうちにどうぞ」「…ゆうべの続き、読むね」
    place: 'stands at the counter in her kitchen in the morning: the copper kettle, a vase of roses, a bright window',
    wide: [
      `1-3.5s: she holds the teacup on its saucer out toward the lens in both hands, a thin wisp of steam rising from it, with a small encouraging nod, ${EYES}.`,
      '3.5-5s: she brings the cup back to her chest.'
    ],
    close: 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders in the bright morning kitchen, her glasses on, her face large and clear in the upper half of the frame; she holds an open paperback book in both hands at chest height, the pages turned toward her and the plain cover toward the lens (no readable text), about to read to you. A soft, happy closed-mouth smile, eyes open on the lens. Natural hands with five fingers each.',
    closeAction: [
      '1-3.5s: she lowers her eyes to the page and reads the last lines aloud, her lips moving softly (no sound), the book held still.',
      `3.5-5s: she looks up over the book with a soft, proud little smile — "the end" — ${EYES}.`
    ],
    // Reading, she looks down at the page for a moment: a glance media:process must not speed up as a slow blink.
    retimeMax: 0.45
  },
  unpai: {
    // 「…ん、おはよ。約束の朝だね。眠いけど…起きたよ、ほら」
    place: 'sits on her bed in her room in the morning, hugging a teddy bear, the sun at the window',
    wide: [
      `1-3s: still a little sleepy, she stretches one arm up over her head for a moment, ${EYES}, with a drowsy half smile.`,
      '3-4.5s: she brings the arm back around the teddy bear and gives a small proud nod, as if to say "I got up, see?".'
    ],
    // In 16:9 the stretch closed her eyes for a second in both takes (2026-09-30): the bear waves instead.
    wide16: [
      `1-3s: with a sleepy, happy half smile she lifts the teddy bear's paw and makes it give you a small wave, ${EYES}.`,
      '3-4.5s: she lowers the paw and gives a small proud nod, as if to say "I got up, see?".'
    ],
    close: 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders in her bright morning room, the teddy bear hugged up under her chin, her face large and clear in the upper half of the frame, soft morning light on her face. A sleepy but happy closed-mouth smile, eyes open on the lens. Natural hands with five fingers each.',
    closeAction: [
      `1-3s: she rests her chin lightly on the teddy bear's head, a sleepy, happy smile, ${EYES} the whole time.`,
      '3-4.5s: she sways a little from side to side, pleased with herself for getting up.'
    ]
  },
  alice: {
    // 「約束だから、早くから待っていました」
    place: 'sits on the window seat of her room in the morning, a teacup on the sill, the morning light through lace curtains',
    wide: [
      '1-2.5s: she glances toward the window and the morning light at eye level, then back to the lens.',
      `2.5-4.5s: she straightens up a little, composed, a small shy smile, ${EYES}.`
    ],
    close: 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders by the window in the soft morning light through lace curtains, her face large and clear in the upper half of the frame; she holds a white teacup on its saucer at chest height. A composed, slightly shy closed-mouth smile, eyes open on the lens. Natural hands with five fingers each.',
    closeAction: [
      '1-2.5s: she glances aside for a moment, a little embarrassed, then her eyes come back to the lens.',
      `2.5-4.5s: she lifts the teacup slightly toward you with a small, proud smile, ${EYES}.`
    ]
  },
  eimi: {
    // 「約束の朝に来てくれたね。…寝ぐせ、ついてるよ?」
    place: 'sits on a velvet stool at the vanity of her suite in the morning, soft daylight through the tall windows',
    wide: [
      `1-3s: with a teasing smile she points lightly at her own hair with one finger, as if pointing out your bedhead, ${EYES}.`,
      '3-4.5s: she laughs softly without opening her mouth wide and lowers her hand back to her knee.'
    ],
    close: 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders at the vanity in the soft morning daylight, her face large and clear in the upper half of the frame, her navy satin wrap over both shoulders; her chin rests lightly on one hand. A playful, teasing closed-mouth smile, eyes open on the lens. Natural hand with five fingers.',
    closeAction: [
      `1-3s: she tilts her head on her hand with a teasing smile, ${EYES}, as if looking at your bedhead.`,
      `3-4.5s: her smile widens a little, ${EYES} the whole time (no squinting laugh), then settles.`
    ]
  }
};

/** Promise kept, close (#59): the moment she sees you came as promised. */
const PROMISE_KEPT_CLOSE = [
  '0-1s: she holds the first frame\'s pose, eyes on the lens.',
  '1-3s: she lets out one soft breath of relief, her shoulders settling, her eyes staying open on the lens and warming.',
  '3-4.5s: a warm, happy smile spreads across her face and she gives a small nod, as if to say "you came".'
];

// ─────────────────────────────────────────────────────────────── stills
/** Her poses in each still. `wide`: the set's own camera; `close`: the camera moved in along the same line. */
/** `closer`: the camera moves in from the still of her named here (same place, same line of sight). */
interface Pose { kind: string; set: SetKind; closer?: string; brief: (star: Star) => string; ratios: R[] }

const W = WORLD;
const POSES: Pose[] = [
  // Confession (#55): she has waited all week to say it.
  { kind: 'confess-wide', set: 'dusk', ratios: ['9x16', '16x9'], brief: () => 'She stands in this place facing the camera, framed from the thighs up, her face in the upper third of the frame and clearly lit by the low warm sunset light. Her hands are together in front of her waist, the fingers of one hand holding the cuff of the other sleeve, a little nervous; her eyes on the lens with a small, shy closed-mouth smile.' },
  { kind: 'confess-close', set: 'dusk', closer: 'confess-wide', ratios: ['9x16'], brief: () => 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders, her face large and clear in the upper half of the frame, softly lit by the warm sunset light; the place behind her is softly out of focus. Her lips are gently pressed together, her eyes on the lens, earnest and a little nervous. Her hands are out of the frame.' },
  { kind: 'confess-hug', set: 'dusk', closer: 'confess-close', ratios: ['9x16'], brief: () => 'The camera is very close: she has stepped right up to you and opens her arms to hug you; her face, shoulders and forearms fill the frame, her hands reaching toward the edges of the frame, a warm, soft glow of sunset light around her; her face large and clear in the upper half of the frame, her eyes on the lens, with a radiant, relieved closed-mouth smile.' },
  // Goodnight and the whisper (#71): her bedroom, the lamp low, fully clothed.
  { kind: 'goodnight', set: 'bedroom', ratios: ['9x16', '16x9'], brief: () => 'She sits on the edge of the bed near the lamp, turned toward the camera as if you are lying in bed nearby, framed from the thighs up, her face in the upper third of the frame and softly lit by the warm lamp light, her hands resting in her lap; a soft, sleepy closed-mouth smile, eyes open on the lens.' },
  { kind: 'whisper', set: 'bedroom', closer: 'goodnight', ratios: ['9x16'], brief: () => 'The camera is at pillow height and very close: she leans over you from the side of the bed, a close shot of her face and shoulders, her face large and clear in the upper half of the frame, softly lit by the warm lamp light; the dim bedroom softly out of focus behind her. A tender closed-mouth smile, eyes open on the lens. Her hands are out of the frame.' },
  // Birthdays (#61).
  { kind: 'herbday-wide', set: 'herbday', ratios: ['9x16', '16x9'], brief: () => 'She sits just behind the birthday cake, facing the camera, framed from the waist up, the lit candles in the lower part of the frame in front of her, her face in the upper third of the frame, warmly lit by the candles and the room light. Her hands rest together on the table beside the cake; a happy, slightly shy closed-mouth smile, eyes on the lens.' },
  { kind: 'herbday-close', set: 'herbday', closer: 'herbday-wide', ratios: ['9x16'], brief: () => 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders, the lit candles glowing out of focus at the bottom edge of the frame, warm candlelight on her face; her hands pressed together in front of her chest (natural hands, five fingers each), touched and grateful, a soft closed-mouth smile, eyes on the lens.' },
  { kind: 'hisbday-wide', set: 'hisbday', ratios: ['9x16', '16x9'], brief: (s) => `She stands (or sits) in this place facing the camera, framed from the thighs up, her face in the upper third of the frame and softly lit; ${W[s].gift}; a warm, proud closed-mouth smile, eyes on the lens. Natural hands with five fingers each.` },
  { kind: 'hisbday-close', set: 'hisbday', closer: 'hisbday-wide', ratios: ['9x16'], brief: () => 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders, softly lit, the festive place softly out of focus behind her; her hands together in front of her chest as if she has just clapped (natural hands, five fingers each), a warm, happy closed-mouth smile, eyes on the lens.' },
  // Weather (#63): her window, her world.
  { kind: 'snow-wide', set: 'snow', ratios: ['9x16', '16x9'], brief: (s) => `She is ${W[s].snowPose}, framed from the thighs up, her face in the upper third of the frame and softly lit by the warm room light; a delighted closed-mouth smile, eyes on the lens. Natural hands with five fingers each.` },
  { kind: 'snow-close', set: 'snow', closer: 'snow-wide', ratios: ['9x16'], brief: () => 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders, softly and warmly lit, the falling snow softly out of focus behind her; her hands cupped together just below her chin as if warming them (natural hands, five fingers each), a soft closed-mouth smile, eyes on the lens.' },
  { kind: 'rain-wide', set: 'rain', ratios: ['9x16', '16x9'], brief: (s) => `She stands by the rain-streaked window facing the camera, framed from the thighs up, her face in the upper third of the frame and softly lit by the warm lamp light; ${W[s].rainProp}; a calm, gentle closed-mouth smile, eyes on the lens. Natural hands with five fingers each.` },
  { kind: 'rain-close', set: 'rain', closer: 'rain-wide', ratios: ['9x16'], brief: () => 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders, softly and warmly lit, the rain-streaked glass and the blurred lights softly out of focus behind her; a calm, gentle closed-mouth smile, eyes on the lens. Her hands are out of the frame.' },
  { kind: 'typhoon-wide', set: 'typhoon', ratios: ['9x16', '16x9'], brief: () => 'She stands inside by the storm-lashed window facing the camera, framed from the thighs up, her face in the upper third of the frame and softly lit by the warm room light; she holds her phone in both hands against her chest (screen toward her, not visible), her brows drawn up a little in worry, lips softly pressed together, eyes on the lens. Natural hands with five fingers each.' },
  { kind: 'typhoon-close', set: 'typhoon', closer: 'typhoon-wide', ratios: ['9x16'], brief: () => 'The camera has moved in close along the same line of sight: a close shot of her face and shoulders, softly and warmly lit, the storm-lashed window softly out of focus behind her; one hand held against her chest (natural hand, five fingers), her brows drawn up a little in concern, lips softly pressed together, eyes on the lens.' }
];

/** Promise kept (#59): her own hero room and camera (the v1 frame), waiting for you before you arrive. */
const WAIT_BRIEF = 'Same room, same camera position, framing, lens and light as reference image 3, the same moment a few seconds earlier: she has not seen you yet. Her head and eyes are turned toward the right side of the frame at eye level, as if watching the door for you, waiting; her hands are together in her lap (or at her waist), a little restless; her lips softly pressed together. Her eyes are open.';

const setStill = (star: Star, kind: SetKind, r: R): SystemKeyframe => {
  const [base, brief] = W[star].sets[kind];
  // A set built on another set (the dark room on the bedroom) keeps that set's ratio and camera. In 16:9, a set on
  // her night poster starts from the 16:9 night poster; the others (morning and day posters are 9:16 only) widen
  // the 9:16 set.
  // A new room (her bedroom) is widened from its 9:16 set too, so both ratios show one room.
  const onSet = base in W[star].sets;
  const heroView = /^(The same|Inside the apartment)/.test(brief) && base.endsWith('-night-9x16-poster');
  const from = onSet ? setName(star, base as SetKind, r) : r === '9x16' ? base : heroView ? base.replace('-9x16-', '-16x9-') : setName(star, kind, '9x16');
  const wide = r === '9x16' ? ' Vertical 9:16 frame, upright and level.' : from === setName(star, kind, '9x16') ? ' Horizontal 16:9 frame: the same place, camera height and light as reference image 1, seen wider so the room continues naturally to both sides.' : ' Horizontal 16:9 frame, upright and level.';
  return { name: setName(star, kind, r), star, ratio: ratioOf(r), person: false, from, brief: `${brief}${wide} ${SET_CRAFT}` };
};

export const SYSTEM_V11_KEYFRAMES: SystemKeyframe[] = (['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as Star[]).flatMap((star) => [
  ...(['9x16', '16x9'] as R[]).flatMap((r) => SET_KINDS.map((kind) => setStill(star, kind, r))),
  ...POSES.flatMap((p) => p.ratios.map((r): SystemKeyframe => ({
    name: stillName(star, p.kind, r), star, ratio: ratioOf(r), person: true, from: v1(star, r),
    camera: p.closer ? stillName(star, p.closer, r) : setName(star, p.set, r),
    closer: !!p.closer, brief: p.brief(star)
  }))),
  ...(['9x16', '16x9'] as R[]).map((r): SystemKeyframe => ({ name: stillName(star, 'promise-wait', r), star, ratio: ratioOf(r), person: true, from: v1(star, r), camera: v1(star, r), brief: WAIT_BRIEF })),
  // The morning promise, close (#67): the camera moves in on her morning still (#144), her morning home look.
  { name: stillName(star, 'pmorning-close', '9x16'), star, ratio: '9:16', person: true, from: morningStill(star, '9x16'), camera: morningStill(star, '9x16'), closer: true, photo: PHOTO[star], brief: PROMISE_MORNING[star].close }
]);

// ─────────────────────────────────────────────────────────────── clips
const LOOK = 'Photorealistic live-action footage with exactly the look, light and colour grade of the first frame, Japanese photobook style.';
const HOLD = 'Locked-off shot: no camera movement, no zoom, no cut. The place and light stay the same.';
const NEGATIVE = 'Exactly one adult woman, fully clothed throughout; the same face, hair, outfit and accessories as in the frames. Her eyes stay open except for quick natural blinks: no slow blinks, no eyes held closed, no squinting. Natural hands with five fingers each. She does not speak. No subtitles, no text, no logo, no watermark, no music, no audio.';
const LOOP = 'The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.';
const ENDS = 'Start exactly from the first frame and end exactly on the last frame; the camera and the place never change.';
const NO_PEOPLE = 'The space is empty, no people, no hands, no silhouettes.';
const STILL_CAMERA = 'Static locked-off shot, absolutely no camera movement or zoom; only gentle ambient motion.';
const STYLE = 'Photorealistic cinematic photography, deep navy blue shadows with warm light, fine film grain, natural textures, quiet mood. No text, no logos, no watermark.';
const BACK = (t: number, d: number) => `${t}-${d}s: back to exactly the first frame's pose and expression; she holds still.`;

/** Ambient motion of each set, so the loops breathe (weather, candles, lamp). */
const AMBIENT: Record<SetKind, string> = {
  dusk: 'The sunset light shifts very slightly, a light breeze stirs her hair and the nearby leaves or curtain.',
  bedroom: 'The lamp light glows steadily, the curtain stirs very slightly.',
  dark: 'The small lamp glows faintly and steadily; the faint light at the curtain edge shimmers very slightly.',
  herbday: 'The candle flames flicker gently.',
  hisbday: 'The lights twinkle softly.',
  snow: 'Snowflakes keep falling softly behind her.',
  rain: 'Raindrops keep running down the glass behind her.',
  typhoon: 'Outside, the wind gusts and the rain streaks hard across the glass; inside is calm. No lightning and no flashes: the light in the room and at the window stays steady the whole time.'
};

type Moment = { kind: string; clip: string; use: string; duration: number; lines: (star: Star) => string[]; ratios: R[] };

/** Locked loops: her still at both ends, one small action in the middle. */
const LOOPS: Moment[] = [
  { kind: 'confess-wide', clip: 'confession-wide', ratios: ['9x16', '16x9'], duration: 6, use: 'Confession (#55) wide: at sunset she waits for you, nervous; loops under her opening lines', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens, a small shy smile.',
    '1-3s: she fiddles with the cuff of her sleeve, glances to the side at eye level and back to the lens, pressing her lips together.',
    '3-4.5s: she takes one small breath, her shoulders rising and settling.',
    BACK(4.5, 6)] },
  { kind: 'confess-close', clip: 'confession-close', ratios: ['9x16'], duration: 8, use: 'Confession (#55) close: nervous, then brave — she holds your eyes while she says it; loops while she waits for your answer', lines: () => [
    '0-2s: she holds the first frame\'s pose, her lips gently pressed together, eyes on the lens.',
    '2-3.5s: her eyes flick to the side at eye level for a moment, shy, then come back to the lens.',
    '3.5-6s: she takes one quiet breath, lifts her chin a little and holds steady, brave eye contact with the lens, a small earnest smile.',
    'Around 1.5s and around 6.5s she blinks once, as fast as a real blink.',
    BACK(6, 8)] },
  { kind: 'goodnight', clip: 'sys-goodnight', ratios: ['9x16', '16x9'], duration: 6, use: 'Goodnight (#71): by the bed, the lamp low; loops under her goodnight', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens, a soft smile.',
    '1-3s: she lifts one hand beside her cheek and gives a small, gentle wave, "good night", her eyes open on the lens; she tilts her head a little.',
    '3-4.5s: she lowers her hand back into her lap.',
    BACK(4.5, 6)] },
  { kind: 'whisper', clip: 'sys-whisper', ratios: ['9x16'], duration: 8, use: 'Goodnight whisper (#71, monthly pass): she leans in to whisper at your ear; loops under her five whispers', lines: () => [
    '0-1.5s: she holds the first frame\'s pose, eyes on the lens, a tender smile.',
    '1.5-3.5s: she leans slowly in past the side of the lens, turning her head to full profile as if bringing her lips to your ear beside the camera; her cheek, ear and hair come very close to the camera, softly out of focus, while her mouth stays at the very edge of the frame, never moving toward the centre of the lens.',
    '3.5-5.5s: she stays there in profile, very close, her lips barely parted and moving softly in a whisper (never puckered, never a kiss), her eyes open.',
    '5.5-7s: she draws slowly back, her eyes returning to the lens.',
    BACK(7, 8)] },
  { kind: 'herbday-wide', clip: 'sys-herbday-wide', ratios: ['9x16', '16x9'], duration: 6, use: 'Her birthday (#61, #71) wide: the cake with lit candles; loops while you choose your gift', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    '1-3.5s: she clasps her hands under her chin, delighted, her eyes on the lens, the candlelight flickering on her face.',
    '3.5-5s: she lowers her hands back to the table.',
    BACK(5, 6)] },
  { kind: 'herbday-close', clip: 'sys-herbday-close', ratios: ['9x16'], duration: 6, use: 'Her birthday (#61, #71) close: touched, she thanks you; loops under her thanks', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    '1-3s: she gives a small, grateful nod with her hands still pressed together at her chest, her eyes staying on the lens; the candlelight flickers on her face.',
    '3-4.5s: she tilts her head a little with a soft smile.',
    BACK(4.5, 6)] },
  { kind: 'hisbday-wide', clip: 'sys-hisbday-wide', ratios: ['9x16', '16x9'], duration: 6, use: 'His birthday (#61, #71) wide: what she made ready for you; loops under her lines', lines: (s) => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    `1-4s: ${W[s].giftMotion}.`,
    BACK(4, 6)] },
  { kind: 'hisbday-close', clip: 'sys-hisbday-close', ratios: ['9x16'], duration: 6, use: 'His birthday (#61, #71) close: her wish for you; loops under her lines', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    '1-2.5s: she claps her hands softly twice in front of her chest, beaming, her eyes on the lens.',
    '2.5-4.5s: she leans a little toward the lens and back.',
    BACK(4.5, 6)] },
  { kind: 'snow-wide', clip: 'sys-first-snow-wide', ratios: ['9x16', '16x9'], duration: 6, use: 'First snow (#63, #71) wide: snow falling in her world; loops under her first line', lines: (s) => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    `1-4s: ${W[s].snowMotion}.`,
    BACK(4, 6)] },
  { kind: 'snow-close', clip: 'sys-first-snow-close', ratios: ['9x16'], duration: 6, use: 'First snow (#63, #71) close: she warms her hands; loops under her lines', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    '1-3s: she breathes softly into her cupped hands to warm them, her eyes on the lens above them.',
    '3-4.5s: she rubs her hands together gently.',
    BACK(4.5, 6)] },
  { kind: 'rain-wide', clip: 'sys-rainy-night-wide', ratios: ['9x16', '16x9'], duration: 6, use: 'Rainy night (#63, #71) wide: rain on the glass; loops under her first line', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens.',
    '1-3s: she turns her head to glance at the rain on the glass at eye level, listening, then looks back to the lens.',
    '3-4.5s: a slight tilt of her head, a gentle smile.',
    BACK(4.5, 6)] },
  { kind: 'rain-close', clip: 'sys-rainy-night-close', ratios: ['9x16'], duration: 6, use: 'Rainy night (#63, #71) close: she listens to the rain with you; loops under her lines', lines: () => [
    '0-6s: her eyes stay open and on the lens the whole time with the same calm smile, bright and attentive; she breathes softly while the rain runs down the glass behind her.',
    'Around 2s she blinks once, as fast as a real blink.',
    '2.5-4.5s: she tilts her head slightly toward the lens and back.',
    BACK(4.5, 6)] },
  { kind: 'typhoon-wide', clip: 'sys-typhoon-wide', ratios: ['9x16', '16x9'], duration: 6, use: 'Typhoon (#63, #71) wide: the storm outside, she worries about you; loops under her first line', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens, worried.',
    '1-2.5s: she glances toward the rain-lashed window at eye level, then back to the lens; one continuous shot, the room, the window and the light stay exactly the same.',
    '2.5-4.5s: she holds the phone a little tighter to her chest, her brows drawn up in concern, eyes on the lens.',
    BACK(4.5, 6)] },
  { kind: 'typhoon-close', clip: 'sys-typhoon-close', ratios: ['9x16'], duration: 6, use: 'Typhoon (#63, #71) close: "as long as you\'re safe"; loops under her lines', lines: () => [
    '0-1s: she holds the first frame\'s pose, eyes on the lens, concerned.',
    '1-3s: she gives a small, earnest nod, as if asking you to stay safe, her eyes on the lens.',
    '3-4.5s: her brows soften into a small, reassuring smile.',
    BACK(4.5, 6)] }
];

const id = (star: Star, clip: string, r: R) => `${star}-${clip}-${r}`;
const her = (star: Star, clipId: string, r: R, use: string, duration: number, loop: boolean, frames: Shot['frames'], lines: string[]): Shot =>
  ({ id: clipId, category: 'character', star, talent: star, model: 'sd25', ratio: ratioOf(r), resolution: '1080p', duration, loop, ...(loop ? { xfade: 0 } : {}), use, frames, prompt: lines.join('\n'), encode: 'hq' });

function clipsFor(star: Star): Shot[] {
  const w = W[star];
  const setOf = (kind: string) => POSES.find((p) => p.kind === kind)?.set;
  const loops = LOOPS.flatMap((m) => m.ratios.map((r) => {
    const still = stillName(star, m.kind, r);
    const set = setOf(m.kind)!;
    return her(star, id(star, m.clip, r), r, m.use, m.duration, true, { first: still, last: still },
      [LOOP, LOOK, `{WOMAN} ${w.place[set]}.`, ...m.lines(star), AMBIENT[set], HOLD, NEGATIVE]);
  }));
  const oneShots: Shot[] = [
    // Her yes (#55 accept): relief, then she steps in to hug you — the tone ceiling, shoulders-up.
    her(star, id(star, 'confession-yes', '9x16'), '9x16', 'Confession (#55) his yes: relief, then she steps in to hug you; plays once under her answer', 6, false,
      { first: stillName(star, 'confess-close', '9x16'), last: stillName(star, 'confess-hug', '9x16') }, [
        ENDS, LOOK, `{WOMAN} ${w.place.dusk}.`,
        '0-1.5s: she holds the first frame\'s pose, eyes on the lens; then her shoulders relax as she breathes out in relief and a radiant smile spreads across her face, her eyes open and on the lens.',
        '1.5-4.5s: she steps slowly toward the camera and opens her arms to hug you, coming so close that her face, shoulders and arms fill the frame, a warm glow around her.',
        '4.5-6s: she settles exactly into the last frame\'s pose and holds still, her eyes on the lens.',
        HOLD, NEGATIVE]),
    // A promise kept (#59): she waits, sees you, and ends on her v1 hero frame (the HD hero loop starts on it).
    ...(['9x16', '16x9'] as R[]).map((r) => her(star, id(star, 'sys-promise-kept', r), r, 'Promise kept (#59, #71): she was waiting for you — she turns and sees you; ends on her hero frame, cuts into her HD hero loop', 6, false,
      { first: stillName(star, 'promise-wait', r), last: v1(star, r) }, [
        ENDS, LOOK, `{WOMAN} ${w.place.hero}.`,
        '0-2s: she waits, looking toward the right side of the frame at eye level, her hands together, a little restless.',
        '2-3.5s: she notices you: her eyes and face turn to the lens and light up, eyes open and bright.',
        '3.5-6s: she settles exactly into the last frame\'s pose, framing and smile, and holds still.',
        HOLD, NEGATIVE]))
  ];
  // The lights out (#71): her bedroom, genuinely dark but for the small lamp; no one in it.
  const dark = (['9x16', '16x9'] as R[]).map((r): Shot => ({
    id: id(star, 'sys-lights-out', r), category: 'scene', star, model: 'sd25', ratio: ratioOf(r), resolution: '1080p', duration: 5, loop: true, xfade: 0,
    use: 'Goodnight / whisper (#71): the lights go out — her dark bedroom, only the small lamp glowing; loops',
    frames: { first: { still: setName(star, 'dark', r) }, last: { still: setName(star, 'dark', r) } }, encode: 'hq',
    prompt: `${w.place.dark[0].toUpperCase()}${w.place.dark.slice(1)}: a genuinely dark room, only a small lamp glowing faintly. ${AMBIENT.dark} ${NO_PEOPLE} ${STILL_CAMERA} ${STYLE}`
  }));
  const pm = PROMISE_MORNING[star];
  const promise: Shot[] = [
    her(star, id(star, 'sys-promise-kept-close', '9x16'), '9x16', 'Promise kept (#59, #71) close: the moment she sees you came as promised — relief, then warmth; loops under her last line', 6, true,
      { first: `${star}-breath-9x16`, last: `${star}-breath-9x16` },
      [LOOP, LOOK, `{WOMAN} ${w.place.hero}.`, ...PROMISE_KEPT_CLOSE, BACK(4.5, 6), HOLD, NEGATIVE]),
    ...(['9x16', '16x9'] as R[]).map((r) => her(star, id(star, 'sys-promise-morning-wide', r), r, 'The morning promise kept (#67, #71) wide: her morning, keeping what she promised; loops under her lines', 6, true,
      { first: morningStill(star, r), last: morningStill(star, r) },
      [LOOP, LOOK, `{WOMAN} ${pm.place}.`, '0-1s: she holds the first frame\'s pose, eyes on the lens.', ...(r === '16x9' && pm.wide16 ? pm.wide16 : pm.wide), BACK(4.5, 6), 'Soft morning light and gentle ambient motion (steam, curtain, dust in the sunlight).', HOLD, NEGATIVE])),
    { ...her(star, id(star, 'sys-promise-morning-close', '9x16'), '9x16', 'The morning promise kept (#67, #71) close: her promise, kept; loops under her last line', 6, true,
      { first: stillName(star, 'pmorning-close', '9x16'), last: stillName(star, 'pmorning-close', '9x16') },
      [LOOP, LOOK, `{WOMAN} ${pm.place}.`, '0-1s: she holds the first frame\'s pose, eyes on the lens.', ...pm.closeAction, BACK(4.5, 6), 'Soft morning light.', HOLD, star === 'nana' ? NEGATIVE.replace('She does not speak.', 'Her lips move softly as she reads, without sound.') : NEGATIVE]),
      ...(pm.retimeMax ? { retimeMax: pm.retimeMax } : {}) }
  ];
  return [...loops, ...oneShots, ...dark, ...promise];
}

export const SYSTEM_V11_SHOTS: Shot[] = (['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as Star[]).flatMap(clipsFor);

/** The clip families the scripts play (packages/shared/src/scenes/{system,confession}.ts). */
export const SYSTEM_V11_FAMILIES = [...new Set(SYSTEM_V11_SHOTS.map((s) => s.id.replace(/-(9x16|16x9)$/, '')))];
