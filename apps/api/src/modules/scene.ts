import type { FastifyInstance } from 'fastify';
import {
  SCENE_RULES, SceneCurrentQuery, TRIGGER_RULES, SceneEndReq, SceneOfferDeclineReq, SceneRoomReq, SceneStartReq, SceneStepReq, WORLD,
  isVariantCard, variantCardOf, variantGain,
  type Lang, type SceneOfferViewT, type SceneRoomResT, type SceneRunResT, type StarId, type SceneRunViewT, type SceneStepReqT, type TriggerSource,
  type ScenePreviewListResT, type ScenePreviewResT
} from '@jstar/shared';
import {
  beginRun, chooseOffer, endRun, offersPaused, pendingMedia, sceneMedia, scenePlayable, expiredOutcome, submitStep, timerDue, upcomingMedia, waitingStep,
  isJudged, judgeAnswer, runEndsAt,
  type Advance, type FreeTurn, type Judged, type OfferChoice, type SceneError, type SceneRewards, type SceneScript, type SceneSubmission, type StepContext
} from '@jstar/shared/scenes';
import { parseScene, zSceneDirective } from '@jstar/shared/scenes/schema';
import { CONFESSION_SCENES } from '@jstar/shared/scenes/confession';
import { confessionOf, type ConfessionAnswer } from '@jstar/shared';
import { confessions } from '../lib/confession';
import { httpError, requireUser } from '../app';
import { newId } from '../lib/crypto';
import { PREVIEWABLE, SCRIPTS, firstMeeting, inviteFor, jstDayStart, offerExpiry, offerHistory, offerableFor, playableHere, problemsFor, sceneTalk, triggerContext } from '../lib/sceneTriggers';
import type { SceneExtension, SceneGrant, SceneOfferRow, SceneRunRow, UserRow } from '../db/types';
import { chatTurns } from './chat';
import { relationships } from '../lib/relationship';
import { newPromise } from '../lib/promises';
import { isSystemScene, openSystemFor } from '../lib/systemScenes';
import { judgeGame, promptFor, secureRandom } from '../lib/minigames';
import { sceneVars } from '../lib/herWorld';
import { chargeVoice, extensionRefusal, voiceExtension } from '../lib/voice';
import { giftReactionText, giftRefusal, planGift, type PlannedGift } from '../lib/gifts';
import { saveMemory } from '../lib/wishes';
import { hearsHer, signLine } from '../lib/voiceLines';
import { ttsStarsOf } from '../lib/voice';
import { LANGS, fitSceneReply, localText } from '@jstar/shared';
import { needsRuntimeVoice } from '@jstar/shared/scenes/speech';
import type { LineStep, SceneStep } from '@jstar/shared/scenes/schema';

/** A gift he gave in a scene step, as the engine plays it (#68). */
type GiftGiven = NonNullable<StepContext['gift']>;

/**
 * Her confessions (#55), built from her lines and checked at boot like every script. Kept apart from SCRIPTS: she
 * brings the confession herself (her message, the evening), so it is never offered, proposed or asked for in chat.
 */
const CONFESSIONS = new Map<string, SceneScript>(CONFESSION_SCENES.map((s) => { const p = parseScene(s); return [p.meta.id, p]; }));

/**
 * The scenes the owner reviews on the test site (lib/sceneTriggers.ts PREVIEWABLE: the five #66–#70 and her variant
 * scenes #76), as they play there: a clip still pending played by her existing one (none since #80 and #81 landed).
 * The preview start (`preview: true`) plays any of them whenever the owner opens it, without their time, weather,
 * routine or card conditions; in demo mode they also play the ordinary way, with every condition applied.
 */
const PREVIEWS = new Map<string, SceneScript>(PREVIEWABLE.map((s) => [s.meta.id, SCRIPTS.get(s.meta.id)!]));
const gamesOf = (s: SceneScript) => [...new Set(s.steps.flatMap((x) => (x.type === 'minigame' ? [x.kind] : [])))];

const STATUS: Record<SceneError, number> = {
  run_ended: 409, invalid_submission: 400, unknown_option: 400, too_early: 409, free_reply_missing: 500, script_error: 500, verdict_missing: 500, gift_missing: 500
};
const iso = (ms: number) => new Date(ms).toISOString();
const offerView = (o: SceneOfferRow, script: SceneScript): SceneOfferViewT => ({
  id: o.id, sceneId: o.sceneId, star: o.star, source: o.source, expiresAt: o.expiresAt, title: script.meta.title, media: sceneMedia(script)
});

