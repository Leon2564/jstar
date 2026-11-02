import { readVerdict, type ConfessionAnswer, type Lang, type StarId } from '@jstar/shared';
import { env } from '../env';

export interface JudgeInput { star: StarId; lang: Lang; text: string; ask: string }
export interface Judgement { answer: ConfessionAnswer; confident: boolean; source: 'agent' | 'fallback' }

/** Well inside a person's patience for her reaction; the persona service answers within its own safety timeout. */
const JUDGE_TIMEOUT_MS = 12_000;

/**
 * His answer to her confession, read by the persona service (`POST /v1/confession/judge`, apps/agent/app/confession.py),
 * which runs it past the same content boundary as chat first. Never throws: when the service is down, slow or
 * answers with anything but a well-formed confident verdict, the answer is "not yet" — she takes it gently and asks
 * again later, where a wrong yes would make them lovers (packages/shared/src/confession.ts `readVerdict`).
 */
export async function judgeConfession(input: JudgeInput, f: typeof fetch = fetch): Promise<Judgement> {
  try {
    const res = await f(`${env.AGENT_BASE_URL}/v1/confession/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AGENT_API_KEY}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS)
    });
    if (!res.ok) return { answer: 'not_yet', confident: false, source: 'fallback' };
    return { ...readVerdict(await res.json()), source: 'agent' };
  } catch {
    return { answer: 'not_yet', confident: false, source: 'fallback' };
  }
}
