/**
 * The scene state machine (#64). Pure: no storage, no clock, no network — the API runs it with D1 and the rewards
 * behind it, and the web prototype runs the very same code against the browser, so both modes play a script alike.
 *
 * A run waits on one step at a time (`at`). Every accepted answer moves it on through the automatic steps
 * (clip, line, effect) to the next step that waits for him (choice, input, mini-game) or to an end, and returns
 * those steps as `beats` for the player. `seq` counts accepted answers so a repeated submission is recognised.
 */
import { localText } from '../domain';
import { DATE_RULES, SCENE_RULES } from '../rules';
import { RPS_HANDS } from './constants';
import { isInteractive } from './graph';
import { isJudged, type GameResult, type Judged, type RpsGame } from './minigames';
import type { ConfessionAnswer } from '../confession';
import type { GiftId, GiftTaste } from '../gifts';
import type {
  EffectBody, InputStep, MinigameStep, RpsHand, SceneDirective, SceneScript, SceneStep, SceneText
} from './schema';

/**
 * A memory card the run made. `still` (#51): the clip on screen at the moment it was made (a media id or family, as the
 * script names it), whose poster is the card's picture — on the ending, on 思い出 and in his export.
 */
export interface SceneMemory { id: string; title: string; createdAt: string; still?: string }
/**
 * A promise she made (#59). `kind` wakeup: her 「明日の朝、起こしてあげる」 (#57, #66), kept by her wake-up; `scene`: the
 * scene that keeps it when it comes (a morning payoff, #67), when not the run's own.
 */
export interface ScenePromise { text: string; dueAt: string; kind?: 'scene' | 'wakeup'; scene?: string }
export interface SceneRewards { affinity: number; variantXp: number; memories: SceneMemory[]; promises: ScenePromise[] }
export type RpsResult = 'win' | 'lose' | 'draw';
/** A gift he gave inside the scene (#68, #77): what it was, how it landed with her, the XP it paid. */
export interface GiftGame { kind: 'gift'; giftId: GiftId; taste: GiftTaste; xp: number; result: 'win' }
/** The last decided mini-game (rock-paper-scissors, or a judged one: ./minigames.ts), or the gift he just gave. */
export type SceneResult = GameResult | GiftGame;
/** Longest `RunState.path` kept (a script has at most 400 steps; a run revisits few). */
const PATH_CAP = 400;

export interface RunState {
  v: 1;
  /** The step waiting for him, or the end that was reached. */
  at: string;
  ended: boolean;
  outcome: string | null;
  /** What the last change plays, ending with `at`. */
  beats: SceneStep[];
  waitingSince: number;
  timerEndsAt: number | null;
  /** #69: the step the countdown's end jumps to (her plea), until it fired or the run reached it by itself. */
  timerOnEnd?: string | null;
  /** What he typed at text inputs, by step id (the scene can refer back to it; #65 may use it). */
  inputs: Record<string, string>;
  freeTurns: number;
  /** False when today's rewarded run of this scene was already played: effects show nothing and grant nothing. */
  rewardable: boolean;
  rewards: SceneRewards;
  last: SceneResult | null;
  /** Script variables that held when the run started (#63, SCENE_VARS): which `line.variants` she speaks. */
  vars?: string[];
  /** Every step played so far, in order (capped): what the judges read as context (./minigames.ts `heardBefore`). */
  path?: string[];
  /** The prompt shown at a mini-game step (ōgiri, #70), by step id: the judge reads his answer against it. */
  prompts?: Record<string, string>;
  /** The clip on screen after the last change (its media as played): a memory card made next takes its poster (#51). */
  shot?: string;
  /** The live-stream overlay is up (#68): set by effects with `live`, until one takes it down (下播). */
  live?: boolean;
}

export type SceneSubmission =
  /** `gift`: the gift he picked in the sheet for an option with `gift: "pick"` (#68). */
  | { choice: string; gift?: GiftId }
  | { input: string }
  | { minigame: { hand?: RpsHand; text?: string } }
  | { timeout: true };

/** What the chat path hands back for a free-talk step. */
export interface FreeTurn { reply: string; directive?: SceneDirective | null }

