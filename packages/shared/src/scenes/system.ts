/**
 * The system scene pack (#71): small moments all five share, built from her system lines (#82, `lines/<star>.json`:
 * goodnight whispers, weather events) and from the pack's own words (`lines/system.json`: his choices, the two
 * birthdays, the promise she keeps), rather than written as one script per talent — so the words live in reviewed
 * places, and a moment needs no footage of its own.
 *
 * - goodnight: late on his clock, she offers it; he can also just say 「おやすみ」 (#65). With the monthly pass it is
 *   her whisper at his ear (five in turn, one a night); without, her plain goodnight. Then the lights go out.
 * - first snow / typhoon / rainy night: her weather message (#63) names its scene; she says all three of her lines
 *   for it (the message was one of them), he answers, and the first snow becomes a memory card.
 * - her birthday / his birthday (#61): wide, the gift, close for her thanks (or her wish), a memory card.
 * - a promise kept (#59): a promise of kind `scene` that names no scene of its own opens here.
 * - a morning promise kept (#67): a promise whose scene is this one (`promise-morning-<star>`, named by the evening
 *   scene that made it, e.g. 奈々's 「明日の朝、お茶を淹れて続きを読む」) opens in her morning room instead of replaying
 *   the evening: the room in the morning light, then her, keeping it.
 *
 * Sound (#82, ./audio.ts, SYSTEM_AUDIO): the warm evening loop for the birthdays and a kept promise, the night loop for
 * goodnight, the whispers and the weather, with the rain or the snow at her window (a typhoon is her storm, no music);
 * when the lights go out, so does the music.
 *
 * Footage (tools/media/src/shots/system-v11.ts, `<star>-sys-<moment>`, #55/#71): goodnight is her by the bed with the
 * lamp low; first snow, a rainy night and a typhoon are her window in her own world, wide then close; the whisper her leaning in, in profile, to his ear, and the lights out her bedroom genuinely dark but for a small lamp,
 * no one in it. A promise kept is her waiting until she sees him, cutting into her HD hero loop, then close, relieved
 * and warm. Her birthday is the cake and candles, his what she made ready for him, wide then close. The morning promise
 * opens on her room in the morning light (`<star>-morning`), then her in her morning look keeping it, wide then close.
 * Scale: a whisper
 * at the ear at most — tender, never sexual (docs/compliance-jp.md §6). Her recorded voice (#83) comes with each text
 * of her line files.
 *
 * While any of the words are drafts (native review, #84) the scripts are `demo`: startable on the test site and in
 * demos, never in production. The web loads this module only when one of them opens (scene/player.tsx).
 */
import { STAR_IDS, type StarId } from '../domain';
import type { CalendarEventKind } from '../calendar';
import { herLocalClock } from '../herMessages';
import { inPromiseWindow, type PromiseKind } from '../promises';
import { PROMISE_RULES, SYSTEM_SCENE_RULES, accessOpen } from '../rules';
import type { WeatherEvent } from '../weather';
import type { StarLines } from '../lines/schema';
// Only her goodnight and weather lines (and whether they are drafts), not the whole file: named JSON imports let the
// bundler leave her other lines out of this chunk.
import { goodnight as mahiroGoodnight, weather as mahiroWeather, draft as mahiroDraft } from '../lines/mahiro.json';
import { goodnight as nanaGoodnight, weather as nanaWeather, draft as nanaDraft } from '../lines/nana.json';
import { goodnight as unpaiGoodnight, weather as unpaiWeather, draft as unpaiDraft } from '../lines/unpai.json';
import { goodnight as aliceGoodnight, weather as aliceWeather, draft as aliceDraft } from '../lines/alice.json';
import { goodnight as eimiGoodnight, weather as eimiWeather, draft as eimiDraft } from '../lines/eimi.json';
import systemLines from '../lines/system.json';
import { SYSTEM_SCENE_KINDS, WHISPER_COUNT, systemSceneId, systemSceneOf, type SystemSceneKind } from './systemIds';
import type { ChoiceStep, SceneMeta, SceneScript, SceneStep, SceneText, Slot } from './schema';

export * from './systemIds';

type HerLines = Pick<StarLines, 'goodnight' | 'weather' | 'draft'>;
const HERS = {
  mahiro: { goodnight: mahiroGoodnight, weather: mahiroWeather, draft: mahiroDraft },
  nana: { goodnight: nanaGoodnight, weather: nanaWeather, draft: nanaDraft },
  unpai: { goodnight: unpaiGoodnight, weather: unpaiWeather, draft: unpaiDraft },
  alice: { goodnight: aliceGoodnight, weather: aliceWeather, draft: aliceDraft },
  eimi: { goodnight: eimiGoodnight, weather: eimiWeather, draft: eimiDraft }
} as unknown as Record<StarId, HerLines>;

