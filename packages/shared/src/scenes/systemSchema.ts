import { z } from 'zod';
import { STAR_IDS } from '../domain';
import { zSceneText, zStepId } from './schema';
import { SYSTEM_SCENE_KINDS } from './systemIds';

/**
 * The shape of the system pack's own words (`lines/system.json`, #71): checked by the shared tests and again when the API
 * boots, like every script. Japanese is what she says; zh-Hant and en are subtitles.
 */
const zChoices = z.array(z.object({ id: zStepId, label: zSceneText }).strict()).min(2).max(4);
const zTalent = z.object({
  herBirthday: z.object({ open: z.array(zSceneText).min(1).max(3), thanks: zSceneText }).strict(),
  hisBirthday: z.object({ open: zSceneText, gift: zSceneText, wish: zSceneText }).strict(),
  promiseKept: z.object({ open: zSceneText, close: zSceneText }).strict(),
  /** The morning a promise of hers was about (#67 奈々's tea and the rest of the story): kept in the morning light. */
  promiseMorning: z.object({ open: z.array(zSceneText).min(1).max(3), close: zSceneText }).strict()
}).strict();

export const zSystemLines = z.object({
  draft: z.boolean(),
  titles: z.object(Object.fromEntries(SYSTEM_SCENE_KINDS.map((k) => [k, zSceneText])) as Record<(typeof SYSTEM_SCENE_KINDS)[number], typeof zSceneText>).strict(),
  memories: z.object({ firstSnow: zSceneText, herBirthday: zSceneText, hisBirthday: zSceneText }).strict(),
  prompts: z.object({ herBirthday: zSceneText }).strict(),
  choices: z.object(Object.fromEntries(SYSTEM_SCENE_KINDS.map((k) => [k, zChoices])) as Record<(typeof SYSTEM_SCENE_KINDS)[number], typeof zChoices>).strict(),
  talents: z.object(Object.fromEntries(STAR_IDS.map((s) => [s, zTalent])) as Record<(typeof STAR_IDS)[number], typeof zTalent>).strict()
}).strict();
