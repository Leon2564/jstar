import { z } from 'zod';
import { STAR_IDS } from '../domain';
import { RELATIONSHIP_STAGES } from '../relationship';
import { DATE_RULES } from '../rules';
import { GIFT_IDS } from '../gifts';
import { MINIGAMES, RPS_HANDS, SCENE_VARS, SHOTS, SLOTS, WEATHERS } from './constants';
import { isInteractive, targetsOf } from './graph';
import { AMBIENCES, MUSIC_IDS } from './audio';

export { MINIGAMES, RPS_HANDS, SCENE_VARS, SHOTS, SLOTS, WEATHERS, isInteractive, targetsOf };

/**
 * Scene script format (#64). One file per scene at `scenes/<star>/<id>.json`, written by the content workstream (#82).
 * A scene is a list of steps played in order; `next` jumps (branching). Clips, lines and effects play by themselves,
 * choices / inputs / mini-games wait for him, `end` closes the run.
 *
 * Japanese is what she says; zh-Hant, en and ko are subtitles. Scale stays at "sensual, never explicit"
 * (docs/compliance-jp.md §6): at most a close shot, whispering at the ear, a hug.
 */

const nonEmpty = z.string().trim().min(1).max(400);
/** A recorded file under /voice/ (her cloned voice, #21 / #83). */
export const zVoicePath = z.string().regex(/^\/voice\/[a-z0-9/_-]+\.(mp3|m4a|ogg)$/);
/**
 * One text in every language. `ko` (owner, 2026-09-28) is written for every shipped scene and line text — the shared
 * tests check it — but stays optional in the type: a text the server makes on the fly (her free-talk reply, an ōgiri
 * remark) is in his language only, and a reader without `ko` falls back to English (domain.ts `localText`).
 * `voice`: her recording of `ja`, on the texts she speaks in her line files (#83); builders copy it to the line step.
 */
const zTextBody = { ja: nonEmpty, 'zh-Hant': nonEmpty, en: nonEmpty, ko: nonEmpty.optional(), voice: zVoicePath.optional() };
/**
 * A text with `{name}` (his name, #56) can only be voiced by her runtime voice (#73). `unnamed` is the same moment
 * said without his name, recorded ahead (#83): played when the runtime voice is off, so the moment keeps her voice
 * (scenes/speech.ts `lineToSay`). Only on `{name}` texts, never containing it (packages/shared/tests/lines.test.ts).
 */
export const zSceneText = z.object({ ...zTextBody, unnamed: z.object(zTextBody).optional() });
export const zStepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'invalid_step_id');
export const zSceneId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'invalid_scene_id');

/**
 * What a step or a choice grants. Only the server applies it (the client just shows it); never negative, so leaving
 * or timing out can never cost him anything.
 */
export const zEffectBody = z.object({
  affinity: z.number().int().min(0).max(100).optional(),
  /** Variant-card XP (#75): paid to the scene's `trigger.variantCard` when that card is a variant (VARIANT_RULES.sceneEndXp at the end, by convention). */
  variantXp: z.number().int().min(0).max(1000).optional(),
  /** A memory card, titled by the script (never by his words). */
  memory: z.object({ title: zSceneText }).optional(),
  /**
   * A promise she makes (#59): due relative to now, "+12h" / "+1d". `kind`: `scene` (default) is kept by coming back
   * to her; `wakeup` is her 「明日の朝、起こしてあげる」 (#57, #66) — the home turns it into an alarm proposal, and her
   * wake-up keeps it. `scene`: the scene that keeps it when it comes (a morning payoff, #67); default: this scene.
   */
  promise: z.object({
    text: zSceneText, due: z.string().regex(/^\+\d{1,3}[hd]$/, 'invalid_due'),
    kind: z.enum(['scene', 'wakeup']).optional(), scene: zSceneId.optional()
  }).strict().optional(),
  /**
   * Starts the date countdown shown at the top; 0 clears it. `add`: lengthens the running countdown instead (the
   * date's extension, #69), or starts one when none runs. Capped at DATE_RULES.maxTimerSeconds (#69 needs 40 minutes).
   */
  /**
   * A countdown (#69). `onEnd`: the step the run jumps to the moment it runs out (her plea and the extend choice),
   * wherever he is in the scene — once; after a paid extension the run ends on its cap instead.
   */
  timer: z.object({ seconds: z.number().int().min(0).max(DATE_RULES.maxTimerSeconds), add: z.boolean().optional(), onEnd: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional() }).strict().optional(),
  /**
   * The live-stream overlay (#68 うんぱい): true puts it up — LIVE, one viewer, his comments flowing across; false takes
   * it down (下播): from here on it is just the two of them. Stays as set until another effect changes it.
   */
  live: z.boolean().optional()
}).strict();