export interface SystemChoice { id: string; label: SceneText }
/** The pack's own words (`lines/system.json`); its shape is checked by ./systemSchema.ts `zSystemLines`. */
export interface SystemLines {
  /** True until native review (#84) signs them off. */
  draft: boolean;
  titles: Record<SystemSceneKind, SceneText>;
  memories: Record<'firstSnow' | 'herBirthday' | 'hisBirthday', SceneText>;
  prompts: { herBirthday: SceneText };
  /** His answers, per kind (the same words whoever she is). */
  choices: Record<SystemSceneKind, SystemChoice[]>;
  /** Her words for the moments her #82 lines do not cover yet. */
  talents: Record<StarId, {
    herBirthday: { open: SceneText[]; thanks: SceneText };
    hisBirthday: { open: SceneText; gift: SceneText; wish: SceneText };
    promiseKept: { open: SceneText; close: SceneText };
    promiseMorning: { open: SceneText[]; close: SceneText };
  }>;
}
export const SYSTEM_LINES = systemLines as unknown as SystemLines;

const ALL_SLOTS: Slot[] = ['morning', 'day', 'evening', 'night'];
const A = SYSTEM_SCENE_RULES.affinity;

/** A cut; `once`: played once, resting on its last frame (it does not loop). */
const clip = (id: string, shot: 'wide' | 'close' | 'empty', media: string, hold: number, o: { music?: 'none'; once?: boolean } = {}): SceneStep =>
  ({ id, type: 'clip', shot, media, hold, ...(o.once ? { loop: false } : {}), ...(o.music ? { music: o.music } : {}) });
/** Her line, with her recording when it has one (#83). */
const line = (id: string, text: SceneText): SceneStep => ({ id, type: 'line', text, ...(text.voice ? { voice: text.voice } : {}) });
const end = (outcome: string): SceneStep => ({ id: 'end', type: 'end', outcome });

/** His answer: every option is worth the same (a moment, not a test), and silence carries on to `onTimeout`. */
function answer(l: SystemLines, kind: SystemSceneKind, next: (option: string) => string, affinity: number, extra: Partial<ChoiceStep> = {}): SceneStep {
  return {
    id: 'answer', type: 'choice',
    options: l.choices[kind].map((o) => ({ id: o.id, label: o.label, next: next(o.id), effect: { affinity } })),
    ...extra
  } as SceneStep;
}

/** What each moment sounds like (#82). */
export const SYSTEM_AUDIO: Record<SystemSceneKind, NonNullable<SceneMeta['audio']>> = {
  promiseKept: { bgm: 'bgm/home-evening' },
  // No morning loop is made yet (#82): her warm home theme carries the tea and the reading.
  promiseMorning: { bgm: 'bgm/home-evening' },
  hisBirthday: { bgm: 'bgm/home-evening' },
  herBirthday: { bgm: 'bgm/home-evening' },
  firstSnow: { bgm: 'bgm/night', ambience: 'snow' },
  typhoon: { ambience: 'storm' },
  rainyNight: { bgm: 'bgm/night', ambience: 'rain' },
  whisper: { bgm: 'bgm/night' },
  goodnight: { bgm: 'bgm/night' }
};

function meta(kind: SystemSceneKind, star: StarId, draft: boolean, idle: string, opts: { n?: number; slots?: Slot[]; l: SystemLines }): SceneMeta {
  return {
    id: systemSceneId(kind, star, opts.n), star, title: opts.l.titles[kind],
    trigger: { slots: opts.slots ?? ALL_SLOTS },
    idle,
    audio: SYSTEM_AUDIO[kind],
    ...(draft ? { demo: true } : {})
  };
}

