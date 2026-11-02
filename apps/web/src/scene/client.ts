/**
 * Scene service for the player (#64). Server mode calls /v1/scene/* and the API is authoritative. Prototype mode
 * (offline demos, the e2e suite) runs the same shared engine against this browser, so a script plays identically;
 * its rewards then only live in the local cache, like everything else in prototype mode.
 */
import type { SceneRunResT, SceneRunViewT } from '@jstar/shared/contracts';
import { jstDay } from '@jstar/shared/rules';
import { VOICE_INPUT } from '@jstar/shared/voice';
import {
  beginRun, endRun, expiredOutcome, previewScript, runEndsAt, sceneById, scenePlayable, submitStep, timerDue, upcomingMedia, waitingStep,
  type RunState, type SceneError, type SceneScript, type SceneSubmission
} from '@jstar/shared/scenes';
import { confessionOf, guessAnswer, type ConfessionAnswer } from '@jstar/shared/confession';
import { ApiError, http, serverMode } from '../services/http';

export type SceneView = SceneRunViewT;
export type { SceneSubmission };

/** What the player lends the prototype engine: her current affinity and the chat path for free talk. */
export interface LocalDeps { affinity: number; freeTalk: (text: string) => Promise<string> }

const KEY = 'jstar.scenes';
interface LocalRun { id: string; sceneId: string; star: SceneView['star']; seq: number; state: RunState; startedAt: number; endedAt: number | null; outcome: string | null }
interface LocalStore { runs: LocalRun[]; rewarded: Record<string, string> }

function read(): LocalStore {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as LocalStore | null;
    if (raw && Array.isArray(raw.runs) && raw.rewarded && typeof raw.rewarded === 'object') return raw;
  } catch { /* storage blocked or corrupt: start clean */ }
  return { runs: [], rewarded: {} };
}
function write(s: LocalStore) {
  try { localStorage.setItem(KEY, JSON.stringify({ runs: s.runs.slice(-10), rewarded: s.rewarded })); } catch { /* private mode */ }
}

const iso = (ms: number) => new Date(ms).toISOString();
const fail = (code: string, status: number): never => { throw new ApiError(code, status); };
const STATUS: Record<SceneError, number> = { run_ended: 409, invalid_submission: 400, unknown_option: 400, too_early: 409, free_reply_missing: 500, script_error: 500, verdict_missing: 500, gift_missing: 500 };

/**
 * Scripts that are not bundled with the player: her confessions (#55) are built from her lines, loaded only when one
 * opens (scene/player.tsx), then registered here so prototype runs can find them.
 */
const extra = new Map<string, SceneScript>();
export function registerScripts(list: SceneScript[]) { for (const s of list) extra.set(s.meta.id, s); }
/** A bundled script as this build plays it: clips still pending (#80, #81) replaced by her existing ones (demo only). */
const bundledScript = (id: string): SceneScript | undefined => { const s = sceneById(id); return s && previewScript(s); };
const scriptById = (id: string): SceneScript | undefined => bundledScript(id) ?? extra.get(id);
let seq = 0;
const localId = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

function localView(run: LocalRun, script: SceneScript | undefined, affinity: number): SceneView {
  const s = run.state;
  return {
    id: run.id, sceneId: run.sceneId, star: run.star, seq: run.seq, status: run.endedAt ? 'ended' : 'active', outcome: run.outcome,
    startedAt: iso(run.startedAt), endsAt: iso(runEndsAt(run.startedAt, s.timerEndsAt)), endedAt: run.endedAt ? iso(run.endedAt) : null,
    beats: s.beats, waiting: script ? waitingStep(script, s) : null, waitingSince: iso(s.waitingSince),
    upcoming: script ? upcomingMedia(script, s) : [], timerEndsAt: s.timerEndsAt ? iso(s.timerEndsAt) : null,
    rewardable: s.rewardable, rewards: s.rewards, result: s.last, affinityXp: affinity
  };
}