const base = { id: zStepId, next: zStepId.optional() };

const zMedia = z.string().regex(/^[a-z0-9-]{3,80}$/);
export const zClipStep = z.object({
  ...base, type: z.literal('clip'), shot: z.enum(SHOTS),
  /** A media id from the web catalogue (`mahiro-hero-9x16`) or a family (`mahiro-hero`) played in the screen's orientation. */
  media: zMedia,
  /** Seconds to stay on this clip before the next step; 0 = carry on while it plays. */
  hold: z.number().min(0).max(60).optional(),
  loop: z.boolean().optional(),
  /**
   * The music from this cut on (#82, ./audio.ts): a BGM loop or a piece (アリス's piano on the keys shot, うんぱい's song
   * as she hands over the earphone), or `none` for silence. A piece that does not loop gives way to the scene's
   * `meta.audio.bgm` when it ends. Missing = the music carries on.
   */
  music: z.union([z.enum(MUSIC_IDS), z.literal('none')]).optional(),
  /**
   * The same shot filmed for a moment (SCENE_VARS): the first whose `when` holds for the run is played instead —
   * `variant`: he owns her variant card, so her reward outfit is that card's footage (#70, `<star>-variant-*`, #81).
   * The engine swaps it in and keeps `media` as the beat's `fallback`, so a player without that clip yet (or a preview
   * standing in for it) cuts to the ordinary shot instead.
   */
  variants: z.array(z.object({ when: z.enum(SCENE_VARS), media: zMedia }).strict()).min(1).max(4).optional(),
  /** Set by the engine on a swapped clip: the shot as written, for a player that does not have `media`. */
  fallback: zMedia.optional()
}).strict();

export const zLineStep = z.object({
  ...base, type: z.literal('line'), text: zSceneText,
  /** A recorded file under /voice/, or `tts: true` for her runtime voice (#73). Neither = subtitle only. */
  voice: zVoicePath.optional(),
  tts: z.boolean().optional(),
  /** Set by the server on her free-talk reply: the text came from the persona service, not the script. */
  agent: z.boolean().optional(),
  /**
   * The same line written for a moment (#63 script variables, SCENE_VARS): the first whose `when` holds for the run
   * replaces `text` (アリス's refusal in a heatwave, #69). The engine swaps it in, so the player only sees `text`.
   */
  variants: z.array(z.object({ when: z.enum(SCENE_VARS), text: zSceneText }).strict()).min(1).max(4).optional()
}).strict().refine((s) => !(s.voice && s.tts), 'voice_or_tts');

/**
 * `pay: "extend"`: the option is the paid extension of #74 (アリス's 「30分延長する」, #69). Choosing it spends
 * VOICE_RULES.extendCostPoints once through the voice ledger (and adds the minutes to his voice time) before the run
 * moves on; without the points, or past today's extensions, the run stays where it is (402 / 409) and he can pick the
 * other option. Its effect must lengthen the date by exactly DATE_RULES.extendMinutes (sceneProblems).
 */