export interface StepContext {
  now: number;
  lang: string;
  newId: (prefix: string) => string;
  /** Free-talk steps only: her reply from the chat path. */
  free?: FreeTurn;
  /** Judged inputs only (#55): the verdict on his answer, decided outside the engine (the persona service). */
  verdict?: ConfessionAnswer;
  /** Judged mini-games only (#67–#70): his answer, decided outside the engine (./minigames.ts `judgeAnswer`). */
  judged?: Judged;
  /**
   * A prompt for the mini-game the run is about to wait on (ōgiri's theme, #70), or null for none: she says it as a
   * line just before the game, and the run keeps its id. Called once per arrival at such a step.
   */
  prompt?: (step: MinigameStep, state: RunState) => { id: string; text: SceneText } | null;
  rng?: () => number;
  /**
   * A gift option only (#68): the gift he gave, already paid for outside the engine (the API, with the step), and her
   * reaction to it, played before the scene goes on.
   */
  gift?: { result: GiftGame; reply: SceneText[] };
}

export interface Advance {
  state: RunState;
  /** What this change grants, already added to `state.rewards`; the caller stores it together with the run. */
  grant: SceneRewards;
}

export type SceneError = 'run_ended' | 'invalid_submission' | 'unknown_option' | 'too_early' | 'free_reply_missing' | 'script_error' | 'verdict_missing' | 'gift_missing';

const emptyRewards = (): SceneRewards => ({ affinity: 0, variantXp: 0, memories: [], promises: [] });
const local = (t: SceneText, lang: string) => localText(t, lang);
const HOUR = 3_600_000;

export { inviteTiming, jstSlot, sceneWindow, triggerProblems, windowDue, type TriggerContext } from './timing';

/**
 * When a run ends by itself: the 30-minute cap, or — for a date with a countdown (#69) — the countdown's end plus
 * DATE_RULES.afterTimerMs for her plea, whichever is later, never past DATE_RULES.maxRunMs.
 */
export function runEndsAt(startedAt: number, timerEndsAt: number | null = null): number {
  const cap = startedAt + SCENE_RULES.maxRunMs;
  if (!timerEndsAt) return cap;
  return Math.min(Math.max(cap, timerEndsAt + DATE_RULES.afterTimerMs), startedAt + DATE_RULES.maxRunMs);
}

/**
 * A run never outlives its cap (`runEndsAt`). Going quiet is handled by the player (idle loop → prompt → end after
 * five minutes, SCENE_RULES), which knows whether he is still touching the screen; the server only enforces the cap,
 * so a dropped connection can resume where it left off.
 */
export function expiredOutcome(startedAt: number, now: number, timerEndsAt: number | null = null): 'timeout' | null {
  return now >= runEndsAt(startedAt, timerEndsAt) ? 'timeout' : null;
}

/**
 * Where free talk continues (#65). The persona service classifies his words against the step's declared `jumps` and
 * may send `directive.jumpTo`; only a declared target is taken (the script was checked at boot, so it exists).
 * Anything else — no directive, an unknown step, a step of another branch — carries on to `next`, so an agent can
 * never steer a scene anywhere its script did not allow.
 */
export function nextAfterFree(step: InputStep, turn: FreeTurn): string {
  const to = turn.directive?.jumpTo;
  return to && (step.jumps ?? []).some((j) => j.to === to) ? to : step.next;
}

/** Her hand: uniformly random (the API passes a crypto rng); he can only send his own hand, never the result. */
export function decideRps(mine: RpsHand, rng: () => number = Math.random): RpsGame {
  const hers = RPS_HANDS[Math.min(RPS_HANDS.length - 1, Math.floor(rng() * RPS_HANDS.length))];
  const beats: Record<RpsHand, RpsHand> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  const result: RpsResult = mine === hers ? 'draw' : beats[mine] === hers ? 'win' : 'lose';
  return { kind: 'rps', mine, hers, result };
}

function index(script: SceneScript) {
  const pos = new Map(script.steps.map((s, i) => [s.id, i]));
  const byId = (id: string | undefined) => (id === undefined ? undefined : script.steps[pos.get(id) ?? -1]);
  const following = (s: SceneStep) => script.steps[(pos.get(s.id) ?? -2) + 1];
  return { byId, following };
}

/**
 * A step as played in this run: a line's or a clip's variant for a script variable that holds (#63; `variant`: his
 * variant card, #70), else as written. A swapped clip keeps what was written as its `fallback` (the player cuts to it
 * when it does not have the variant's footage yet).
 */