/** The 30-minute cap, applied whenever a local run is read (the server does the same). */
function settle(store: LocalStore, run: LocalRun): LocalRun {
  if (run.endedAt) return run;
  // #69: her date's countdown ran out — the run moves to her plea, as the server does.
  const script = scriptById(run.sceneId);
  const due = script ? timerDue(script, run.state, { now: Date.now(), lang: 'ja', newId: localId }) : null;
  if (due) {
    run = { ...run, seq: run.seq + 1, state: due.state, ...(due.state.ended ? { endedAt: Date.now(), outcome: due.state.outcome } : {}) };
    store.runs = store.runs.map((r) => (r.id === run.id ? run : r));
    write(store);
  }
  const outcome = expiredOutcome(run.startedAt, Date.now(), run.state.timerEndsAt);
  if (!outcome) return run;
  const ended = { ...run, seq: run.seq + 1, state: endRun(run.state, outcome, Date.now()), endedAt: Date.now(), outcome };
  store.runs = store.runs.map((r) => (r.id === run.id ? ended : r));
  write(store);
  return ended;
}

function save(store: LocalStore, run: LocalRun) {
  store.runs = [...store.runs.filter((r) => r.id !== run.id), run];
  write(store);
}

/**
 * `offerId`: the offer he accepted (#65), so the server counts the start as hers or the moment's; none = his request.
 * `preview`: a scene production cannot play yet, on the test site (#66–#70, #76), judged by the server — prototype
 * mode has no previews.
 */
export async function startScene(sceneId: string, lang: string, deps: LocalDeps, offerId?: string, preview?: boolean): Promise<SceneRunResT> {
  if (serverMode()) return http.sceneStart(sceneId, lang, offerId, preview);
  if (preview) return fail('scene_not_found', 404);
  const script = scriptById(sceneId);
  // Prototype mode is a demo (the publish rule, scenePlayable): every scene plays, pending clips stand in.
  if (!script || !scenePlayable(script, true)) return fail('scene_not_found', 404);
  const store = read();
  const active = store.runs.map((r) => settle(store, r)).find((r) => !r.endedAt);
  if (active?.sceneId === sceneId) return { run: localView(active, script, deps.affinity), replayed: true };
  if (active) save(store, { ...active, seq: active.seq + 1, state: endRun(active.state, 'replaced', Date.now()), endedAt: Date.now(), outcome: 'replaced' });
  const now = Date.now();
  // A confession pays only on his yes, which happens once: it is always rewardable (as on the server).
  const rewardable = !!confessionOf(sceneId) || store.rewarded[sceneId] !== jstDay(now);
  const begun = beginRun(script, { now, lang, newId: localId, rewardable });
  if (typeof begun === 'string') return fail(begun, STATUS[begun]);
  if (rewardable) store.rewarded[sceneId] = jstDay(now);
  const run: LocalRun = { id: localId('scn'), sceneId, star: script.meta.star, seq: 0, state: begun.state, startedAt: now, endedAt: begun.state.ended ? now : null, outcome: begun.state.outcome };
  save(store, run);
  return { run: localView(run, script, deps.affinity + begun.grant.affinity), replayed: false };
}

/**
 * The step an answer is for (D-N2): its id, and the run's `seq` when the scene came to wait on it — not the `seq` the
 * run has by the time the answer goes (a countdown left over from a step he already answered would otherwise be sent
 * as an answer to the next one).
 */
export interface StepAt { id: string; seq: number }

/**
 * D-N2: the step his answer is for — the wait on screen, at the `seq` the scene came to it; else (he answers her next
 * free question over her lines, #72) the run's waiting step, at the run's `seq`.
 */
export function answerTarget(shown: StepAt | null, view: Pick<SceneView, 'seq' | 'waiting'>): StepAt | null {
  if (shown) return shown;
  return view.waiting ? { id: view.waiting.id, seq: view.seq } : null;
}
/** D-M3: a wait the scene comes to that he already answered (over her lines, #72) is not put up again. */
export const answeredAt = (answered: StepAt | null, id: string, seq: number): boolean => !!answered && answered.id === id && answered.seq === seq;
/** D-N2: an answer to a step the run is already past (a countdown left over from it): there is nothing to send. */
export const leftOver = (at: StepAt, view: Pick<SceneView, 'seq'>): boolean => at.seq < view.seq;
/** D-N2: after a refusal (409), the run had gone on past this step — the server took it — so the answer counts. */
export const tookIt = (at: StepAt, fresh: Pick<SceneView, 'seq'> | null): boolean => !!fresh && fresh.seq > at.seq;

/**
 * His answer to the step `at` (by default the run's waiting step at `view.seq`). `voiceMs`: how long he talked into
 * the mic for this answer (#74: charged to his voice time once per step).
 */
