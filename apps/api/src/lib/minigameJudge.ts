import { readMinigameCall, type JudgedMinigame, type MinigameCall } from '@jstar/shared/scenes';
import type { Lang, StarId } from '@jstar/shared';
import { env } from '../env';

export interface MinigameJudgeInput {
  star: StarId;
  lang: Lang;
  kind: JudgedMinigame;
  /** His answer. */
  text: string;
  /** What she said before it (奈々's reading, for praise), newest last. */
  context?: string;
  /** The prompt he answers (えいみ's ōgiri theme). */
  prompt?: string;
  /** ōgiri: the top of the scale. */
  scale?: number;
  /**
   * ōgiri: what she calls him, in his language (#56) — her remark says it verbatim (H2: ケンタ, never 健太 in zh-Hant).
   * Absent when she has no name for him.
   */
  callName?: string;
}

/** Her reaction waits on this; the persona service keeps to its own, shorter model timeout. */
const JUDGE_TIMEOUT_MS = 10_000;

/**
 * His answer to a mini-game (#67–#70), read by the persona service (`POST /v1/scene/judge`,
 * apps/agent/app/minigames.py), which runs the content boundary first. Never throws: when the service is down, slow
 * or answers with anything malformed, the answer is null, which packages/shared/src/scenes/minigames.ts `judgeAnswer`
 * reads safely (praise generic, ōgiri mid-scale, bargain → her counter-offer, a comment acknowledged but not read back).
 */
export async function judgeMinigame(input: MinigameJudgeInput, f: typeof fetch = fetch): Promise<MinigameCall | null> {
  try {
    const res = await f(`${env.AGENT_BASE_URL}/v1/scene/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AGENT_API_KEY}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    return readMinigameCall(input.kind, await res.json(), input.scale);
  } catch {
    return null;
  }
}
