/**
 * Her confession as a scene (#55): built from her system lines (#82, `lines/<star>.json` → `confession`) rather than
 * written as a script of its own, so the words live in one reviewed place. Two per talent: `confession-<star>` and
 * `confession-<star>-again`, which opens with her `retry` line when she asks a second or third time.
 *
 * Shots (tools/media/src/shots/system-v11.ts): at sunset in her own world, wide while she gathers herself
 * (`<star>-confession-wide`), close for the confession itself, nervous then brave (`<star>-confession-close`, also her
 * idle loop while he answers), and on his yes she steps in to hug him (`<star>-confession-yes`, played once). The
 * scale stays at a close shot and a hug (docs/compliance-jp.md §6). Her recorded voice (#83) comes with each text of her line file; the line with `{name}`
 * is said by her runtime voice (#73), or, when that is off, as its recorded `unnamed` version (./speech.ts).
 *
 * While the lines are drafts (native review, #84) the scripts are `demo`: startable on the test site and in demos,
 * never in production. The web loads this module only when a confession opens (scene/player.tsx), so the lines
 * stay out of the entry bundle.
 */
import { STAR_IDS, localText, type StarId } from '../domain';
import { CONFESSION_RULES } from '../rules';
import { CONFESSION_OUTCOMES, confessionSceneId } from '../confession';
import type { StarLines } from '../lines/schema';
// Only her confession lines (and whether they are still drafts), not the whole file: the web loads this module on
// its own, and named JSON imports let the bundler leave her other lines out of that chunk.
import { confession as mahiroLines, draft as mahiroDraft } from '../lines/mahiro.json';
import { confession as nanaLines, draft as nanaDraft } from '../lines/nana.json';
import { confession as unpaiLines, draft as unpaiDraft } from '../lines/unpai.json';
import { confession as aliceLines, draft as aliceDraft } from '../lines/alice.json';
import { confession as eimiLines, draft as eimiDraft } from '../lines/eimi.json';

const LINES = {
  mahiro: { confession: mahiroLines, draft: mahiroDraft }, nana: { confession: nanaLines, draft: nanaDraft },
  unpai: { confession: unpaiLines, draft: unpaiDraft }, alice: { confession: aliceLines, draft: aliceDraft },
  eimi: { confession: eimiLines, draft: eimiDraft }
} as unknown as Record<StarId, Pick<StarLines, 'confession' | 'draft'>>;
import type { SceneScript, SceneStep, SceneText } from './schema';

const TITLE: SceneText = { ja: '告白', 'zh-Hant': '告白', en: 'Her confession', ko: '고백' };
/** The memory card his yes becomes (the card is titled by the script, never by his words). */
export const CONFESSION_MEMORY_TITLE: SceneText = { ja: '告白', 'zh-Hant': '告白', en: 'The confession', ko: '고백' };
const PROMPT: SceneText = { ja: 'あなたの答えを、声で（文字でも）', 'zh-Hant': '用聲音回答她（也可以打字）', en: 'Answer her in your own voice (or type it)', ko: '당신의 대답을 목소리로 (문자로도 가능)' };
/** Long enough to find the words; after it she lets it rest, and the silence counts as no answer. */
const ANSWER_TIMEOUT_S = 300;

/** A line step for one of her texts, with her recording when it has one (#83). */
const said = (id: string, text: SceneText): SceneStep => ({ id, type: 'line', text, ...(text.voice ? { voice: text.voice } : {}) });
const lines = (prefix: string, texts: SceneText[]): SceneStep[] => texts.map((text, i) => said(`${prefix}-${i}`, text));

export function confessionScene(star: StarId, l: StarLines['confession'], again: boolean, draft: boolean): SceneScript {
  const steps: SceneStep[] = [
    { id: 'wide', type: 'clip', shot: 'wide', media: `${star}-confession-wide`, hold: 1.5 },
    ...lines('open', again ? [l.retry] : l.opening),
    { id: 'close', type: 'clip', shot: 'close', media: `${star}-confession-close`, hold: 1 },
    ...lines('confess', l.confess),
    said('ask', l.ask),
    {
      id: 'answer', type: 'input', mode: 'voice', judge: 'confession', prompt: PROMPT, timeout: ANSWER_TIMEOUT_S,
      next: 'wait-0', onTimeout: 'later-0', outcomes: { accept: 'yes', not_yet: 'wait-0', decline: 'no-0' }
    },
    // His yes: her relief, and she steps in to hug him (once, then it rests on the hug).
    { id: 'yes', type: 'clip', shot: 'close', media: `${star}-confession-yes`, hold: 1.5, loop: false },
    ...lines('yes', l.accept),
    { id: 'yes-memory', type: 'effect', affinity: CONFESSION_RULES.acceptAffinity, memory: { title: CONFESSION_MEMORY_TITLE } },
    { id: 'yes-end', type: 'end', outcome: CONFESSION_OUTCOMES.accept },
    ...lines('wait', l.notYet),
    { id: 'wait-end', type: 'end', outcome: CONFESSION_OUTCOMES.not_yet },
    ...lines('no', l.decline),
    { id: 'no-end', type: 'end', outcome: CONFESSION_OUTCOMES.decline },
    // Silence is not an answer: her gentlest line, and nothing is counted.
    said('later-0', l.notYet[0]),
    { id: 'later-end', type: 'end', outcome: 'quiet' }
  ];
  return {
    meta: {
      id: confessionSceneId(star, again), star, title: TITLE,
      trigger: { slots: [...CONFESSION_RULES.slots], stage: 'confession_ready' },
      idle: `${star}-confession-close`,
      ...(draft ? { demo: true } : {})
    },
    steps
  };
}

/** Every confession scene, first and again, for all five. */
export const CONFESSION_SCENES: SceneScript[] = STAR_IDS.flatMap((star) =>
  [false, true].map((again) => confessionScene(star, LINES[star].confession, again, LINES[star].draft)));

const BY_ID = new Map(CONFESSION_SCENES.map((s) => [s.meta.id, s]));
export const confessionSceneById = (id: string): SceneScript | undefined => BY_ID.get(id);

/** Her hint on her confession day before 17:00 (#55): "tonight, there's something I want to tell you". */
export const confessionHint = (star: StarId, lang: string): string => localText(LINES[star].confession.hint, lang);