export async function stepScene(view: SceneView, sub: SceneSubmission, lang: string, deps: LocalDeps, voiceMs?: number, at?: StepAt): Promise<SceneRunResT> {
  const seq = at?.seq ?? view.seq;
  const stepId = at?.id;
  if (serverMode()) {
    return http.sceneStep({ runId: view.id, seq, ...(stepId ? { step: stepId } : {}), lang, ...sub, ...(voiceMs && voiceMs > 0 ? { voiceMs: Math.min(VOICE_INPUT.maxMs, Math.round(voiceMs)) } : {}) });
  }
  const script = scriptById(view.sceneId);
  const store = read();
  const found = store.runs.find((r) => r.id === view.id);
  if (!script || !found) return fail('run_not_found', 404);
  const run = settle(store, found);
  // As the server: an answer to a step already answered — by seq, or by naming a step the run is past — is a repeat.
  if (run.endedAt || seq < run.seq || (stepId && stepId !== waitingStep(script, run.state)?.id)) return { run: localView(run, script, deps.affinity), replayed: true };
  const step = waitingStep(script, run.state);
  // Prototype mode trusts the player's countdown (its timers can be scaled in tests); the server never does.
  const timeout = step && 'timeout' in step && typeof step.timeout === 'number' ? step.timeout * 1000 : 0;
  const now = 'timeout' in sub ? Math.max(Date.now(), run.state.waitingSince + timeout) : Date.now();
  let free: { reply: string } | undefined;
  if (step?.type === 'input' && step.mode === 'free' && 'input' in sub) {
    const dry = submitStep(script, run.state, sub, { now, lang, newId: () => 'dry', free: { reply: '' } });
    if (typeof dry === 'string') return fail(dry, STATUS[dry]);
    free = { reply: await deps.freeTalk(sub.input) };
  }
  // Her confession (#55): prototype mode reads his answer by the word lists the persona service uses without a model.
  const verdict: ConfessionAnswer | undefined = step?.type === 'input' && step.judge && 'input' in sub ? guessAnswer(sub.input) : undefined;
  const moved = submitStep(script, run.state, sub, { now, lang, newId: localId, free, verdict });
  if (typeof moved === 'string') return fail(moved, STATUS[moved]);
  const next: LocalRun = { ...run, seq: run.seq + 1, state: moved.state, endedAt: moved.state.ended ? now : null, outcome: moved.state.outcome };
  save(store, next);
  return { run: localView(next, script, deps.affinity + moved.grant.affinity), replayed: false };
}

export async function endScene(view: SceneView, reason: 'left' | 'idle', affinity: number): Promise<SceneRunResT> {
  if (serverMode()) return http.sceneEnd(view.id, reason);
  const store = read();
  const run = store.runs.find((r) => r.id === view.id);
  if (!run) return fail('run_not_found', 404);
  if (run.endedAt) return { run: localView(run, scriptById(run.sceneId), affinity), replayed: true };
  const ended: LocalRun = { ...run, seq: run.seq + 1, state: endRun(run.state, reason, Date.now()), endedAt: Date.now(), outcome: reason };
  save(store, ended);
  return { run: localView(ended, scriptById(run.sceneId), affinity), replayed: false };
}

/** His active run (after a reload or a dropped connection), or null. */
export async function currentScene(affinity: number): Promise<SceneView | null> {
  if (serverMode()) return (await http.sceneCurrent()).run;
  const store = read();
  const run = store.runs.map((r) => settle(store, r)).find((r) => !r.endedAt);
  return run ? localView(run, scriptById(run.sceneId), affinity) : null;
}

/** One run by id, ended or not (a reload after the end shows the same ending). */
export async function sceneRun(id: string, affinity: number): Promise<SceneView | null> {
  if (serverMode()) { try { return (await http.sceneRun(id)).run; } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; } }
  const store = read();
  const run = store.runs.find((r) => r.id === id);
  return run ? localView(settle(store, run), scriptById(run.sceneId), affinity) : null;
}

/** The run this tab is playing, so a reload finds it again (sessionStorage: one per tab). */
const TAB_KEY = 'jstar.sceneRun';
export function rememberRun(sceneId: string, runId: string | null) {
  try { if (runId) sessionStorage.setItem(TAB_KEY, JSON.stringify({ sceneId, runId })); else sessionStorage.removeItem(TAB_KEY); } catch { /* storage blocked */ }
}
export function rememberedRun(sceneId: string): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(TAB_KEY) ?? 'null') as { sceneId?: string; runId?: string } | null;
    return v?.sceneId === sceneId && typeof v.runId === 'string' ? v.runId : null;
  } catch { return null; }
}