/**
 * `gift` (#68, #77): the option is a real gift bought with points, as from the gift sheet — a fixed item, or `pick`:
 * he picks one of the twenty in the sheet. The API spends the points (daily cap, taste, her XP: exactly as
 * `POST /v1/gift`) in the same step that moves the run, and she reacts to what he gave before the scene goes on.
 * Without the points or past today's gifts the run stays where it is (402 / 409) and he can pick another option; the
 * gift's XP is its reward, so the option carries no affinity of its own (sceneProblems).
 */
export const zChoiceOption = z.object({
  id: zStepId, label: zSceneText, next: zStepId, effect: zEffectBody.optional(), pay: z.literal('extend').optional(),
  gift: z.union([z.enum(GIFT_IDS), z.literal('pick')]).optional()
}).strict();
export const zChoiceStep = z.object({
  ...base, type: z.literal('choice'), prompt: zSceneText.optional(),
  options: z.array(zChoiceOption).min(2).max(4),
  /** Seconds before `onTimeout` is taken (shown as the countdown). */
  timeout: z.number().int().min(5).max(300).optional(),
  onTimeout: zStepId.optional()
}).strict().refine((s) => (s.timeout === undefined) === (s.onTimeout === undefined), 'timeout_needs_target');

/**
 * Where free talk may turn (#65): the persona service reads `hint` (for the model, never shown) and may answer with
 * `directive { jumpTo: to }`; `words` are literal cues for when no model is running (stub backend, a failed
 * classifier). Only these targets are honoured, so an agent can never skip a scene to its rewards.
 */
export const zFreeJump = z.object({
  to: zStepId,
  hint: z.string().trim().min(1).max(200),
  words: z.array(z.string().trim().min(1).max(20)).max(20).optional()
}).strict();

export const zInputStep = z.object({
  ...base, type: z.literal('input'),
  /** voice (#72; text until then), text (kept on the run), free (handed to the chat path, her reply becomes a line). */
  mode: z.enum(['voice', 'text', 'free']), prompt: zSceneText.optional(),
  timeout: z.number().int().min(5).max(300), next: zStepId, onTimeout: zStepId.optional(),
  /** Free talk only: the other ways the conversation may go (#65). */
  jumps: z.array(zFreeJump).min(1).max(6).optional(),
  /**
   * His answer is judged on the server and the scene goes where the verdict says (`outcomes`). Only `confession`
   * (#55): accept / not yet / decline, read by the persona service (packages/shared/src/confession.ts).
   */
  judge: z.literal('confession').optional(),
  outcomes: z.object({ accept: zStepId, not_yet: zStepId, decline: zStepId }).strict().optional()
}).strict().refine((s) => !s.jumps || s.mode === 'free', 'jumps_need_free_talk');

/**
 * A mini-game (#66–#70; rules in ./minigames.ts). Rock-paper-scissors is decided on the server; the other four are
 * judged there (the persona service reads his words) and go where the verdict says: `win` / `lose` (praise: specific /
 * generic; ōgiri: at or over `config.passScore` / under it, `draw` without one; bargain: he offered what she can
 * accept / anything else; danmaku: read out / crossed the line). Missing = `next`.
 */
export const zMinigameStep = z.object({
  ...base, type: z.literal('minigame'), kind: z.enum(MINIGAMES), config: z.record(z.unknown()).default({}),
  next: zStepId,
  /** Where a decided game goes; missing = `next`. */
  outcomes: z.object({ win: zStepId.optional(), lose: zStepId.optional(), draw: zStepId.optional() }).strict().optional()
}).strict();

export const zEffectStep = zEffectBody.extend({ ...base, type: z.literal('effect') }).strict();
export const zEndStep = z.object({ id: zStepId, type: z.literal('end'), outcome: z.string().regex(/^[a-z_]{1,24}$/).optional() }).strict();

export const zSceneStep = z.union([zClipStep, zLineStep, zChoiceStep, zInputStep, zMinigameStep, zEffectStep, zEndStep]);