function spoken(step: SceneStep, vars: readonly string[]): SceneStep {
  if (step.type === 'clip' && step.variants) {
    const { variants, ...clip } = step;
    const alt = variants.find((v) => vars.includes(v.when));
    return alt && alt.media !== clip.media ? { ...clip, media: alt.media, fallback: clip.media } : clip;
  }
  if (step.type !== 'line' || !step.variants) return step;
  const { variants, voice, ...line } = step;
  const alt = variants.find((v) => vars.includes(v.when));
  if (!alt) return voice ? { ...line, voice } : line;
  return alt.text.voice ? { ...line, text: alt.text, voice: alt.text.voice } : { ...line, text: alt.text };
}

/** Plays from `from` through the automatic steps to the next waiting step or end. */
function walk(script: SceneScript, from: string, vars: readonly string[] = []): { beats: SceneStep[]; at: SceneStep } | null {
  const { byId, following } = index(script);
  const beats: SceneStep[] = [];
  let cur = byId(from);
  for (let n = 0; cur && n < script.steps.length + 1; n++) {
    beats.push(spoken(cur, vars));
    if (isInteractive(cur) || cur.type === 'end') return { beats, at: cur };
    cur = cur.next ? byId(cur.next) : following(cur);
  }
  return null;
}

/** An effect as it plays, with the clip on screen at that moment (a memory card's still, #51). */
interface Played { e: EffectBody; shot?: string }

/** Adds what the effects grant (nothing when the run is not rewardable; timers always run). */
function apply(state: RunState, effects: Played[], ctx: StepContext): Advance {
  const grant = emptyRewards();
  let timerEndsAt = state.timerEndsAt;
  let timerOnEnd = state.timerOnEnd ?? null;
  let live = state.live;
  for (const { e, shot } of effects) {
    if (e.live !== undefined) live = e.live;
    if (e.timer) {
      timerEndsAt = e.timer.add
        ? Math.max(timerEndsAt ?? ctx.now, ctx.now) + e.timer.seconds * 1000
        : e.timer.seconds ? ctx.now + e.timer.seconds * 1000 : null;
      if (e.timer.onEnd) timerOnEnd = e.timer.onEnd;
    }
    if (!state.rewardable) continue;
    grant.affinity += e.affinity ?? 0;
    grant.variantXp += e.variantXp ?? 0;
    if (e.memory) grant.memories.push({ id: ctx.newId('mem'), title: local(e.memory.title, ctx.lang).slice(0, 40), createdAt: new Date(ctx.now).toISOString(), ...(shot ? { still: shot } : {}) });
    if (e.promise) {
      const [, n, unit] = /^\+(\d+)([hd])$/.exec(e.promise.due)!;
      grant.promises.push({
        text: local(e.promise.text, ctx.lang), dueAt: new Date(ctx.now + Number(n) * (unit === 'd' ? 24 : 1) * HOUR).toISOString(),
        ...(e.promise.kind ? { kind: e.promise.kind } : {}), ...(e.promise.scene ? { scene: e.promise.scene } : {})
      });
    }
  }
  const r = state.rewards;
  return {
    state: {
      ...state, timerEndsAt, ...(timerOnEnd !== (state.timerOnEnd ?? null) ? { timerOnEnd } : {}), ...(live !== undefined ? { live } : {}),
      rewards: { affinity: r.affinity + grant.affinity, variantXp: r.variantXp + grant.variantXp, memories: [...r.memories, ...grant.memories], promises: [...r.promises, ...grant.promises] }
    },
    grant
  };
}