/** One talent's pack. `her`: her #82 lines; `l`: the pack's own words. Either being a draft makes every scene demo-only. */
export function systemScenesFor(star: StarId, her: HerLines = HERS[star], l: SystemLines = SYSTEM_LINES): SceneScript[] {
  const draft = !!(her.draft || l.draft);
  const t = l.talents[star];
  const sys = (moment: string) => `${star}-sys-${moment}`;
  // Her bedroom with the lights out: dark but for a small lamp, no one in it.
  const dark = sys('lights-out');
  const m = (kind: SystemSceneKind, idle: string, opts: { n?: number; slots?: Slot[] } = {}) => meta(kind, star, draft, idle, { ...opts, l });

  const weather = (kind: WeatherEvent, slots?: Slot[]): SceneScript => {
    const said = her.weather[kind];
    // Her own clips of it (`<star>-sys-first-snow-wide`, …): the id's slug, as in `first-snow-<star>`.
    const slug = systemSceneId(kind, star).slice(0, -(star.length + 1));
    return {
      meta: m(kind, sys(`${slug}-wide`), { slots }),
      steps: [
        clip('wide', 'wide', sys(`${slug}-wide`), 1.5),
        line('open', said[0]),
        answer(l, kind, () => 'close', A.weather, { timeout: 45, onTimeout: 'close' }),
        clip('close', 'close', sys(`${slug}-close`), 1),
        line('more-0', said[1]),
        line('more-1', said[2]),
        ...(kind === 'firstSnow' ? [{ id: 'memory', type: 'effect', memory: { title: l.memories.firstSnow } } as SceneStep] : []),
        end('complete')
      ]
    };
  };

  const whisper = (n: number): SceneScript => ({
    meta: m('whisper', sys('whisper'), { n }),
    steps: [
      clip('close', 'close', sys('whisper'), 1),
      line('whisper', her.goodnight.whisper[n - 1]),
      // "Just a little longer": she whispers once more — the next of her five.
      answer(l, 'whisper', (o) => (o === 'stay' ? 'more' : 'lights'), A.whisper, { timeout: 30, onTimeout: 'lights' }),
      line('more', her.goodnight.whisper[n % WHISPER_COUNT]),
      clip('lights', 'empty', dark, 2.5, { music: 'none' }),
      end('goodnight')
    ]
  });

  return [
    {
      // She waits for him, sees him, and ends on her v1 hero frame (#59): her HD hero loop starts on that very frame,
      // so the cut into it is seamless; she speaks once she has seen him.
      meta: m('promiseKept', `${star}-herohd`),
      steps: [
        clip('wide', 'wide', sys('promise-kept'), 4, { once: true }),
        line('open', t.promiseKept.open),
        clip('room', 'wide', `${star}-herohd`, 0),
        answer(l, 'promiseKept', () => 'close', A.promiseKept, { timeout: 45, onTimeout: 'close' }),
        // Close: relief, then warmth — she really came (her own room, the keyframe her close loop opens on).
        clip('close', 'close', sys('promise-kept-close'), 1),
        line('after', t.promiseKept.close),
        end('complete')
      ]
    },
    {
      // The morning she promised (#67): her room in the morning light first (an empty shot), then her in her morning
      // look keeping it (奈々: the tea, then the rest of the story), then close.
      meta: m('promiseMorning', sys('promise-morning-wide'), { slots: ['morning', 'day'] }),
      steps: [
        clip('room', 'empty', `${star}-morning`, 1.8),
        clip('wide', 'wide', sys('promise-morning-wide'), 1.5),
        ...t.promiseMorning.open.map((text, i) => line(`open-${i}`, text)),
        answer(l, 'promiseMorning', () => 'close', A.promiseKept, { timeout: 45, onTimeout: 'close' }),
        clip('close', 'close', sys('promise-morning-close'), 1),
        line('after', t.promiseMorning.close),
        end('complete')
      ]
    },
    {
      meta: m('hisBirthday', sys('hisbday-wide')),
      steps: [
        clip('wide', 'wide', sys('hisbday-wide'), 1.5),
        line('open', t.hisBirthday.open),
        line('gift', t.hisBirthday.gift),
        answer(l, 'hisBirthday', () => 'close', A.birthday, { timeout: 60, onTimeout: 'close' }),
        clip('close', 'close', sys('hisbday-close'), 1),
        line('wish', t.hisBirthday.wish),
        { id: 'memory', type: 'effect', memory: { title: l.memories.hisBirthday } },
        end('complete')
      ]
    },
    {
      meta: m('herBirthday', sys('herbday-wide')),
      steps: [
        clip('wide', 'wide', sys('herbday-wide'), 1.5),
        ...t.herBirthday.open.map((text, i) => line(`open-${i}`, text)),
        // The gift is his to give: no countdown decides it for him.
        answer(l, 'herBirthday', () => 'close', A.birthday, { prompt: l.prompts.herBirthday }),
        clip('close', 'close', sys('herbday-close'), 1),
        line('thanks', t.herBirthday.thanks),
        { id: 'memory', type: 'effect', memory: { title: l.memories.herBirthday } },
        end('complete')
      ]
    },
    weather('firstSnow'),
    weather('typhoon'),
    // Her rainy-night message goes out after dark (#63); the scene belongs to the evening and the night too.
    weather('rainyNight', ['evening', 'night']),
    ...Array.from({ length: WHISPER_COUNT }, (_, i) => whisper(i + 1)),
    {
      meta: m('goodnight', sys('goodnight')),
      steps: [
        clip('wide', 'wide', sys('goodnight'), 1.5),
        line('plain', her.goodnight.plain),
        answer(l, 'goodnight', () => 'lights', A.goodnight, { timeout: 30, onTimeout: 'lights' }),
        clip('lights', 'empty', dark, 2.5, { music: 'none' }),
        end('goodnight')
      ]
    }
  ];
}