const toSubmission = (b: SceneStepReqT): SceneSubmission =>
  b.choice !== undefined ? { choice: b.choice, ...(b.gift ? { gift: b.gift } : {}) }
    : b.input !== undefined ? { input: b.input }
      : b.minigame !== undefined ? { minigame: b.minigame }
        : { timeout: true };

/**
 * The scene engine on the server (#64). The script walk is the shared engine (packages/shared/src/scenes); this
 * module owns what must not be trusted to a browser: trigger conditions and cost, the order of answers (`seq`),
 * the 30-minute cap, free talk through the chat allowance, and every reward — affinity, memory cards, promises.
 */
export async function registerScene(app: FastifyInstance) {
  const repos = app.repos;
  const chat = chatTurns(app);
  const rel = relationships(app);
  const confession = confessions(app);
  /** #70: whether he owns her variant card (VARIANT_CARDS) — the `variant` script variable. */
  const ownsVariantOf = async (userId: string, star: SceneRunRow['star']): Promise<boolean> => {
    const card = variantCardOf(star);
    return !!card && (await repos.owned.forUser(userId)).some((o) => o.cardId === card);
  };
  /** Draft previews exist on the test site only (demo mode). */
  const scriptById = (id: string): SceneScript | undefined => SCRIPTS.get(id) ?? CONFESSIONS.get(id);

  /**
   * A variant scene's variant XP goes to the card it belongs to, with its main share (#75); elsewhere it stays on the run.
   * A promise she makes goes to the promises table (#59), kept later by playing this scene's time together again.
   */
  const grantOf = (user: UserRow, star: SceneRunRow['star'], g: SceneRewards, script: SceneScript, lang: Lang, now: number): SceneGrant => {
    const card = script.meta.trigger.variantCard;
    return {
      affinity: g.affinity,
      // #51: what the card is and where it was made (his yes to her confession is its own kind).
      // #51: its still is the clip on screen when it was made (the engine's `still`, a media id or family).
      memories: g.memories.map(({ still, ...m }) => ({ ...m, userId: user.id, star, kind: confessionOf(script.meta.id) ? 'confession' as const : 'scene' as const, sceneId: script.meta.id, still: still ?? null })),
      ...(card && isVariantCard(card) && g.variantXp > 0 ? { variant: { cardId: card, gain: variantGain(g.variantXp) } } : {}),
      // #57/#66: her 「明日の朝、起こしてあげる」 is a wake-up promise (the home offers the alarm; her wake-up keeps it);
      // #67: a promise may name the scene that keeps it (her morning), instead of this one.
      promises: g.promises.map((p) => newPromise({
        userId: user.id, star, text: p.text, dueAt: p.dueAt, kind: p.kind ?? 'scene', source: 'scene', sceneId: p.scene ?? script.meta.id, lang
      }, now))
    };
  };

  /**
   * One promise with her at a time (#59): while one is open, the scene's is not made (the store refuses it too), so
   * it is also taken off what the ending shows. Best effort for the display; the store's guard is what counts.
   */
  const onePromise = async (userId: string, star: SceneRunRow['star'], adv: Advance): Promise<Advance> => {
    const n = adv.grant.promises.length;
    if (!n || !(await repos.promises.open(userId, star)).length) return adv;
    return {
      state: { ...adv.state, rewards: { ...adv.state.rewards, promises: adv.state.rewards.promises.slice(0, -n) } },
      grant: { ...adv.grant, promises: [] }
    };
  };

  /**
   * A scene is time together (#54): its JST day counts once, and what it granted can move the relationship on —
   * a stage entered pays its free pull there, exactly as from chat. Returns her XP after it.
   */
  const together = async (user: UserRow, star: SceneRunRow['star']): Promise<number> => (await rel.touch(user.id, star)).xp;

  /**
   * Her lines in these beats her runtime voice may speak (#73), signed for him per language, as `lineToSay` would
   * speak them at runtime: a `tts` line, her free-talk reply (`agent`), a line with his name. None without her voice.
   */
  const voiceSigs = async (row: SceneRunRow, beats: SceneStep[]): Promise<Record<string, Record<string, string>> | null> => {
    if (!ttsStarsOf(app).includes(row.star)) return null;
    const lines = beats.filter((b): b is LineStep => b.type === 'line' && !!(b.tts || b.agent || needsRuntimeVoice(b.text)));
    if (!lines.length) return null;
    const user = await repos.users.byId(row.userId);
    if (!user || !hearsHer(app, user, row.star)) return null;
    const out: Record<string, Record<string, string>> = {};
    for (const b of lines) out[b.id] = Object.fromEntries(LANGS.map((l) => [l, signLine(row.userId, row.star, localText(b.text, l).trim())]));
    return out;
  };

  const view = async (row: SceneRunRow, xp?: number): Promise<SceneRunViewT> => {
    const script = scriptById(row.sceneId);
    const s = row.state;
    const sigs = await voiceSigs(row, s.beats);
    return {
      ...(sigs ? { voiceSigs: sigs } : {}),
      id: row.id, sceneId: row.sceneId, star: row.star, seq: row.seq,
      status: row.endedAt ? 'ended' : 'active', outcome: row.outcome,
      startedAt: row.startedAt, endsAt: iso(runEndsAt(Date.parse(row.startedAt), s.timerEndsAt)), endedAt: row.endedAt,
      beats: s.beats, waiting: script ? waitingStep(script, s) : null, waitingSince: iso(s.waitingSince),
      upcoming: script ? upcomingMedia(script, s) : [], timerEndsAt: s.timerEndsAt ? iso(s.timerEndsAt) : null,
      rewardable: s.rewardable, rewards: s.rewards, result: s.last, ...(s.live ? { live: true } : {}),
      affinityXp: xp ?? (await repos.affinity.get(row.userId, row.star))
    };
  };

  /** Metrics (#52): how long he stayed, recorded once, by whichever change ended the run. */
  const ended = (run: SceneRunRow) => app.recordEvent(run.userId, 'scene.end', {
    star: run.star, sceneId: run.sceneId, seconds: Math.max(0, Math.round((Date.parse(run.endedAt ?? run.updatedAt) - Date.parse(run.startedAt)) / 1000))
  });

  /**
   * U-29 / #8: a scene played to its end closes what invited him to it — her confession day's message, her invitation,
   * her weather message: read, so her room no longer leads with it nor offers the scene again from it. Leaving, going
   * quiet or the time cap close nothing (he may come back to it).
   */
  const finished = async (run: SceneRunRow) => {
    if (!run.endedAt || !run.outcome || ['left', 'idle', 'timeout'].includes(run.outcome)) return;
    await repos.inbox.readNaming(run.userId, run.star, run.sceneId, run.endedAt);
  };

  /** Ends a run where it stands. Nothing granted is taken back: leaving, going quiet and the time cap cost nothing. */
  const close = async (run: SceneRunRow, outcome: string): Promise<SceneRunRow> => {
    const now = Date.now();
    const next: SceneRunRow = { ...run, seq: run.seq + 1, state: endRun(run.state, outcome, now), updatedAt: iso(now), endedAt: iso(now), outcome };
    if (await repos.sceneRuns.advance(next, run.seq, { affinity: 0, memories: [] })) { await ended(next); return next; }
    return (await repos.sceneRuns.byId(run.id)) ?? next;
  };

  /**
   * Every read passes through here, so the 30-minute cap needs no scheduler. #69: a date's countdown that ran out
   * moves the run to her plea (`timerDue`) on the first read after it — the player asks right at that moment.
   */
  const settle = async (run: SceneRunRow, user?: UserRow): Promise<SceneRunRow> => {
    if (run.endedAt) return run;
    const script = user ? scriptById(run.sceneId) : undefined;
    const now = Date.now();
    const due = script && user ? timerDue(script, run.state, { now, lang: user.lang, newId }) : null;
    if (due && user && script) {
      const next: SceneRunRow = {
        ...run, step: due.state.at, seq: run.seq + 1, state: due.state, updatedAt: iso(now), endedAt: due.state.ended ? iso(now) : null, outcome: due.state.outcome
      };
      if (await repos.sceneRuns.advance(next, run.seq, grantOf(user, run.star, due.grant, script, user.lang, now))) {
        if (next.endedAt) { await ended(next); await finished(next); }
        run = next;
      } else {
        run = (await repos.sceneRuns.byId(run.id)) ?? run;
      }
    }
    const outcome = expiredOutcome(Date.parse(run.startedAt), Date.now(), run.state.timerEndsAt);
    return outcome ? close(run, outcome) : run;
  };

  const own = async (user: UserRow, runId: string): Promise<SceneRunRow> => {
    const run = await repos.sceneRuns.byId(runId);
    if (!run || run.userId !== user.id) throw httpError('run_not_found', 404);
    return settle(run, user);
  };

  const scriptFor = (sceneId: string, preview = false): SceneScript => {
    // A preview only on the test site: 404 in production, like any unknown scene.
    if (preview) {
      const shown = app.demo ? PREVIEWS.get(sceneId) : undefined;
      if (!shown) throw httpError('scene_not_found', 404);
      return shown;
    }
    // The publish rule: production plays reviewed scenes whose clips all exist; everything else (demo scenes, pending
    // clips, unreviewed lines) only on the test site and in local demos (DEMO_MODE).
    if (playableHere(app, sceneId)) return SCRIPTS.get(sceneId)!;
    const confession = CONFESSIONS.get(sceneId);
    if (confession && scenePlayable(confession, app.demo)) return confession;
    throw httpError('scene_not_found', 404);
  };

  app.post('/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<SceneRunResT> => {
    const user = requireUser(req);
    const { sceneId, lang: asked, offerId, preview = false } = SceneStartReq.parse(req.body);
    const script = scriptFor(sceneId, preview);
    const lang: Lang = asked ?? user.lang;

    const current = await repos.sceneRuns.active(user.id);
    const active = current ? await settle(current, user) : null;
    if (active && !active.endedAt) {
      // Starting the scene he is already in resumes it (a second tap, another tab, a reload).
      if (active.sceneId === sceneId) return { run: await view(active), replayed: true };
      await close(active, 'replaced');
    }

    const now = Date.now();
    const star = script.meta.star;
    // Points are charged below, atomically: only the trigger conditions decide "locked" here. Her confession (#55)
    // has its own, exact gate below: the evening is waived in demo mode, so the test site works by day.
    const confessing = !!confessionOf(sceneId);
    // A preview (test site) plays whenever the owner opens it: its time, weather and routine are not asked for.
    const problems = preview ? [] : problemsFor(script, { ...(await triggerContext(app, user, star, now)), points: Number.MAX_SAFE_INTEGER })
      .filter((p) => !(confessing && p === 'slot'));
    if (problems.length) throw httpError('scene_locked', 403);
    // A system scene (#71) belongs to its moment: her birthday, his, her weather message, a promise, late at night.
    if (isSystemScene(sceneId) && !(await openSystemFor(app, user, star, now)).includes(sceneId)) throw httpError('scene_locked', 403);
    const block = confessing ? await confession.blocked(user.id, sceneId, new Date(now)) : null;
    if (block) throw httpError(block, 403);

    // A confession is rewarded whenever it is played: only his yes grants anything, and that happens once.
    const rewardable = confessing || (await repos.sceneRuns.rewardedSince(user.id, sceneId, jstDayStart(now))) < SCENE_RULES.rewardedRunsPerDay;
    const cost = script.meta.cost?.points ?? 0;
    if (cost && !(await repos.users.adjustWallet(user.id, { points: -cost }))) throw httpError('insufficient_points', 402);
    const refund = async () => { if (cost) await repos.users.adjustWallet(user.id, { points: cost }); };

    // #63: the moment's script variables (a heatwave at her window; #70: he owns her variant card) are fixed for the whole run.
    const vars = [...(await sceneVars(repos, star, new Date(now)).catch(() => [])), ...(await ownsVariantOf(user.id, star) ? ['variant'] : [])];
    const began = beginRun(script, { now, lang, newId, rewardable, vars, prompt: promptFor(star), rng: secureRandom });
    if (typeof began === 'string') { await refund(); throw httpError(began, STATUS[began]); }
    const begun = await onePromise(user.id, star, began);
    const row: SceneRunRow = {
      id: newId('scn'), userId: user.id, star, sceneId, step: begun.state.at, seq: 0, state: begun.state, rewarded: rewardable,
      startedAt: iso(now), updatedAt: iso(now), endedAt: begun.state.ended ? iso(now) : null, outcome: begun.state.outcome
    };
    const grant = grantOf(user, star, begun.grant, script, lang, now);
    if (!(await repos.sceneRuns.start(row, grant))) {
      // A parallel start won: his run is that one.
      await refund();
      const winner = await repos.sceneRuns.active(user.id);
      if (winner) return { run: await view(winner), replayed: true };
      throw httpError('scene_conflict', 409);
    }
    // #65: an offer he accepted carries its source (her proposal, or the moment); anything else he asked for himself —
    // a request in chat, or a tap on a scene in her room. An offer that lapsed or belongs to another scene counts as his.
    // Her confession (#55) is hers: she asked him to come tonight.
    const offer = offerId ? await repos.sceneOffers.answer(offerId, user.id, sceneId, 'accepted', iso(now)) : null;
    const source: TriggerSource = offer?.source ?? (confessing ? 'proposed' : 'request');
    // A preview is the owner trying a draft, not a way a scene began (#65's source shares stay the players').
    if (!preview) await app.recordEvent(user.id, 'scene.trigger', { star, sceneId, source });
    await app.recordEvent(user.id, 'scene.start', { star, sceneId });
    // The last step of the variant funnel (#52, #76): he opened the scene of a variant card he has, at this layer.
    // Only a new run counts (resuming one returned above), and never the owner's preview of a draft.
    const { variantCard, variantLayer } = script.meta.trigger;
    if (!preview && variantCard && isVariantCard(variantCard)) {
      await app.recordEvent(user.id, 'variant.scene_opened', { star, cardId: variantCard, ...(variantLayer ? { layer: variantLayer } : {}) });
    }
    if (confessing) await confession.reached(user.id, star, new Date(now));
    if (row.endedAt) await ended(row);
    return { run: await view(row, await together(user, star)), replayed: false };
  });

  app.post('/step', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<SceneRunResT> => {
    const user = requireUser(req);
    const body = SceneStepReq.parse(req.body);
    const run = await own(user, body.runId);
    // An answer to a step that was already answered (a retry after a dropped connection, a double tap) changes
    // nothing and returns where the run is now.
    if (run.endedAt || body.seq < run.seq) return { run: await view(run), replayed: true };
    if (body.seq > run.seq) throw httpError('stale_step', 409);

    const script = scriptById(run.sceneId);
    if (!script) throw httpError('scene_not_found', 404);
    const lang: Lang = body.lang ?? user.lang;
    const sub = toSubmission(body);
    const now = Date.now();
    const ctx = { now, lang, newId };

    const waiting = waitingStep(script, run.state);
    // D-N2: an answer to a step the run is no longer waiting on — it took that step already, and this is a leftover
    // (her countdown on it running out after he had answered it over her lines) — is the same as a repeat: it changes
    // nothing, and is never read as an answer to the step the run waits on now (a `timeout` would be `too_early` there,
    // or worse, taken).
    if (body.step && body.step !== waiting?.id) return { run: await view(run), replayed: true };

    // Free talk goes through the chat path (allowance, persona, memory), but only for an answer the step accepts.
    let free: FreeTurn | undefined;
    if (waiting?.type === 'input' && waiting.mode === 'free' && 'input' in sub) {
      const dry = submitStep(script, run.state, sub, { ...ctx, newId: () => 'dry', free: { reply: '' } });
      if (typeof dry === 'string') throw httpError(dry, STATUS[dry]);
      const talk = sceneTalk(script, waiting.id);
      const { result, reply } = await chat.askFull(await chat.userTurn(user, { star: run.star, text: sub.input, lang }, { scene: talk }));
      const directive = zSceneDirective.safeParse(reply.directive);
      // M4: her reply as the scene shows it fits three subtitle lines (the persona service is asked for that too).
      free = { reply: fitSceneReply(result.reply, lang), directive: directive.success ? directive.data : null };
    }

    // His answer to her confession (#55) is judged by the persona service, and only for an answer the step accepts.
    let verdict: ConfessionAnswer | undefined;
    if (waiting?.type === 'input' && waiting.judge && 'input' in sub) {
      const dry = submitStep(script, run.state, sub, { ...ctx, newId: () => 'dry', verdict: 'not_yet' });
      if (typeof dry === 'string') throw httpError(dry, STATUS[dry]);
      verdict = await confession.judge(run.star, lang, sub.input);
    }

    // His answer to a judged mini-game (#67–#70) is read by the persona service, and only for an answer the step accepts.
    let judged: Judged | undefined;
    if (waiting?.type === 'minigame' && isJudged(waiting.kind) && 'minigame' in sub) {
      const text = sub.minigame.text ?? '';
      const dry = submitStep(script, run.state, sub, { ...ctx, newId: () => 'dry', judged: judgeAnswer(waiting, text, null) });
      if (typeof dry === 'string') throw httpError(dry, STATUS[dry]);
      judged = await judgeGame(app, script, run.state, waiting, text, lang, user);
    }

    // The paid extension (#69 アリス's 「30分延長する」, #74): bought through the voice ledger in the same step that moves
    // the run (sceneRuns.advance), keyed by the step, so a retried answer is paid once and an answer that loses the
    // step to another (a timeout, a second tab) pays nothing. Without the points (402) or past today's extensions
    // (409) the run stays where it is and he can still take the other option.
    const paid = waiting?.type === 'choice' && 'choice' in sub ? waiting.options.find((o) => o.id === sub.choice && o.pay === 'extend') : undefined;
    let extension: SceneExtension | undefined;
    if (paid) {
      const dry = submitStep(script, run.state, sub, { ...ctx, newId: () => 'dry' });
      if (typeof dry === 'string') throw httpError(dry, STATUS[dry]);
      const refused = await extensionRefusal(repos, user.id, now);
      if (refused) throw refused;
      extension = voiceExtension(user, `scene:${run.id}:${run.seq}:extend`, now);
    }

    // A gift (#68 うんぱい's stream, #77): bought in the same step that moves the run, exactly as from the gift sheet —
    // points, the daily cap, her taste and XP. She reacts to what he gave before the scene goes on. Without the points
    // (402) or past today's gifts (409) the run stays where it is and he can pick another option.
    const giftOption = waiting?.type === 'choice' && 'choice' in sub ? waiting.options.find((o) => o.id === sub.choice && o.gift) : undefined;
    let gift: PlannedGift | undefined;
    let given: GiftGiven | undefined;
    if (giftOption) {
      const giftId = giftOption.gift === 'pick' ? body.gift : giftOption.gift;
      if (!giftId || (giftOption.gift !== 'pick' && body.gift !== undefined && body.gift !== giftOption.gift)) throw httpError('invalid_submission', 400);
      gift = await planGift(repos, user.id, run.star, giftId, new Date(now));
      given = {
        result: { kind: 'gift', giftId, taste: gift.taste, xp: gift.plan.row.xp, result: 'win' },
        reply: [giftReactionText(run.star, { giftId, taste: gift.taste, wished: gift.wished })]
      };
      const dry = submitStep(script, run.state, sub, { ...ctx, newId: () => 'dry', gift: given });
      if (typeof dry === 'string') throw httpError(dry, STATUS[dry]);
      const refused = await giftRefusal(repos, gift.plan);
      if (refused) throw refused;
    }

    const stepped = submitStep(script, run.state, sub, { ...ctx, free, verdict, judged, rng: secureRandom, prompt: promptFor(run.star), gift: given });
    if (typeof stepped === 'string') throw httpError(stepped, STATUS[stepped]);
    const moved = await onePromise(user.id, run.star, stepped);
    const next: SceneRunRow = {
      ...run, step: moved.state.at, seq: run.seq + 1, state: moved.state, updatedAt: iso(now),
      endedAt: moved.state.ended ? iso(now) : null, outcome: moved.state.outcome
    };
    const grant = grantOf(user, run.star, moved.grant, script, lang, now);
    if (!(await repos.sceneRuns.advance(next, run.seq, grant, extension, gift?.plan))) {
      const fresh = await repos.sceneRuns.byId(run.id);
      if (!fresh) throw httpError('run_not_found', 404);
      // Still at this step: it was the extension or the gift that was refused (his points, today's extensions or
      // today's gifts went meanwhile).
      if (extension && fresh.seq === run.seq && !fresh.endedAt) throw (await extensionRefusal(repos, user.id, now)) ?? httpError('request_conflict', 409);
      if (gift && fresh.seq === run.seq && !fresh.endedAt) throw (await giftRefusal(repos, gift.plan)) ?? httpError('request_conflict', 409);
      return { run: await view(fresh), replayed: true };
    }
    if (next.endedAt) { await ended(next); await finished(next); }
    if (gift) {
      await app.recordEvent(user.id, 'gift.sent', { star: run.star, giftId: gift.plan.row.giftId, sceneId: run.sceneId });
      // A liked gift he gave is something he now knows she likes (her_wishes), as from the gift sheet.
      if (gift.taste === 'liked') await saveMemory(repos, user.id, run.star, gift.memory, null, [gift.plan.row.giftId]);
    }
    // #74: the time he talked into the mic for this answer counts against his voice time, once per step.
    if (body.voiceMs && ('input' in sub || 'minigame' in sub)) await chargeVoice(app, user, { requestId: `scene:${run.id}:${run.seq}:input`, kind: 'input', seconds: body.voiceMs / 1000 }, now);
    if (verdict && 'input' in sub) await confession.answered(next, grant, sub.input, new Date(now));
    return { run: await view(next, await together(user, run.star)), replayed: false };
  });

  app.post('/end', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<SceneRunResT> => {
    const user = requireUser(req);
    const { runId, reason } = SceneEndReq.parse(req.body);
    const run = await own(user, runId);
    if (run.endedAt) return { run: await view(run), replayed: true };
    return { run: await view(await close(run, reason)), replayed: false };
  });

  /**
   * Entering her room is where a scene begins (#65): the companion home is her idle scene, and this is asked when he
   * enters it, when he has sat there quietly for a while, or when he opens an inbox item that names a scene. The
   * answer is an offer — one line of hers and a yes / not now in the web — or nothing. The moment's offer (a time
   * window, the weather, a stage reached, an inbox event) comes first; otherwise she proposes by chance, within
   * TRIGGER_RULES. Only scenes that may be played in this mode and whose conditions he meets are ever offered.
   */
  app.post('/room', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<SceneRoomResT> => {
    const user = requireUser(req);
    const { star, inboxId } = SceneRoomReq.parse(req.body);
    const now = Date.now();
    const answer = await roomAnswer(user, star, inboxId, now);
    if (answer.offer || !inboxId) return answer;
    // C-room N1: her invitation's scene with no offer for it now — whether it can start now, or when it can (「今晚見」).
    const item = (await repos.inbox.forUser(user.id, 50)).find((i) => i.id === inboxId && i.star === star && i.deliveredAt);
    const sceneId = typeof item?.payload.sceneId === 'string' ? item.payload.sceneId : null;
    const invite = sceneId ? await inviteFor(app, user, star, sceneId, now) : null;
    return invite ? { ...answer, invite } : answer;
  });

  const roomAnswer = async (user: UserRow, star: StarId, inboxId: string | undefined, now: number): Promise<SceneRoomResT> => {
    // Her system scenes open now (#71), most important first.
    const moments = await openSystemFor(app, user, star, now);
    // N-29: on their first meeting she greets him; no scene is offered yet (one he opens from her message is his to open)
    // — N-64: unless a promise with her is due: a promise made today is kept today, first day or not.
    const promiseDue = moments.some((id) => /^promise-(kept|morning)-/.test(id));
    if (!inboxId && !promiseDue && (await firstMeeting(app, user, star, now))) return { offer: null };
    const scripts = offerableFor(app, star, new Set(moments));
    if (!scripts.length) return { offer: null };
    const ctx = await triggerContext(app, user, star, now);
    const ready = scripts.filter((s) => !problemsFor(s, ctx).length).map((s) => s.meta);
    if (!ready.length) return { offer: null };
    const history = await offerHistory(app, user.id, ready.map((m) => m.id), now, user.tz);

    let choice: OfferChoice | null = null;
    if (inboxId && !history.inScene) {
      // An event she sent (wake-up, goodnight, a promise due, first snow, a birthday: #57 #59 #63 #71) opens its scene.
      const item = (await repos.inbox.forUser(user.id, 50)).find((i) => i.id === inboxId && i.star === star && i.deliveredAt);
      const sceneId = typeof item?.payload.sceneId === 'string' ? item.payload.sceneId : null;
      // #8: never one he has played today (finished, it is not offered again at once from the message that invited him).
      if (sceneId && ready.some((m) => m.id === sceneId) && !history.declined.has(sceneId) && !history.playedToday.has(sceneId)) choice = { sceneId, source: 'time', kind: 'time' };
    }
    // The moment comes next and is not left to chance (#71): a promise he came to keep, a birthday, her weather
    // message, goodnight — each once a day, within the daily time offers, never one he just declined or already played.
    // N-64: a promise due now is his to keep — offered whatever today's count of time offers, and again on a later
    // visit in its window (never over a "not now" or once played).
    const promised = (id: string) => /^promise-(kept|morning)-/.test(id);
    // M2: right after a scene, and for the rest of the night after goodnight, she offers nothing of her own — the
    // moment included (chooseOffer holds her proposals back too). A message he opened (above) is his own asking.
    if (!choice && !history.inScene && !offersPaused(history, now)) {
      const moment = moments.find((id) => ready.some((m) => m.id === id) && !history.declined.has(id) && !history.playedToday.has(id)
        && (promised(id) || (history.timeOffersToday < TRIGGER_RULES.maxTimeOffersPerDay && !history.timeOfferedToday.has(id))));
      if (moment) choice = { sceneId: moment, source: 'time', kind: 'time' };
    }
    // Her own proposals never pick a system scene: those are the moment's, above.
    choice ??= chooseOffer({ ready: ready.filter((m) => !isSystemScene(m.id)), history, now, signatureId: WORLD[star].signatureScene.id });
    if (!choice) return { offer: null };
    const row: SceneOfferRow = {
      id: newId('ofr'), userId: user.id, star, sceneId: choice.sceneId, source: choice.source, status: 'open',
      createdAt: iso(now), expiresAt: offerExpiry(now), answeredAt: null
    };
    await repos.sceneOffers.add(row);
    return { offer: offerView(row, scriptById(row.sceneId)!) };
  };

  /** "Not now": she lets it go and does not bring that scene up again for TRIGGER_RULES.declineCooldownMs. */
  app.post('/offer/decline', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { offerId } = SceneOfferDeclineReq.parse(req.body);
    const answered = await repos.sceneOffers.answer(offerId, user.id, null, 'declined', iso(Date.now()));
    return { ok: true as const, declined: !!answered };
  });

  /**
   * The owner's previews (PREVIEWABLE) on the test site: 404 in production. Each plays exactly as written, except that
   * a clip still pending is played by her existing one (packages/shared/src/scenes/media.ts); `pending` lists those.
   */
  app.get('/previews', async (req): Promise<ScenePreviewListResT> => {
    if (!app.demo) throw httpError('not_found', 404);
    requireUser(req);
    return {
      scenes: PREVIEWABLE.map((s) => ({ id: s.meta.id, star: s.meta.star, title: s.meta.title, pending: pendingMedia([s]), games: gamesOf(s) }))
    };
  });

  app.get('/preview/:id', async (req): Promise<ScenePreviewResT> => {
    if (!app.demo) throw httpError('not_found', 404);
    requireUser(req);
    const id = String((req.params as { id: string }).id).slice(0, 64);
    const script = PREVIEWS.get(id);
    const draft = PREVIEWABLE.find((s) => s.meta.id === id);
    if (!script || !draft) throw httpError('scene_not_found', 404);
    const standIns: Record<string, string> = {};
    draft.steps.forEach((s, i) => { const p = script.steps[i]; if (s.type === 'clip' && p.type === 'clip' && s.media !== p.media) standIns[s.media] = p.media; });
    return { script, standIns };
  });

  /** His active run, if any (optionally with one talent): a reload or a reconnect picks it up here. */
  app.get('/current', async (req): Promise<{ run: SceneRunViewT | null }> => {
    const user = requireUser(req);
    const { star } = SceneCurrentQuery.parse(req.query);
    const current = await repos.sceneRuns.active(user.id);
    const run = current ? await settle(current, user) : null;
    if (!run || run.endedAt || (star && run.star !== star)) return { run: null };
    return { run: await view(run) };
  });

  /** One of his runs, ended or not: after a reload the player shows the same ending, memory card included. */
  app.get('/runs/:id', async (req): Promise<{ run: SceneRunViewT }> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    return { run: await view(await own(user, String(id).slice(0, 64))) };
  });
}
