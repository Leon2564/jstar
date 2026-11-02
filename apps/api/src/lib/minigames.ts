import type { FastifyInstance } from 'fastify';
import { fitSceneReply, localText, type Lang, type StarId } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import {
  heardBefore, judgeAnswer, ogiriConfig, pickPrompt,
  type GameTables, type Judged, type JudgedMinigame, type MinigameStep, type RunState, type SceneScript
} from '@jstar/shared/scenes';
import { judgeMinigame } from './minigameJudge';
import { resolveCallName } from './bond';
import type { UserRow } from '../db/types';

/**
 * The five scenes' mini-games on the server (#66–#70; rules in packages/shared/src/scenes/minigames.ts): her
 * rock-paper-scissors hand from the platform's CSPRNG, えいみ's ōgiri prompts, and his answers judged by the persona
 * service and turned into branch, lines and reward with her line file (lines/<star>.json, drafts until #84).
 */

/** Uniform in [0, 1), from the CSPRNG: her hand cannot be predicted from earlier ones, and he only ever sends his own. */
export const secureRandom = (): number => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

/** Her lines the games read: アリス's bargaining tree and in-character refusals, うんぱい's comment reactions. */
export function gameTables(star: StarId): GameTables {
  const l = LINES[star];
  return {
    bargain: l.bargain ?? null,
    refusals: l.refuse.filter((r) => r.kind === 'line').map((r) => r.text),
    danmaku: l.danmaku ?? null
  };
}

/** The engine's prompt hook: an ōgiri theme from her bank (#82, `ogiri`), none asked twice in one run. */
export const promptFor = (star: StarId) => (step: MinigameStep, state: RunState) => {
  if (step.kind !== 'ogiri') return null;
  const p = pickPrompt(LINES[star].ogiri ?? [], Object.values(state.prompts ?? {}), secureRandom);
  return p ? { id: p.id, text: p.text } : null;
};

/**
 * What she calls him in `lang`, for her ōgiri remark (H2): the only judged game with words of hers in it. Best effort —
 * without it the remark simply names nobody.
 */
async function callNameFor(app: FastifyInstance, user: Pick<UserRow, 'id' | 'nickname'>, star: StarId, lang: Lang): Promise<string | null> {
  try {
    const stage = (await app.repos.relationship.get(user.id, star))?.stage ?? 'new';
    return (await resolveCallName(app.repos, user, star, stage, undefined, lang)).callName;
  } catch {
    return null;
  }
}

/** His answer to the judged game the run waits on, decided: the persona service's reading, or the safe one. */
export async function judgeGame(
  app: FastifyInstance, script: SceneScript, state: RunState, step: MinigameStep, text: string, lang: Lang, user?: Pick<UserRow, 'id' | 'nickname'>
): Promise<Judged> {
  const star = script.meta.star;
  const kind = step.kind as JudgedMinigame;
  const promptId = state.prompts?.[step.id];
  const prompt = promptId ? LINES[star].ogiri?.find((p) => p.id === promptId) : undefined;
  const callName = kind === 'ogiri' && user ? await callNameFor(app, user, star, lang) : null;
  const call = await judgeMinigame({
    star, lang, kind, text: text.trim().slice(0, 500),
    ...(kind === 'praise' ? { context: heardBefore(script, state.path ?? [], lang) } : {}),
    ...(prompt ? { prompt: localText(prompt.text, lang) } : {}),
    ...(kind === 'ogiri' ? { scale: ogiriConfig(step).of } : {}),
    ...(callName ? { callName } : {})
  });
  if (!call) app.log.warn({ star, kind, sceneId: script.meta.id }, 'minigame_judge_fallback');
  // M4: her remark fits three subtitle lines in his language.
  const fitted = call?.kind === 'ogiri' && call.comment ? { ...call, comment: fitSceneReply(call.comment, lang) } : call;
  return judgeAnswer(step, text, fitted, gameTables(star));
}