function moveTo(script: SceneScript, state: RunState, next: string, lead: SceneStep[], ctx: StepContext): Advance | SceneError {
  const seg = walk(script, next, state.vars);
  if (!seg) return 'script_error';
  const beats = [...lead, ...seg.beats];
  let prompts = state.prompts;
  // Arriving at a game with a prompt (ōgiri's theme): she says it last, right before he answers.
  const asked = seg.at.type === 'minigame' && ctx.prompt ? ctx.prompt(seg.at, state) : null;
  if (asked) {
    beats.splice(beats.length - 1, 0, { id: `${seg.at.id}~prompt`, type: 'line', text: asked.text, ...(asked.text.voice ? { voice: asked.text.voice } : {}) });
    prompts = { ...prompts, [seg.at.id]: asked.id };
  }
  // Each effect with the clip on screen when it plays: the last clip before it in this change, else the run's.
  const effects: Played[] = [];
  let shot = state.shot;
  for (const b of beats) {
    if (b.type === 'clip') shot = b.media;
    else if (b.type === 'effect') effects.push({ e: b, shot });
  }
  const ended = seg.at.type === 'end';
  // Reached her plea by himself (the scene's own order): the countdown's end no longer needs to jump there.
  const reached = state.timerOnEnd && beats.some((b) => b.id === state.timerOnEnd);
  const moved: RunState = {
    ...state, ...(reached ? { timerOnEnd: null } : {}), at: seg.at.id, beats, waitingSince: ctx.now, ended, ...(shot ? { shot } : {}),
    outcome: ended ? (seg.at.type === 'end' && seg.at.outcome) || 'complete' : null,
    path: [...(state.path ?? []), ...beats.map((b) => b.id)].slice(-PATH_CAP),
    ...(prompts ? { prompts } : {})
  };
  return apply(moved, effects, ctx);
}

/** A new run: plays from the first step. */
export function beginRun(script: SceneScript, opts: { rewardable: boolean; vars?: string[] } & StepContext): Advance | SceneError {
  const blank: RunState = {
    v: 1, at: script.steps[0].id, ended: false, outcome: null, beats: [], waitingSince: opts.now, timerEndsAt: null,
    inputs: {}, freeTurns: 0, rewardable: opts.rewardable, rewards: emptyRewards(), last: null,
    ...(opts.vars?.length ? { vars: [...opts.vars] } : {})
  };
  return moveTo(script, blank, script.steps[0].id, [], opts);
}

/** Whether a timeout answer is due (never early: skipping by "timing out" would be a shortcut). */
function timedOut(state: RunState, seconds: number | undefined, now: number): boolean {
  return seconds !== undefined && now >= state.waitingSince + seconds * 1000 - SCENE_RULES.timeoutGraceMs;
}

/** His answer to the waiting step. */
export function submitStep(script: SceneScript, state: RunState, sub: SceneSubmission, ctx: StepContext): Advance | SceneError {
  if (state.ended) return 'run_ended';
  const step = index(script).byId(state.at);
  if (!step || !isInteractive(step)) return 'script_error';
  const cleared = { ...state, last: null };

  if ('timeout' in sub) {
    if (step.type === 'minigame') return 'invalid_submission';
    const target = step.type === 'choice' ? step.onTimeout : step.onTimeout ?? step.next;
    if (!target) return 'invalid_submission';
    if (!timedOut(state, step.timeout, ctx.now)) return 'too_early';
    return moveTo(script, cleared, target, [], ctx);
  }

  if (step.type === 'choice') {
    if (!('choice' in sub)) return 'invalid_submission';
    const opt = step.options.find((o) => o.id === sub.choice);
    if (!opt) return 'unknown_option';
    // The option's own reward plays first, as a beat of its own, so the player can show it right after the tap.
    const lead: SceneStep[] = opt.effect ? [{ ...opt.effect, id: `${step.id}~${opt.id}`, type: 'effect' }] : [];
    if (opt.gift) {
      // A gift (#68): the one he picked (or the option's own), paid for outside; she reacts to it first.
      const picked = opt.gift === 'pick' ? sub.gift : opt.gift;
      if (!picked || (opt.gift !== 'pick' && sub.gift !== undefined && sub.gift !== opt.gift)) return 'invalid_submission';
      const g = ctx.gift;
      if (!g || g.result.giftId !== picked) return 'gift_missing';
      const reply = g.reply.map((t, i): SceneStep => ({ id: `${step.id}~gift${i ? i + 1 : ''}`, type: 'line', text: t }));
      return moveTo(script, { ...cleared, last: g.result }, opt.next, [...lead, ...reply], ctx);
    }
    if ('gift' in sub && sub.gift !== undefined) return 'invalid_submission';
    return moveTo(script, cleared, opt.next, lead, ctx);
  }

  if (step.type === 'input') {
    if (!('input' in sub)) return 'invalid_submission';
    const text = sub.input.trim().slice(0, 500);
    if (!text) return 'invalid_submission';
    if (step.mode === 'free') {
      if (!ctx.free) return 'free_reply_missing';
      const r = ctx.free.reply;
      const reply: SceneStep = { id: `${step.id}~reply`, type: 'line', text: { ja: r, 'zh-Hant': r, en: r, ko: r }, agent: true };
      return moveTo(script, { ...cleared, freeTurns: state.freeTurns + 1 }, nextAfterFree(step, ctx.free), [reply], ctx);
    }
    if (step.judge) {
      if (!ctx.verdict) return 'verdict_missing';
      return moveTo(script, { ...cleared, inputs: { ...state.inputs, [step.id]: text } }, step.outcomes?.[ctx.verdict] ?? step.next, [], ctx);
    }
    return moveTo(script, { ...cleared, inputs: { ...state.inputs, [step.id]: text } }, step.next, [], ctx);
  }

  if (!('minigame' in sub)) return 'invalid_submission';
  if (step.kind === 'rps') {
    const hand = sub.minigame.hand;
    if (!hand || !(RPS_HANDS as readonly string[]).includes(hand)) return 'invalid_submission';
    const last = decideRps(hand, ctx.rng);
    return moveTo(script, { ...cleared, last }, step.outcomes?.[last.result] ?? step.next, [], ctx);
  }
  // praise / ogiri / bargain / danmaku (#67–#70): judged outside the engine (the persona service through the API,
  // ./minigames.ts `judgeAnswer`); the verdict decides the branch, her reaction lines and the answer's own reward.
  const text = (sub.minigame.text ?? '').trim().slice(0, 500);
  if (!text || !isJudged(step.kind)) return 'invalid_submission';
  const j = ctx.judged;
  if (!j || j.result.kind !== step.kind) return 'verdict_missing';
  const lead: SceneStep[] = [
    ...j.reply.map((t, i): SceneStep => ({ id: `${step.id}~reply${i ? i + 1 : ''}`, type: 'line', text: t, agent: true, ...(t.voice ? { voice: t.voice } : {}) })),
    ...(j.effect ? [{ ...j.effect, id: `${step.id}~score`, type: 'effect' as const }] : [])
  ];
  const target = step.outcomes?.[j.result.result] ?? step.next;
  return moveTo(script, { ...cleared, last: j.result, inputs: { ...state.inputs, [step.id]: text } }, target, lead, ctx);
}