export const zSceneMeta = z.object({
  id: zSceneId,
  star: z.enum(STAR_IDS),
  title: zSceneText,
  /**
   * When the scene can be started. `weather` is her city's real sky (#63); `routine` is her presence (home / out /
   * asleep) or one of her activities (world.ts ROUTINE_ACTIVITIES) at that moment (#60).
   */
  trigger: z.object({
    slots: z.array(z.enum(SLOTS)).min(1),
    weather: z.array(z.enum(WEATHERS)).min(1).optional(),
    /** Minimum relationship stage (#54): the scene opens at this stage and every later one. */
    stage: z.enum(RELATIONSHIP_STAGES).optional(),
    /** A card he must own (variant cards, #75). */
    variantCard: z.string().max(64).optional(),
    /**
     * One of her four variant scenes (#76): opens once her variant card's own level (1–10) reaches it. Scripts name
     * the layer, never the card: scenes/variantScenes.ts fills `variantCard` from VARIANT_CARDS.
     */
    variantLayer: z.number().int().min(1).max(10).optional(),
    routine: z.string().max(40).optional()
  }).strict(),
  /** Points paid at the start (no real money, docs/compliance-jp.md §4). */
  cost: z.object({ points: z.number().int().min(1).max(10_000) }).strict().optional(),
  /** Her idle loop, where the stage returns when he stops answering; default: the first clip. */
  idle: z.string().regex(/^[a-z0-9-]{3,80}$/).optional(),
  /**
   * What the scene sounds like (#82, ./audio.ts): its background music from the start (clips may change it,
   * `clip.music`) and the weather at her window under it (#63, rain / snow / storm). Played only with sound on and
   * after his first tap (browsers refuse audio before), ducked under her voice, stopped when he leaves.
   * Missing = the site's own background music, as before.
   */
  audio: z.object({ bgm: z.enum(MUSIC_IDS).optional(), ambience: z.enum(AMBIENCES).optional() }).strict().optional(),
  /** Demo-only scene: startable only in demo / prototype mode, never in production. */
  demo: z.boolean().optional(),
  /**
   * The lines still await native review (#84). A draft is demo-only, like a scene whose clips do not exist yet — the
   * publish rule, ./triggers.ts `scenePlayable`: production plays a scene once its script is reviewed and all its
   * media exist.
   */
  draft: z.boolean().optional()
}).strict();

export const zSceneScript = z.object({ meta: zSceneMeta, steps: z.array(zSceneStep).min(2).max(400) }).strict();

/**
 * What the persona service may ask of a free-talk step (#65): continue at one of the step's declared `jumps`.
 * Anything else it sends is dropped (engine.ts `nextAfterFree`).
 */
export const zSceneDirective = z.object({ jumpTo: zStepId }).strict();
/**
 * What the persona service may answer to a chat turn in which he asked for a scene (#65): start it, or offer
 * another one instead. The API acts on it only for a scene it listed as ready in that turn.
 */
export const zSceneRequestDirective = z.object({ scene: zSceneId, action: z.enum(['start', 'offer']) }).strict();

export type SceneText = z.infer<typeof zSceneText>;
export type EffectBody = z.infer<typeof zEffectBody>;
export type ClipStep = z.infer<typeof zClipStep>;
export type LineStep = z.infer<typeof zLineStep>;
export type ChoiceStep = z.infer<typeof zChoiceStep>;
export type InputStep = z.infer<typeof zInputStep>;
export type FreeJump = z.infer<typeof zFreeJump>;
export type MinigameStep = z.infer<typeof zMinigameStep>;
export type EffectStep = z.infer<typeof zEffectStep>;
export type EndStep = z.infer<typeof zEndStep>;
export type SceneStep = z.infer<typeof zSceneStep>;
export type SceneMeta = z.infer<typeof zSceneMeta>;
export type SceneScript = z.infer<typeof zSceneScript>;
export type SceneDirective = z.infer<typeof zSceneDirective>;
export type Shot = (typeof SHOTS)[number];
export type Slot = (typeof SLOTS)[number];
export type RpsHand = (typeof RPS_HANDS)[number];

