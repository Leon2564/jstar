/**
 * The system scenes' names (#71), without their words: the web player asks here whether a scene id is one of them
 * before it loads the scripts (./system.ts, a chunk of its own), and the API wires the triggers by these kinds.
 * No zod, no JSON, so it costs the bundles nothing.
 */
import { STAR_IDS, type StarId } from '../domain';
import type { WeatherEvent } from '../weather';

/**
 * Every kind, most important first — the order the moment picks one in when several are open (a promise he came to
 * keep before his birthday, a birthday before the weather, the weather before goodnight).
 */
export const SYSTEM_SCENE_KINDS = ['promiseKept', 'promiseMorning', 'hisBirthday', 'herBirthday', 'firstSnow', 'typhoon', 'rainyNight', 'whisper', 'goodnight'] as const;
export type SystemSceneKind = (typeof SYSTEM_SCENE_KINDS)[number];

/** Her five goodnight whispers take turns, one a night (#71: 每位 5 句轮换). */
export const WHISPER_COUNT = 5;

const SLUG: Record<SystemSceneKind, string> = {
  promiseKept: 'promise-kept', promiseMorning: 'promise-morning', hisBirthday: 'his-birthday', herBirthday: 'her-birthday', firstSnow: 'first-snow',
  typhoon: 'typhoon', rainyNight: 'rainy-night', whisper: 'whisper', goodnight: 'goodnight'
};
const KIND_OF = new Map(Object.entries(SLUG).map(([k, v]) => [v, k as SystemSceneKind]));

/** `<kind>-<star>`, and `whisper-<star>-<n>` (n = 1…WHISPER_COUNT) for the whispers. */
export function systemSceneId(kind: SystemSceneKind, star: StarId, n?: number): string {
  return kind === 'whisper' ? `${SLUG[kind]}-${star}-${n ?? 1}` : `${SLUG[kind]}-${star}`;
}

const RE = new RegExp(`^(${Object.values(SLUG).join('|')})-(${STAR_IDS.join('|')})(?:-(\\d))?$`);
export function systemSceneOf(sceneId: string): { kind: SystemSceneKind; star: StarId; n?: number } | null {
  const m = RE.exec(sceneId);
  const kind = m ? KIND_OF.get(m[1]) : undefined;
  if (!m || !kind) return null;
  if (kind === 'whisper') {
    const n = Number(m[3]);
    return n >= 1 && n <= WHISPER_COUNT ? { kind, star: m[2] as StarId, n } : null;
  }
  return m[3] === undefined ? { kind, star: m[2] as StarId } : null;
}

/** The scene her weather message (#63) opens. */
export const weatherSceneId = (event: WeatherEvent, star: StarId): string => systemSceneId(event, star);

/**
 * What he says that is asking for goodnight (#65 intent): the classifier reads `hint`, and without a model the
 * persona service matches `words` literally. Offered only while goodnight is open, so a daytime 「おやすみ」 (a nap)
 * starts nothing.
 */
export const GOODNIGHT_CUE = {
  hint: 'He says good night to her, or that he is going to sleep now.',
  words: ['おやすみ', 'お休み', 'もう寝る', '寝るね', 'good night', 'goodnight', 'nighty night', '晚安', '要睡了', '잘 자', '잘자']
} as const;