/**
 * #69: the countdown ran out (`timerEndsAt` passed) before he reached her plea — the run jumps to it now, from
 * wherever it waits, so her plea and the extend choice come the moment the time is up. Null when nothing is due.
 * Fires once: the extension it offers adds time without another jump, and the run then ends on its cap.
 */
export function timerDue(script: SceneScript, state: RunState, ctx: StepContext): Advance | null {
  if (state.ended || !state.timerOnEnd || state.timerEndsAt === null || ctx.now < state.timerEndsAt) return null;
  const moved = moveTo(script, { ...state, last: null, timerOnEnd: null }, state.timerOnEnd, [], ctx);
  return typeof moved === 'string' ? null : moved;
}

/** He left (or went quiet): the run ends where it is; nothing already granted is taken back. */
export function endRun(state: RunState, outcome: string, now: number): RunState {
  return state.ended ? state : { ...state, ended: true, outcome, beats: [], waitingSince: now, timerEndsAt: null };
}

/** The first clip each branch of the waiting step leads to, so the player can fetch it before he answers. */
export function upcomingMedia(script: SceneScript, state: RunState): string[] {
  if (state.ended) return [];
  const { byId } = index(script);
  const step = byId(state.at);
  if (!step || !isInteractive(step)) return [];
  const targets = step.type === 'choice'
    ? [...step.options.map((o) => o.next), ...(step.onTimeout ? [step.onTimeout] : [])]
    : [step.next, ...(step.type === 'input' && step.onTimeout ? [step.onTimeout] : []), ...(step.type === 'input' ? (step.jumps ?? []).map((j) => j.to) : []),
      ...Object.values(step.outcomes ?? {})];
  const out: string[] = [];
  for (const t of targets) {
    // As this run plays them (#70: his variant card's footage), so the clip fetched is the clip cut to.
    const seg = t ? walk(script, t, state.vars) : null;
    const clip = seg?.beats.find((b) => b.type === 'clip');
    if (clip && clip.type === 'clip' && !out.includes(clip.media)) out.push(clip.media);
  }
  return out;
}

/** The step of the script a run is waiting on, if it is waiting. */
export function waitingStep(script: SceneScript, state: RunState): SceneStep | null {
  if (state.ended) return null;
  const s = index(script).byId(state.at);
  return s && isInteractive(s) ? s : null;
}