/**
 * Structural checks zod cannot express: unique ids, every jump lands on a step, the automatic steps never loop
 * without waiting for him, an end is reachable, and nothing falls off the end of the list.
 */
export function sceneProblems(script: SceneScript): string[] {
  const out: string[] = [];
  const ids = script.steps.map((s) => s.id);
  const byId = new Map(script.steps.map((s) => [s.id, s]));
  if (new Set(ids).size !== ids.length) out.push('duplicate step ids');
  const after = (i: number) => script.steps[i + 1]?.id;
  script.steps.forEach((s, i) => {
    const targets = targetsOf(s, after(i));
    if (s.type !== 'end' && !targets.length) out.push(`${s.id}: falls off the end`);
    for (const t of targets) if (!byId.has(t)) out.push(`${s.id}: unknown target ${t}`);
    if (s.type === 'effect' && s.timer?.onEnd && !byId.has(s.timer.onEnd)) out.push(`${s.id}: countdown ends at unknown step ${s.timer.onEnd}`);
    if (s.type === 'choice' && new Set(s.options.map((o) => o.id)).size !== s.options.length) out.push(`${s.id}: duplicate option ids`);
    if (s.type === 'choice') {
      for (const o of s.options) {
        if (o.pay === 'extend' && !(o.effect?.timer?.add && o.effect.timer.seconds === DATE_RULES.extendMinutes * 60)) out.push(`${s.id}: ${o.id} pays for an extension but does not add DATE_RULES.extendMinutes`);
      }
      for (const o of s.options) {
        if (o.gift && o.pay) out.push(`${s.id}: ${o.id} is both a gift and an extension`);
        if (o.gift && o.effect?.affinity) out.push(`${s.id}: ${o.id} is a gift with affinity of its own`);
      }
      if (s.options.filter((o) => o.pay || o.gift).length === s.options.length) out.push(`${s.id}: every option costs points`);
    }
    if (s.type === 'input' && !!s.judge !== !!s.outcomes) out.push(`${s.id}: judge needs outcomes`);
  });
  // A run of automatic steps must reach a waiting step or an end.
  script.steps.forEach((s, i) => {
    const seen = new Set<string>();
    let cur: SceneStep | undefined = s;
    let k = i;
    while (cur && !isInteractive(cur) && cur.type !== 'end') {
      if (seen.has(cur.id)) { out.push(`${s.id}: automatic loop`); break; }
      seen.add(cur.id);
      const next: string | undefined = cur.next ?? after(k);
      cur = next ? byId.get(next) : undefined;
      k = cur ? ids.indexOf(cur.id) : -1;
    }
  });
  // An end must be reachable from the first step.
  const reach = new Set<string>();
  const stack = [script.steps[0]?.id];
  while (stack.length) {
    const id = stack.pop();
    if (!id || reach.has(id) || !byId.has(id)) continue;
    reach.add(id);
    stack.push(...targetsOf(byId.get(id)!, after(ids.indexOf(id))));
  }
  if (![...reach].some((id) => byId.get(id)?.type === 'end')) out.push('no reachable end');
  if (script.meta.idle && !/^[a-z0-9-]+$/.test(script.meta.idle)) out.push('invalid idle media');
  if (script.meta.trigger.variantLayer && !script.meta.trigger.variantCard) out.push('variant layer without its card');
  return out;
}

/** Parses and checks a script; throws with every problem listed. */
export function parseScene(raw: unknown): SceneScript {
  const script = zSceneScript.parse(raw);
  const problems = sceneProblems(script);
  if (problems.length) throw new Error(`scene ${script.meta.id}: ${problems.join('; ')}`);
  return script;
}