/** Every system scene of all five, each talent's in SYSTEM_SCENE_KINDS order. */
export const SYSTEM_SCENES: SceneScript[] = STAR_IDS.flatMap((star) => systemScenesFor(star));

const BY_ID = new Map(SYSTEM_SCENES.map((s) => [s.meta.id, s]));
export const systemSceneById = (id: string): SceneScript | undefined => BY_ID.get(id);

// ---------------------------------------------------------------- when each one opens

const HOUR = 3_600_000;

/** Late on his clock (SYSTEM_SCENE_RULES.goodnightHours; users.tz, JST when unknown). */
export function goodnightTime(now: number, tz?: string | null): boolean {
  const h = Math.floor(herLocalClock(now, tz).minutes / 60);
  const { from, to } = SYSTEM_SCENE_RULES.goodnightHours;
  return h >= from || h < to;
}

/** Tonight's whisper, 1…WHISPER_COUNT. A night belongs to the evening it began on, so 01:00 keeps the 23:00 whisper. */
export function whisperOfNight(now: number, tz?: string | null): number {
  const day = herLocalClock(now - SYSTEM_SCENE_RULES.goodnightHours.to * HOUR, tz).day;
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return (((n % WHISPER_COUNT) + WHISPER_COUNT) % WHISPER_COUNT) + 1;
}

type PromiseFacts = { kind: PromiseKind; sceneId: string | null; status: string; dueAt: string; keptAt: string | null };

/**
 * The system scene a promise of hers opens now (#59), if any: he came to keep it — open within its window, or kept
 * within the last window (her greeting or her inbox line may have kept it a moment before he entered). A promise of
 * kind `scene` naming no scene opens `promiseKept`; one naming her morning (`promise-morning-<star>`, #67) opens
 * `promiseMorning`. Any other (a scene of its own, a wake-up, a message) opens none here.
 */
export function promisePayoff(p: PromiseFacts | null, now: number): 'promiseKept' | 'promiseMorning' | null {
  // N-64: every promise with her he comes to keep is kept in her room — a scene, one made in chat (kind `free`), one of
  // her suggestions (a message she said she would send, too: he came for it) — except her wake-up, which her alarm keeps.
  if (!p || p.kind === 'wakeup') return null;
  const kind = !p.sceneId ? 'promiseKept' : systemSceneOf(p.sceneId)?.kind === 'promiseMorning' ? 'promiseMorning' : null;
  if (!kind) return null;
  const due = p.status === 'open' ? inPromiseWindow(p.dueAt, now) : p.status === 'kept' && !!p.keptAt && now - Date.parse(p.keptAt) <= PROMISE_RULES.windowMs;
  return due ? kind : null;
}

/** A promise that opens the promise-kept scene (#59): `promisePayoff` is `promiseKept`. */
export const promiseOpensScene = (p: PromiseFacts | null, now: number): boolean => promisePayoff(p, now) === 'promiseKept';

/** What the API knows about him and her at this moment. */
export interface SystemFacts {
  star: StarId;
  now: number;
  /** His zone (users.tz) and his monthly pass (users.passUntil). */
  tz?: string | null;
  passUntil?: string | null;
  /** Today with her (calendar.ts eventsOn): her birthday only once confirmed, or in demo mode (#61). */
  calendar: readonly CalendarEventKind[];
  /** Her weather messages that reached him within SYSTEM_SCENE_RULES.weatherSceneMs (#63). */
  weather: readonly WeatherEvent[];
  /** promiseOpensScene for his latest promise with her. */
  promiseKept: boolean;
  /** promisePayoff is `promiseMorning` for his latest promise with her (#67). */
  promiseMorning?: boolean;
}

/**
 * The system scenes of hers that are open for him now, most important first. Only these may be offered, asked for
 * in chat or started; the scripts' own conditions (the hour of a rainy night) and whether the mode may play them at
 * all (drafts, demo) are checked on top, as for every scene.
 */
export function openSystemScenes(f: SystemFacts): string[] {
  const open = new Set<SystemSceneKind>();
  if (f.promiseKept) open.add('promiseKept');
  if (f.promiseMorning) open.add('promiseMorning');
  if (f.calendar.includes('hisBirthday')) open.add('hisBirthday');
  if (f.calendar.includes('herBirthday')) open.add('herBirthday');
  for (const w of f.weather) open.add(w);
  if (goodnightTime(f.now, f.tz)) open.add(accessOpen('nightWhisper', f.passUntil, f.now) ? 'whisper' : 'goodnight');
  return SYSTEM_SCENE_KINDS.filter((k) => open.has(k)).map((k) => systemSceneId(k, f.star, k === 'whisper' ? whisperOfNight(f.now, f.tz) : undefined));
}
