/**
 * The scene player (#64): `/me/scene/:id`. It plays what the engine returns — clips as hard cuts, her lines as
 * subtitles (and voice when recorded and sound is on, the scene's music ducking under it, ./audio.ts), rewards as a
 * float — then waits on his answer. The run itself lives on the server (prototype mode: this browser), so a reload or
 * a dropped connection picks up where it was.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { localText } from '@jstar/shared/domain';
import { lineToSay, previewScript, sceneById, sceneMemoryTitle, type ClipStep, type SceneScript, type SceneStep } from '@jstar/shared/scenes';
import { answerOfOutcome, confessionOf } from '@jstar/shared/confession';
import { systemSceneOf } from '@jstar/shared/scenes/systemIds';
import { getStar } from '../data/cast';
import { fmtDate, starFirst, starName, type Key } from '../i18n';
import { uid, useStore, useT } from '../lib/store';
import { soundOn, stopVoice } from '../lib/sound';
import { playVoiceOnce, preloadVoice, stopAll, voiceDuration, voiceTime, type Voice } from './voiceChannel';
import { usePortrait, useSceneMediaState } from '../components/stage';
import { Icon, Toast, useToast } from '../components/ui';
import { asrOn, bondOf, bootstrap, chat, errorCode, isBlocked, isDemo, keepConfessionVoice, serverMode } from '../services/api';
import { http } from '../services/http';
import { canRecord } from '../lib/voice';
import { VOICE_RULES } from '@jstar/shared/rules';
import { lineRequestId, speakLine } from '../lib/ttsQueue';
import { clipUrl, releaseClipUrl } from '../lib/clipUrl';
import { ExtendSheet, VoiceMeter, extendBlock, minutesLeft, takeLowNotice } from '../components/voiceMinutes';
import { AlarmProposal } from '../components/alarmProposal';
import { GiftSheet, giftName } from '../components/gift';
import { giftById } from '@jstar/shared/gifts';
import { StreamLayer, type Comment } from './stream';
import {
  answerTarget, answeredAt, currentScene, endScene, leftOver, registerScripts, rememberRun, rememberedRun, sceneRun, startScene, stepScene, tookIt,
  type LocalDeps, type SceneSubmission, type SceneView, type StepAt
} from './client';
import { Phrased } from './phrases';
import { ClipStage, baseLoop, clipEntry, holdStage, isCloseShot, slowNetwork, stallSpoken, warmPoster, type StageHandle } from './stage';
import { AffinityFloat, Choices, Countdown, InputBar, Subtitle, type Pager } from './ui';
import { timeScale, useIdle } from './idle';
import { useSceneAudio } from './audio';
import { LipsyncVideo } from '../components/lipsyncVideo';
import { LIPSYNC_FADE_MS, clipTimeFor, cutStartFor, lipsyncSrc, loadLipsyncManifest, loadLipsyncPhases, phaseSrc, startPlan, upcomingRenders, type LipsyncManifest, type LipsyncPhases } from '../lib/lipsync';
import './scene.css';

const e2e = () => !!(window as unknown as { __E2E__?: boolean }).__E2E__;
/** Reading time for a subtitle without a recording; e2e plays lines quickly. */
/** M4: a line past three subtitle lines is read in pages, so a long one gets the time to read them all. */
const lineMs = (text: string) => (e2e() ? 150 : Math.min(15_000, Math.max(2200, 1400 + 110 * [...text].length)));
const holdMs = (s: number | undefined) => (s ?? 0) * 1000 * (e2e() ? 0.05 : 1);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How long a late clip is covered by her stall lines before the cut happens anyway (#64). */
const STALL_MS = 7200;
/** How long a clip may take before it counts as late (N-33): a normal connection buffers within this. */
const LATE_MS = 1800;
/** After his answer: her typing dots after this long, and her 「えっと……」 only after this (N-40). */
export const THINK_DOTS_MS = 700;
export const THINK_LINE_MS = 4000;
/** Her stall lines, as the dictionary keeps them (`a|b|c`). */
export const stallLines = (all: string): string[] => all.split('|').map((l) => l.trim()).filter(Boolean);

/** Her recorded line, when sound is on; resolves when she finishes (or it cannot play). */
function speak(url: string): Voice | null {
  if (!soundOn() || e2e()) return null;
  return playVoiceOnce(url);
}

/** Her talk loops (stage.tsx baseLoop): cut to as her line starts, so on their frame 0 then. */
const TALK_LOOP = /-(talk|talkclose)-(9x16|16x9)$/;

/** #73: resolves, frame by frame, once `done()` holds, or after `ms` at most. */
const until = (done: () => boolean, ms: number): Promise<void> => new Promise((resolve) => {
  const end = performance.now() + ms;
  const tick = () => (done() || performance.now() > end ? resolve() : void requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});

/** #73: the clip has reached `atS` — or, `atS` 0, come round its loop to frame 0 — within `waitS` (+ a margin). */
function reach(v: HTMLVideoElement, atS: number, waitS: number): Promise<void> {
  let last = v.currentTime;
  return until(() => {
    const t = v.currentTime;
    const there = atS ? t >= atS - 1 / 96 : t < last || t >= v.duration - 1 / 48;
    last = t;
    return there || v.paused;
  }, waitS * 1000 + 150);
}

/** #73: her voice is really sounding (its clock past 0), or has ended, or 2 s have passed. */
function sounding(voice: Voice): Promise<void> {
  let over = false;
  void voice.done.then(() => { over = true; });
  return until(() => over || (voiceTime() ?? 0) > 0, 2000);
}

/**
 * H3: her line's render is buffered enough to start with her (HAVE_FUTURE_DATA), or `ms` have passed: her voice waits
 * for it — her clip held on the render's first frame — so her mouth moves from her first syllable, not 0.3–1 s in.
 */
const renderReady = (src: string, ms: number): Promise<void> => until(() => {
  const box = [...document.querySelectorAll<HTMLElement>('[data-testid="lipsync"]')].find((d) => d.dataset.src === src);
  const v = box?.querySelector('video');
  return !!v && v.readyState >= 3;
}, ms);
/** How long her voice may wait for her render to be ready (the hold is a still frame, as at any cut). */
const RENDER_WAIT_MS = 900;

/** Plays one piece of her voice (a recorded file, or a sentence of her runtime voice as a data URL, #73), alone (N-32). */
const playAudio = (src: string) => playVoiceOnce(src);

/** StrictMode mounts twice in development: both mounts share one start, so a scene never starts twice. */
const inflight = new Map<string, Promise<{ view: SceneView; fresh: boolean }>>();
function once(key: string, fn: () => Promise<{ view: SceneView; fresh: boolean }>) {
  let p = inflight.get(key);
  if (!p) { p = fn().finally(() => setTimeout(() => inflight.delete(key), 0)); inflight.set(key, p); }
  return p;
}

/** The clip on screen at the step a run waits on: the last clip it played, else the nearest one before it in the script. */
function clipBefore(script: SceneScript, view: SceneView): ClipStep | null {
  const inBeats = [...view.beats].reverse().find((b): b is ClipStep => b.type === 'clip');
  if (inBeats) return inBeats;
  const at = view.waiting?.id ?? view.beats[view.beats.length - 1]?.id;
  const k = script.steps.findIndex((s) => s.id === at);
  for (let i = (k < 0 ? script.steps.length : k) - 1; i >= 0; i--) { const s = script.steps[i]; if (s.type === 'clip') return s; }
  return script.steps.find((s): s is ClipStep => s.type === 'clip') ?? null;
}

/** A clip step's footage: its own, or — a variant's footage missing from this build (#70, #81) — the shot as written. */
const footageOf = (c: ClipStep | null | undefined, portrait: boolean) => (c && !clipEntry(c.media, portrait) && c.fallback ? c.fallback : c?.media);
/**
 * What the stage plays for a clip step: its footage, and on her wide and close shots her base loops (./stage.tsx
 * `baseLoop`, #80) — talking while her line plays, listening otherwise.
 */
const clipOf = (c: ClipStep | null | undefined, portrait: boolean, speaking = false) =>
  clipEntry(baseLoop(footageOf(c, portrait), speaking, portrait), portrait);

interface Line { text: string; speaking: boolean; filler?: boolean; key: number }

export default function ScenePlayer() {
  const { id = '' } = useParams();
  // A scene production cannot play yet, previewed on the test site (`/me/preview`): its script comes from the API.
  const preview = new URLSearchParams(useLocation().search).get('preview') === '1';
  const found = preview ? undefined : sceneById(id);
  // A bundled script with clips still pending (#80, #81) plays only in demo mode (the publish rule), her existing
  // clips standing in; a script whose clips all exist comes back as it is.
  const bundled = useMemo(() => (found ? previewScript(found) : undefined), [found]);
  // Her confession (#55) and the system scenes (#71) are built from her lines, which load only when one opens (they
  // stay out of this chunk).
  const lazy = !bundled && !preview && (!!confessionOf(id) || !!systemSceneOf(id));
  const [loaded, setLoaded] = useState<{ id: string; script: SceneScript | null; standIns?: number } | null>(null);
  useEffect(() => {
    if (!preview) return;
    let live = true;
    if (!serverMode() || !isDemo()) { setLoaded({ id, script: null }); return; }
    void http.scenePreview(id).then((r) => { if (live) setLoaded({ id, script: r.script as SceneScript, standIns: Object.keys(r.standIns ?? {}).length }); }, () => { if (live) setLoaded({ id, script: null }); });
    return () => { live = false; };
  }, [id, preview]);
  useEffect(() => {
    if (!lazy) return;
    let live = true;
    const find = confessionOf(id)
      ? import('@jstar/shared/scenes/confession').then((m) => m.confessionSceneById(id))
      : import('@jstar/shared/scenes/system').then((m) => m.systemSceneById(id));
    void find.then((found) => {
      const s = found ?? null;
      if (s) registerScripts([s]);
      if (live) setLoaded({ id, script: s });
    }, () => { if (live) setLoaded({ id, script: null }); });
    return () => { live = false; };
  }, [id, lazy]);
  // The scenes' clips are a lazy catalogue (data/media.ts): every clip is resolved against it, so the player waits
  // for it (already here when he comes from her room, which preloads it) with the same quiet placeholder.
  const media = useSceneMediaState();
  const mediaReady = media.state === 'ready';
  const script = bundled ?? (loaded?.id === id ? loaded.script : undefined);
  // N-48: never a scene on an empty stage — the catalogue could not be loaded after its tries: say so, with a retry
  // (it keeps trying in the background too, and the scene opens the moment it comes).
  if (media.state === 'failed') return <MediaRetry onRetry={media.retry} />;
  if (!mediaReady || (script === undefined && (lazy || preview))) return <div className="scn" data-testid="scene"><p className="scn-prompt scn-wait" role="status">…</p></div>;
  if (!script) return <SceneError code="scene_not_found" />;
  // N-18: 「仮の映像」 only when a clip of this scene really is stood in (the API's stand-ins, or a bundled script demo mode patched).
  const standIn = preview ? !!(loaded?.id === id && loaded.standIns) : !!found && bundled !== found;
  return <Player key={`${id}${preview ? '~preview' : ''}`} script={script} preview={preview} standIn={standIn} />;
}

/** N-48, kept in this chunk (off the entry dictionary): the scene's clips could not be loaded. */
const MEDIA_FAILED: Record<string, { msg: string; retry: string }> = {
  ja: { msg: '映像を読み込めませんでした。通信の状態を確かめて、もう一度お試しください。', retry: 'もう一度' },
  'zh-Hant': { msg: '影片載入失敗。請確認網路狀態後再試一次。', retry: '再試一次' },
  en: { msg: "Her clips couldn't be loaded. Check your connection and try again.", retry: 'Try again' },
  ko: { msg: '영상을 불러오지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.', retry: '다시 시도' }
};
/** Copy only the scene player says, kept in this lazy chunk (off the entry's dictionary, as MEDIA_FAILED). */
const SCENE_TEXT: Record<'endKept' | 'replaced' | 'stepFailed' | 'retry' | 'startFailed', Record<string, string>> = {
  endKept: { ja: '約束、ちゃんと守ってくれたね。ありがとう。', 'zh-Hant': '約好的事，你真的做到了。謝謝你。', en: 'You kept your promise. Thank you.', ko: '약속, 지켜 줬네. 고마워.' },
  replaced: { ja: 'この場面は、別の画面で続いています。', 'zh-Hant': '這個場景已在另一個裝置上繼續。', en: 'This scene went on on another device.', ko: '이 장면은 다른 기기에서 이어지고 있어요.' },
  stepFailed: { ja: '届きませんでした。もう一度送ってください。', 'zh-Hant': '沒有送達。', en: "That didn't go through.", ko: '전달되지 않았어요.' },
  retry: { ja: 'もう一度', 'zh-Hant': '再試一次', en: 'Try again', ko: '다시 시도' },
  startFailed: { ja: '場面を始められませんでした。通信の状態を確かめて、もう一度お試しください。', 'zh-Hant': '場景無法開始。請確認網路狀態後再試一次。', en: "The scene couldn't start. Check your connection and try again.", ko: '장면을 시작하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.' }
};
const sceneText = (k: keyof typeof SCENE_TEXT, lang: string) => SCENE_TEXT[k][lang] ?? SCENE_TEXT[k].ja;

function MediaRetry({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  const m = MEDIA_FAILED[t.lang] ?? MEDIA_FAILED.ja;
  return (
    <div className="scn scn-error" role="alert" data-testid="scene-media-failed">
      <p>{m.msg}</p>
      <button type="button" className="btn btn-rose" onClick={onRetry}>{m.retry}</button>
      <Link to="/me/home" className="btn-text">{t('scene.back')}</Link>
    </div>
  );
}

/** Refusals that are the answer, not a failure: no retry for them. */
const FINAL = new Set(['confession_tonight', 'confession_waiting', 'scene_locked', 'scene_not_found', 'points', 'insufficient_points', 'daily_limit']);
function SceneError({ code, first, onRetry }: { code: string; first?: string; onRetry?: () => void }) {
  const t = useT();
  const retry = !!onRetry && !FINAL.has(code);
  const msg = code === 'confession_tonight' ? t('confession.tonight', { first: first ?? '' })
    : code === 'confession_waiting' ? t('confession.waiting')
      : code === 'scene_locked' ? t('scene.locked') : retry ? sceneText('startFailed', t.lang) : t('scene.error');
  return (
    <div className="scn scn-error" role="alert" data-testid="scene-error" data-code={code}>
      <p>{msg}</p>
      {/* L8: a start that failed is tried again here; her room is the way out. */}
      {retry && <button type="button" className="js-btn-rose" data-testid="scene-retry" onClick={onRetry}>{sceneText('retry', t.lang)}</button>}
      <Link to="/me/home" className={retry ? 'js-btn-line' : 'js-btn-rose'}>{t('scene.back')}</Link>
    </div>
  );
}

function Player({ script, preview = false, standIn = false }: { script: SceneScript; preview?: boolean; standIn?: boolean }) {
  const { state, actions } = useStore();
  const t = useT();
  const portrait = usePortrait();
  const nav = useNavigate();
  const star = getStar(script.meta.star);
  const first = starFirst(star, t.lang);
  const sceneId = script.meta.id;
  // The offer he accepted in her room or in chat (#65), if he came from one.
  const offerId = new URLSearchParams(useLocation().search).get('offer')?.slice(0, 64) || undefined;
  /** Her confession (#55): his answer is judged, may keep his voice (with consent), and becomes their anniversary. */
  const confession = confessionOf(sceneId);
  /**
   * `{name}` in her lines (#56): what she calls him (the API's call name) — never the account nickname, which for an
   * e-mail account is his address's handle (round 10). With no name yet, her line without it, or 「きみ」/you.
   */
  const [callName, setCallName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void bondOf(script.meta.star, t.lang).then((b) => { if (live) setCallName(b?.callName ?? null); });
    return () => { live = false; };
  }, [script.meta.star, t.lang]);
  const name = callName ?? '';
  /** Signatures of her runtime-voice lines (#73) by beat id and language: only these are spoken in her voice. */
  const voiceSigs = useRef<Record<string, Record<string, string>>>({});
  const [keepVoice, setKeepVoice] = useState(false);
  /** The recording of his last spoken answer, kept in this tab only until he says yes (and only if he ticked the box). */
  const clip = useRef<Blob | null>(null);
  const [voiceKept, setVoiceKept] = useState<boolean | null>(null);
  const canKeep = !!confession && serverMode() && asrOn() && canRecord();
  const stateRef = useRef(state);
  stateRef.current = state;

  const [view, setView] = useState<SceneView | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What plays now: `seq` is the run's seq these beats are of (D-N2: the wait they end on is answered at it). */
  const [queue, setQueue] = useState<{ beats: SceneStep[]; i: number; key: number; seq: number }>({ beats: [], i: 0, key: 0, seq: 0 });
  const [shot, setShotState] = useState<ClipStep | null>(null);
  const shotRef = useRef<ClipStep | null>(null);
  /** When the shot on screen was cut to: her lip-synced layer joins its slow push-in where it is (scene.css). */
  const shotAt = useRef(0);
  const setShot = useCallback((c: ClipStep | null) => { if (c !== shotRef.current) shotAt.current = performance.now(); shotRef.current = c; setShotState(c); }, []);
  // #73: her recorded lines lip-synced onto the clips they play over (lib/lipsync.ts); loaded with the player.
  const lipsyncList = useRef<LipsyncManifest | null>(null);
  const [lipsyncReady, setLipsyncReady] = useState(false);
  const lipsyncPhases = useRef<LipsyncPhases | null>(null);
  useEffect(() => {
    void Promise.all([loadLipsyncManifest(), loadLipsyncPhases()]).then(([m, ph]) => { lipsyncList.current = m; lipsyncPhases.current = ph; setLipsyncReady(true); });
  }, []);
  /** #73: phase renders of her next line, for where the clip is expected to be when it starts (loaded ahead). */
  const [prefetch, setPrefetch] = useState<(string | null)[]>([]);
  /**
   * The line playing with a render: its render, the clip under it (and whether that clip loops), whether her voice was
   * asked to play (from then the render follows `voiceTime`), and the shot's age (it joins the shot's push-in there).
   */
  const [lip, setLip] = useState<{ src: string; key: number; voiced: boolean; delay: number; clip: string; loop: boolean; offset: number } | null>(null);
  /** The render on screen now (its video), while it has taken over from the clip. */
  const lipShown = useRef<HTMLVideoElement | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  /** M4: her subtitle's pages turn with how much of her line she has said: her voice's clock, else its reading time. */
  const lineClock = useRef<{ at: number; ms: number; voiced: boolean } | null>(null);
  const pager = useRef<Pager | null>(null);
  const progress = useCallback(() => {
    const c = lineClock.current;
    if (!c) return 0;
    const d = voiceDuration(), at = voiceTime();
    if (c.voiced && d && at !== null) return at / d;
    return (performance.now() - c.at) / c.ms;
  }, []);
  /** A tap on her picture (or Enter): her subtitle's next page, and past its last, her next line. */
  const tapLine = useCallback(() => { if (!pager.current?.next()) skip.current?.(); }, []);
  /**
   * M3: the step he just answered (at the run's seq it was answered at), and whether the scene waits on it again
   * (free talk goes on): its question and her patience's countdown are not put back up over her reply — the timer
   * still runs, and the scene moves on in silence. D-M3: the very wait he answered over her lines (#72) is not put up
   * at all when her lines reach it.
   */
  const answered = useRef<StepAt | null>(null);
  /** D-N2: the wait on screen, at the run's seq the scene came to it: his answer (or her countdown) is for that seq. */
  const shownAt = useRef<StepAt | null>(null);
  /** D-M3: the answered wait her lines reached while his answer was on its way, put up if that answer fails. */
  const parked = useRef<{ at: StepAt; beat: SceneStep } | null>(null);
  /** L6: when his last answer's result (her hand, えいみ's score) came, shown for a moment from then. */
  const [resultAt, setResultAt] = useState<number | null>(null);
  useEffect(() => {
    if (!resultAt) return undefined;
    const id = setTimeout(() => setResultAt(null), 5000 * timeScale());
    return () => clearTimeout(id);
  }, [resultAt]);
  /** M14: his answer that did not go through (a 500, offline), kept to send again. */
  const [failed, setFailed] = useState<{ sub: SceneSubmission; said?: string; voiceMs?: number } | null>(null);
  /**
   * M10: the date timer (#69) whose closing he reached before it ran out (its `onEnd` step played): the countdown goes,
   * rather than counting on through her goodbye. An extension sets a new timer, which shows again.
   */
  const [closedTimer, setClosedTimer] = useState<string | null>(null);
  const closingSteps = useMemo(() => new Set(script.steps.flatMap((st) => (st.type === 'effect' && st.timer?.onEnd ? [st.timer.onEnd] : []))), [script]);
  const [rewait, setRewait] = useState(false);
  const [waiting, setWaiting] = useState<SceneStep | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [mine, setMine] = useState<string | null>(null);
  const [float, setFloat] = useState<{ n: number; stamp: number } | null>(null);
  const [ended, setEnded] = useState(false);
  const [deadline, setDeadline] = useState<{ endsAt: number; total: number } | null>(null);
  const [subs, setSubs] = useState(() => { try { return localStorage.getItem('jstar.subs') !== 'off'; } catch { return true; } });
  const [toast, setToast] = useToast();
  const applied = useRef(0);
  const skip = useRef<(() => void) | null>(null);
  /** Her recorded line while it plays, so he can talk over it (#72). */
  const herVoice = useRef<{ stop: () => void } | null>(null);
  /** He spoke over her: the rest of her lines in this segment are dropped until the scene waits on him again. */
  const hushed = useRef(false);
  const stage = useRef<StageHandle | null>(null);
  /**
   * #73: the clip under her render moved to the render's frame (both run from the clip's frame 0 at her line's start),
   * so handing over between them shows no jump. Resolves once the clip is there (or after 250 ms at most).
   */
  const lineUp = useCallback((clipId: string, render: HTMLVideoElement, loop: boolean, offset = 0) => new Promise<void>((resolve) => {
    const base = stage.current?.video?.(clipId);
    // `offset`: the clip time the render's first frame is (a phase render starts on the clip's frame p, not 0).
    const at = base ? clipTimeFor(offset + render.currentTime + (render.paused ? 0 : 0.03), base.duration, loop) : null;
    if (!base || at === null) { resolve(); return; }
    const done = () => { clearTimeout(timer); base.removeEventListener('seeked', done); resolve(); };
    const timer = setTimeout(done, 250);
    base.addEventListener('seeked', done);
    try { base.currentTime = at; } catch { done(); }
  }), []);
  const loopsRef = useRef<Record<string, boolean>>({});
  /** #73: the clip held on its frame 0 while her lip-synced line waits for her voice; where cuts start clips. */
  const [held, setHeld] = useState<string | null>(null);
  const startAt = useRef<Record<string, number>>({});
  /**
   * #73: a cut to a scene clip whose next beat (past effects) is her lip-synced line on it: the clip starts where it
   * comes round to its frame 0 just as that line is due, so her line starts on the render's first frame.
   */
  /** #73: the recording a line plays (lip-sync looks its render up by it). */
  const voiceOf = (b: SceneStep) => (b.type === 'line' ? lineToSay(b, { lang: t.lang, name, runtimeVoice: false, you: t('confession.you') }).voice : undefined);
  const timeCut = (beat: ClipStep) => {
    const id = clipOf(beat, portrait)?.id;
    if (!id) return;
    delete startAt.current[id];
    if (TALK_LOOP.test(id) || !(loopsRef.current[id] ?? true) || !lipsyncList.current || !soundOn() || e2e()) return;
    let wait = holdMs(beat.hold) / 1000;
    for (let k = queue.i + 1; k < queue.beats.length; k++) {
      const b = queue.beats[k];
      if (b.type === 'effect') { wait += 0.5; continue; }
      if (b.type !== 'line') return;
      if (!lipsyncSrc(lipsyncList.current, clipOf(beat, portrait, true)?.id, voiceOf(b))) return;
      const s0 = cutStartFor(stage.current?.video?.(id)?.duration ?? Number.NaN, wait);
      if (s0 !== null) startAt.current[id] = s0;
      return;
    }
  };
  /**
   * H3: he picked an answer — while the server takes it, the phase renders of her first line on that way are loaded for
   * where her clip will be when the reply comes (about a second on), so that line starts lip-synced.
   */
  const warmAfter = (stepId: string | undefined) => {
    const k = stepId ? script.steps.findIndex((st) => st.id === stepId) : -1;
    const first = k < 0 ? undefined : script.steps.slice(k).find((st) => st.type !== 'effect');
    const clipId = clipOf(shotRef.current, portrait, true)?.id;
    const b = clipId ? stage.current?.video?.(clipId) : undefined;
    const ph = lipsyncPhases.current;
    const c = clipId ? ph?.clips[clipId] : undefined;
    const voice = first && voiceOf(first);
    if (!first || first.type !== 'line' || !b || !ph || !c || !voice || !soundOn() || e2e() || TALK_LOOP.test(clipId!)) return;
    const fps = c.n / b.duration;
    const at = Math.ceil((((b.currentTime + 1) % b.duration) * fps) / ph.step) * ph.step;
    const srcs = [0, 1, 2, 3].map((i) => phaseSrc(ph, clipId, voice, (at + i * ph.step) % c.n)).filter((x): x is string => !!x);
    if (srcs.length) setPrefetch(srcs);
  };
  const warm = useRef(warmAfter);
  warm.current = warmAfter;
  /** The paid option (#69 アリス's extension, #74) whose confirm sheet is open. */
  const [paying, setPaying] = useState<string | null>(null);
  // Her music and the weather at her window (#82): with sound on, after his first tap, ducked while she speaks.
  useSceneAudio(script, shot, view?.id);
  /** The gift option (#68) whose gift sheet is open: he picks, the step buys it. */
  const [giving, setGiving] = useState<string | null>(null);
  const sheet = giving !== null || paying !== null;
  /** うんぱい's stream is on air (#68): the run's `live`, as its beats play. */
  const [live, setLive] = useState(false);
  /** His comments (and gifts) in the stream, oldest first. */
  const [comments, setComments] = useState<Comment[]>([]);
  const commentId = useRef(0);
  /** A clip is late (#64): her idle loop plays, with her stall line, instead of a frozen frame. */
  const [stalling, setStalling] = useState(false);
  /** Her quiet typing dots while her answer to him is on its way (N-40). */
  const [thinking, setThinking] = useState(false);
  /** Stall lines she said this scene, and whether the last hold stalled (N-33: never twice in a row). */
  const stallsSaid = useRef(0);
  const lastStalled = useRef(false);

  /** The player's lease on the chat path, for free talk in prototype mode (the API does this itself). */
  const deps = useCallback((): LocalDeps => ({
    affinity: stateRef.current.affinity[script.meta.star],
    freeTalk: async (said: string) => {
      const r = await chat(stateRef.current, script.meta.star, said, t.lang);
      actions.applyChat(script.meta.star, r);
      actions.chatAppend(script.meta.star, [{ id: uid(), from: 'me', text: said }, { id: uid(), from: 'her', text: r.reply },
        ...(r.memoryCard ? [{ id: uid(), from: 'system' as const, text: r.memoryCard.title, kind: 'memory' as const }] : [])]);
      return r.reply;
    }
  }), [actions, script.meta.star, t.lang]);

  /** Takes a view as the truth; `fresh` = rewards in it are new to this screen (not a reload of known state). */
  const adopt = useCallback((v: SceneView, fresh: boolean) => {
    viewRef.current = v;
    // Her lines the server signed for her runtime voice (#73), kept by beat id for when they play.
    if (v.voiceSigs) Object.assign(voiceSigs.current, v.voiceSigs);
    setView(v);
    rememberRun(sceneId, v.id);
    // She reached her confession: the home no longer opens on it today (the API records it itself).
    if (confession && fresh && v.seq === 0) actions.reachConfession(v.star);
    // #68: the stream is as the run says — unless this change's own beats take it up or down, at their moment.
    if (!v.beats.some((b) => b.type === 'effect' && b.live !== undefined)) setLive(!!v.live);
    const gained = fresh ? v.rewards.affinity - applied.current : 0;
    applied.current = v.rewards.affinity;
    actions.applyScene(v.star, serverMode() ? v.affinityXp : null, gained, v.rewards.memories, v.sceneId);
  }, [actions, sceneId, confession]);

  const play = (beats: SceneStep[], seq: number) => { hushed.current = false; parked.current = null; setQueue((q) => ({ beats, i: 0, key: q.key + 1, seq })); };

  /** He started talking: her voice stops at once, and her line with it (#72). */
  const interrupt = useCallback(() => {
    stopVoice();
    herVoice.current?.stop();
    herVoice.current = null;
    hushed.current = true;
    skip.current?.();
  }, []);

  /** After a reload: the shot and her last line as they were, then the waiting step (or the ending). */
  const resume = useCallback((v: SceneView) => {
    setShot(clipBefore(script, v));
    setLive(!!v.live);
    if (v.status === 'ended') { setEnded(true); setWaiting(null); return; }
    const lastLine = [...v.beats].reverse().find((b) => b.type === 'line');
    play([...(lastLine ? [lastLine] : []), ...(v.waiting ? [v.waiting] : [])], v.seq);
  }, [script, setShot]);

  /**
   * A fresh read of the run, played on: its new beats, or — M11: ended without an ending of its own (another device
   * started a scene, the 30-minute cap) — the end card, never his free talk going on into a run that is over.
   */
  const follow = useCallback((fresh: SceneView) => {
    if (fresh.status === 'ended' && !fresh.beats.some((b) => b.type === 'end')) { adopt(fresh, false); setDeadline(null); resume(fresh); return; }
    adopt(fresh, true);
    play(fresh.beats, fresh.seq);
  }, [adopt, resume]);
  /** L8: a start that failed (a 500, the network) can be tried again from its error screen. */
  const [attempt, setAttempt] = useState(0);

  // Load: this tab's run, else his active run of this scene, else a new one.
  useEffect(() => {
    let live = true;
    stopVoice();
    once(sceneId, async () => {
      const aff = stateRef.current.affinity[script.meta.star];
      const kept = rememberedRun(sceneId);
      const byTab = kept ? await sceneRun(kept, aff).catch(() => null) : null;
      if (byTab && byTab.sceneId === sceneId) return { view: byTab, fresh: false };
      const current = await currentScene(aff).catch(() => null);
      if (current && current.sceneId === sceneId) return { view: current, fresh: false };
      const r = await startScene(sceneId, t.lang, deps(), offerId, preview);
      return { view: r.run, fresh: !r.replayed };
    }).then(({ view: v, fresh }) => {
      if (!live) return;
      adopt(v, fresh);
      if (fresh) play(v.beats, v.seq); else resume(v);
    }).catch((e) => { if (live) setError(errorCode(e)); });
    return () => { live = false; };
  }, [sceneId, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // The beat runner: one beat at a time; clips cut, lines wait (or are skipped), waiting steps stop the run.
  useEffect(() => {
    const beat = queue.beats[queue.i];
    if (!beat) return;
    let cancelled = false;
    const next = () => { if (!cancelled) setQueue((q) => (q.key === queue.key ? { ...q, i: q.i + 1 } : q)); };
    // N-33/N-35: a late clip is waited out over her listening loop (close stays close); her stall line only where it
    // fits — see stallSpoken — and the hold itself only when the clip is really late.
    const hold = async (target: string | undefined, onShot: ClipStep | null) => {
      if (e2e() || hushed.current) return;
      const after = queue.beats[queue.i + 1];
      const spoken = stallSpoken({
        tender: !!confession || isCloseShot(onShot) || isCloseShot(shotRef.current),
        beforeAnswer: !!after && (after.type === 'input' || after.type === 'choice' || after.type === 'minigame'),
        said: stallsSaid.current, lastStalled: lastStalled.current, slow: slowNetwork()
      });
      let stalled = false;
      await holdStage({
        stage: stage.current, target, idle: listenOf(shotRef.current)?.id, quickMs: shotRef.current ? LATE_MS : 2500, stallMs: STALL_MS,
        lines: spoken ? stallLines(t(`scene.stall.${script.meta.star}` as Key)).slice(0, 1) : [], cancelled: () => cancelled,
        onStall: (on) => { if (on) stalled = true; setStalling(on); },
        onLine: (text) => { stallsSaid.current++; setLine({ text, speaking: true, filler: true, key: Date.now() }); }
      });
      lastStalled.current = stalled;
    };
    if (closingSteps.has(beat.id) && viewRef.current?.timerEndsAt) setClosedTimer(viewRef.current.timerEndsAt);
    const run = async () => {
      if (beat.type === 'clip') {
        // Latency mask (#64, N-17): a cut whose clip — her base loop included — is not buffered yet gets her stall
        // line over her idle loop, never a frozen or empty frame; the scene's first cut is held the same way.
        await hold(clipOf(beat, portrait)?.id, beat);
        if (cancelled) return;
        timeCut(beat);
        setShot(beat);
        await sleep(hushed.current ? 0 : holdMs(beat.hold));
        next();
      } else if (beat.type === 'line') {
        // Talked over: she lets him speak instead of finishing her lines.
        if (hushed.current) { next(); return; }
        // Her runtime voice (#73): a line that could not be recorded in advance (her free-talk reply, a `tts` line, one
        // with his name), for the accounts it is on for, with sound on and voice time left. Otherwise her recording —
        // for a line with his name, the same moment without it (`unnamed`, #83) — or subtitles, as always.
        const v = stateRef.current.voice;
        // Only a line the server signed for her voice (#73): otherwise her recording (or `unnamed`), as before.
        const sig = voiceSigs.current[beat.id]?.[t.lang];
        const runtimeVoice = serverMode() && soundOn() && !e2e() && !!v?.tts && (v.ttsStars?.includes(script.meta.star) ?? true) && v.leftSeconds > 0 && !!sig;
        const say = lineToSay(beat, { lang: t.lang, name, runtimeVoice, you: t('confession.you') });
        const said = say.text;
        if (say.runtime) {
          const key = Date.now();
          // Her sentences appear as she says them: the newest page shows.
          lineClock.current = { at: performance.now(), ms: 1, voiced: false };
          const id = lineRequestId();
          const speech = speakLine(said, {
            fetch: (_sentence, i) => http.tts({ star: script.meta.star, line: localText(beat.text, t.lang).trim(), sig: sig!, index: i, lang: t.lang, requestId: `${id}:${i}` }),
            // blob: URLs, as in her room (the page's CSP refuses data: media).
            play: (clip) => {
              const src = clip.mode === 'voice' ? clipUrl(clip) : clip.url;
              const v = playAudio(src);
              if (clip.mode === 'voice') void v.done.then(() => releaseClipUrl(clip));
              return v;
            },
            prepare: (clip) => preloadVoice(clipUrl(clip))
          }, {
            // Each sentence appears as she starts to say it.
            onSentence: (i, all) => { if (!cancelled) setLine({ text: all.slice(0, i + 1).join(''), speaking: true, key }); },
            onLeft: (n) => actions.voiceLeftNow(n)
          });
          herVoice.current = speech;
          const skipped = new Promise<'skip'>((r) => { skip.current = () => r('skip'); });
          const out = await Promise.race([speech.done, skipped]);
          if (out === 'skip') speech.stop();
          else if (out.mode !== 'voice' && !cancelled) {
            // Off, out of minutes, offline or failed: the line — or what she had not said yet — as subtitles.
            setLine({ text: said, speaking: true, key });
            lineClock.current = { at: performance.now(), ms: lineMs(said), voiced: false };
            await Promise.race([sleep(lineMs(out.mode === 'cut' ? speech.sentences.slice(out.said).join('') : said)), skipped]);
          }
          skip.current = null;
          if (herVoice.current === speech) herVoice.current = null;
          if (cancelled) return;
          setLine((l) => (l ? { ...l, text: said, speaking: false } : l));
          next();
          return;
        }
        // N-17: her line waits for the clip that shows her saying it (her talk loop) — never over an empty stage.
        await hold(clipOf(shotRef.current, portrait, true)?.id, shotRef.current);
        if (cancelled) return;
        // #73: her line lip-synced onto the clip on screen while she says it, when it was rendered (and loaded ahead,
        // see `lipLayers`); it follows her voice's clock, and the clip underneath is lined up with it at both handovers.
        // A render begins on its clip's frame 0, so her line starts lip-synced only with the clip there (QA of d53e8ba:
        // no pose change at the takeover): her talk loop is cut to its frame 0 as her line starts and held there; a
        // scene clip comes round to it (timed at its cut, `cutStartFor`, or within LIPSYNC_ALIGN_WAIT_S of its loop).
        // Anything else plays her clip as it is, without the render.
        // With phase renders (every 7th frame of a scene clip, 720p), it starts wherever the clip is: her voice waits
        // (< 0.3 s) for the clip to reach the next phase frame, the clip is held there, and that phase's render begins
        // on the very same frame.
        const lipKey = Date.now();
        const lipClip = clipOf(shotRef.current, portrait, true)?.id;
        let lipSrc = say.voice && soundOn() && !e2e() ? lipsyncSrc(lipsyncList.current, lipClip, say.voice) : null;
        const loop = lipClip ? loopsRef.current[lipClip] ?? true : true;
        let offset = 0;
        if (lipSrc && lipClip && !TALK_LOOP.test(lipClip)) {
          const b = stage.current?.video?.(lipClip);
          const ph = lipsyncPhases.current;
          const n = ph?.clips[lipClip]?.n ?? 0;
          const plan = b ? startPlan(b.currentTime, b.duration, loop, n, ph?.step ?? 7, !!phaseSrc(ph, lipClip, say.voice, ph?.step ?? 7)) : ({ kind: 'none' } as const);
          const at = plan.kind === 'phase' ? plan.frame * b!.duration / n : 0;
          if (b && 'waitS' in plan) await reach(b, at, plan.waitS);
          if (cancelled) return;
          if (!b || plan.kind === 'none') lipSrc = null;
          else {
            if (plan.kind === 'phase') lipSrc = phaseSrc(ph, lipClip, say.voice, plan.frame);
            offset = at;
            b.pause();
            try { b.currentTime = at; } catch { /* not seekable */ }
          }
        }
        if (lipSrc && lipClip) {
          setHeld(lipClip);
          setLip({ src: lipSrc, key: lipKey, voiced: false, delay: (performance.now() - shotAt.current) / 1000, clip: lipClip, loop, offset });
          await renderReady(lipSrc, RENDER_WAIT_MS);
          if (cancelled) return;
        }
        setLine({ text: said, speaking: true, key: Date.now() });
        const voice = say.voice ? speak(say.voice) : null;
        lineClock.current = { at: performance.now(), ms: lineMs(said), voiced: !!voice };
        // Her render runs on her voice's clock (voiceTime) from the moment her voice is asked to play, not from its
        // `playing` event, which comes a moment after she starts: parked on its first frame, it starts with her — and
        // her clip, held on that frame, goes on with her too.
        if (lipSrc && voice) {
          setLip((l) => (l && l.key === lipKey ? { ...l, voiced: true } : l));
          void sounding(voice).then(() => setHeld((h) => (h === lipClip ? null : h)));
        } else if (lipSrc) setHeld((h) => (h === lipClip ? null : h));
        // Her next line's phase renders, for where the clip will be when she starts it (she ends this one, or her
        // subtitle's reading time is up), loaded while she says this one.
        if (voice && lipClip && !TALK_LOOP.test(lipClip)) {
          const lineStarted = performance.now();
          void sounding(voice).then(() => {
            if (cancelled) return;
            const b = stage.current?.video?.(lipClip);
            const nb = queue.beats[queue.i + 1];
            const nextVoice = nb && voiceOf(nb);
            const ph = lipsyncPhases.current;
            const c = ph?.clips[lipClip];
            if (!b || !c || !ph || !nextVoice) return;
            const left = Math.max((voiceDuration() ?? 0) - (voiceTime() ?? 0), lineMs(said) / 1000 - (performance.now() - lineStarted) / 1000);
            const pl = startPlan((b.currentTime + left) % b.duration, b.duration, loop, c.n, ph.step, true);
            setPrefetch([pl.kind === 'phase' ? phaseSrc(ph, lipClip, nextVoice, pl.frame) : lipsyncSrc(lipsyncList.current, lipClip, nextVoice)]);
          });
        }
        herVoice.current = voice;
        await Promise.race([
          // Voiced, her voice sets the pace (the reading time as before, at most 7 s); unvoiced, the reading time of all its pages.
          Promise.all([sleep(voice ? Math.min(7000, lineMs(said)) : lineMs(said)), voice ? Promise.race([voice.done, sleep(15_000)]) : Promise.resolve()]),
          new Promise<void>((r) => { skip.current = r; })
        ]);
        skip.current = null;
        voice?.stop();
        setHeld((h) => (h === lipClip ? null : h));
        // Her render holds its last frame while the clip underneath is moved to that frame; then the clip takes over.
        if (lipSrc && lipClip && lipShown.current) await lineUp(lipClip, lipShown.current, loopsRef.current[lipClip] ?? true, offset);
        setLip((l) => (l && l.key === lipKey ? null : l));
        if (herVoice.current === voice) herVoice.current = null;
        if (cancelled) return;
        setLine((l) => (l ? { ...l, speaking: false } : l));
        next();
      } else if (beat.type === 'effect') {
        // #68: she goes on air, or ends the stream (下播) — at this very beat.
        if (beat.live !== undefined) setLive(beat.live);
        if (viewRef.current?.rewardable && beat.affinity) setFloat({ n: beat.affinity, stamp: Date.now() });
        await sleep(e2e() ? 30 : 500);
        next();
      } else if (beat.type === 'end') {
        setWaiting(null);
        setEnded(true);
        // U-29 / #8: played to its end, what invited him to it (her confession day's message, her invitation) is read —
        // the server reads it too — so her room never leads with it, or offers this scene from it, again.
        const box = stateRef.current.inbox;
        if (box.some((i) => !i.readAt && (i.payload.scene === sceneId || i.payload.sceneId === sceneId))) {
          const at = new Date().toISOString();
          const items = box.map((i) => (!i.readAt && (i.payload.scene === sceneId || i.payload.sceneId === sceneId) ? { ...i, readAt: at } : i));
          actions.setInbox({ items, unread: items.filter((i) => !i.readAt).length });
        }
        // Server mode: free pulls from a level-up and the new memory card come back with the account.
        if (serverMode()) void bootstrap().then((b) => { if (b.kind === 'member') actions.hydrateMe(b.me); });
      } else {
        // D-M3 / D-N2: the wait he already answered over her lines (#72) is not put up again — no question, no
        // countdown (which, run out, would send a timeout for a step the run is past), no bar: his answer is on its
        // way, and her reply plays from it.
        if (answeredAt(answered.current, beat.id, queue.seq)) { parked.current = { at: { id: beat.id, seq: queue.seq }, beat }; return; }
        hushed.current = false;
        setRewait(beat.id === answered.current?.id);
        shownAt.current = { id: beat.id, seq: queue.seq };
        setWaiting(beat);
        const seconds = beat.type === 'minigame' ? undefined : beat.timeout;
        if (seconds) { const total = seconds * 1000 * timeScale(); setDeadline({ endsAt: Date.now() + total, total }); } else setDeadline(null);
      }
    };
    void run();
    // A runner replaced mid-line (his answer, a reload of the run) takes her voice with it (N-32).
    return () => { cancelled = true; skip.current = null; if (queue.beats[queue.i]?.type === 'line') { herVoice.current?.stop(); herVoice.current = null; } };
  }, [queue.key, queue.i]); // eslint-disable-line react-hooks/exhaustive-deps

  /** His answer. While the server (or her persona) works, a reaction line covers the wait. */
  const answer = useCallback(async (sub: SceneSubmission, said?: string, voiceMs?: number) => {
    const v = viewRef.current;
    if (!v || busyRef.current) return;
    const shown = waiting;
    // D-N2: the step this answer is for, at the run's seq when the scene came to it — the wait on screen, or the one
    // he answers over her lines (#72) — so it is never sent as an answer to whatever the run waits on by now.
    const at = answerTarget(shown ? (shownAt.current?.id === shown.id ? shownAt.current : { id: shown.id, seq: v.seq }) : null, v);
    // A wait the run is already past (her countdown on a step he answered): nothing to send, and it leaves the screen.
    if (at && leftOver(at, v)) { setWaiting((cur) => (cur === shown ? null : cur)); setDeadline(null); return; }
    /** The step he answers: on screen, or the run's next (his answer over her lines). */
    const asked = shown ?? v.waiting;
    // N-32: his answer ends her line — spoken or typed — before her reply can start: one voice at a time.
    stopAll();
    herVoice.current?.stop();
    herVoice.current = null;
    hushed.current = true;
    skip.current?.();
    busyRef.current = true;
    setBusy(true);
    setFailed(null);
    answered.current = at;
    if ('choice' in sub && asked?.type === 'choice') warm.current(asked.options.find((o) => o.id === sub.choice)?.next);
    setWaiting(null);
    setDeadline(null);
    setMine(said ?? null);
    // His comment on her stream (#68) flows across it at once.
    if (live && said && 'minigame' in sub) setComments((c) => [...c, { id: ++commentId.current, text: said }]);
    // N-40: while her answer comes, first her quiet typing dots, and 「えっと……」 only if it takes a while.
    const k = timeScale();
    const dots = setTimeout(() => setThinking(true), THINK_DOTS_MS * k);
    const filler = setTimeout(() => { setThinking(false); setLine({ text: t('scene.think'), speaking: true, filler: true, key: Date.now() }); }, THINK_LINE_MS * k);
    const mask = { clear: () => { clearTimeout(dots); clearTimeout(filler); setThinking(false); } };
    /** The answer did not go through: the step he answered is back on screen (without her countdown), to answer again. */
    const restore = () => {
      if (answered.current === at) answered.current = null;
      const p = parked.current;
      parked.current = null;
      if (shown) { shownAt.current = at; setWaiting(shown); return; }
      // Answered over her lines: put up when her lines reached it meanwhile; otherwise they still bring it, as ever.
      if (p && at && p.at.id === at.id && p.at.seq === at.seq) { shownAt.current = p.at; setRewait(false); setWaiting(p.beat); }
    };
    try {
      const r = await stepScene(v, sub, t.lang, deps(), voiceMs, at ?? undefined);
      mask.clear();
      // His mic time (#74), a paid extension (#69) or a gift (#68) changed his voice time and wallet: take the API's word.
      const paid = 'choice' in sub && asked?.type === 'choice' && asked.options.some((o) => o.id === sub.choice && (o.pay || o.gift));
      if (serverMode() && !r.replayed && (voiceMs || paid)) void bootstrap().then((b) => { if (b.kind === 'member') actions.hydrateMe(b.me); }).catch(() => undefined);
      // A gift he gave (#68): its XP rises at once, and on her stream it shows as his gift.
      const gave = !r.replayed && r.run.result?.kind === 'gift' ? r.run.result : null;
      if (!r.replayed && r.run.result && r.run.result.kind !== 'gift') setResultAt(Date.now());
      if (gave) {
        setFloat({ n: gave.xp, stamp: Date.now() });
        const name = giftName(gave.giftId, t.lang);
        setComments((c) => [...c, { id: ++commentId.current, text: `🎁 ${name}`, gift: true }]);
        setToast(t('scene.gifted', { gift: name, n: giftById(gave.giftId)?.price ?? 0 }));
      }
      const cur = viewRef.current;
      if (r.replayed && r.run.status === 'active' && cur && r.run.id === cur.id && r.run.seq <= cur.seq) {
        // Nothing moved (the run waits on another step than this screen thought): pick up where the run is.
        answered.current = null;
        adopt(r.run, false);
        resume(r.run);
      } else if (r.run.status === 'ended' && !r.run.beats.some((b) => b.type === 'end')) follow(r.run);
      else {
        // D-M3: whatever was up for the step he answered goes with it; the next wait puts up its own.
        setWaiting(null);
        setDeadline(null);
        adopt(r.run, true);
        play(r.run.beats, r.run.seq);
      }
      const herAnswer = confession && r.run.status === 'ended' && !r.replayed ? answerOfOutcome(r.run.outcome) : null;
      if (herAnswer) {
        actions.applyConfession(r.run.star, herAnswer);
        const memory = r.run.rewards.memories[0];
        // His voice is sent only now, after his yes, and only because he chose to keep it (docs/compliance-jp.md §7.3).
        // Asked to keep it but typed the answer, or this browser could not record: his words are kept, and he is told.
        if (herAnswer === 'accept' && keepVoice && memory) {
          if (clip.current) void keepConfessionVoice(memory.id, clip.current).then(setVoiceKept); else setVoiceKept(false);
        }
        clip.current = null;
      }
    } catch (e) {
      mask.clear();
      const code = errorCode(e);
      const resync = code === 'stale_step' || code === 'run_ended' || code === 'run_not_found' || code === 'scene_conflict' || code === 'request_conflict';
      // D-N2: a refusal may only mean the run is already past this step (the server took it): then it counts.
      const fresh = resync || code === 'too_early' ? await sceneRun(v.id, stateRef.current.affinity[v.star]).catch(() => null) : null;
      if (at && fresh && tookIt(at, fresh)) {
        if (fresh.seq > (viewRef.current?.seq ?? -1)) { setWaiting(null); setDeadline(null); follow(fresh); }
      } else if (resync) {
        answered.current = null;
        if (fresh) { adopt(fresh, false); resume(fresh); }
        else restore();
      } else {
        restore();
        const known = isBlocked(e) ? 'chat.blocked' : code === 'daily_limit' ? 'chat.limitTitle' : code === 'insufficient_points' ? 'gift.noPoints'
          : code === 'extend_limit' ? 'voice.limit' : code === 'gift_limit' ? 'gift.limit' : null;
        // M14: anything else (a 500, the network) stays on screen with a way to send the same answer again.
        if (known) setToast(t(known)); else setFailed({ sub, said, voiceMs });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setMine(null);
    }
  }, [adopt, deps, resume, follow, setToast, t, waiting, confession, actions, keepVoice, live]);

  // Her patience: when the countdown runs out, the scene takes its timeout branch.
  useEffect(() => {
    if (!deadline || !waiting || sheet) return;
    const id = setTimeout(() => void answer({ timeout: true }), Math.max(0, deadline.endsAt - Date.now()));
    return () => clearTimeout(id);
  }, [deadline, waiting, answer, sheet]);
  // M9: her patience waits while a sheet (her gift, a paid extension) is open over the scene: what was left of it
  // starts again from where it stood when he closes it.
  const pausedLeft = useRef<number | null>(null);
  useEffect(() => {
    if (sheet) { pausedLeft.current = deadline ? Math.max(0, deadline.endsAt - Date.now()) : null; return; }
    const left = pausedLeft.current;
    pausedLeft.current = null;
    if (left !== null) setDeadline((d) => (d ? { endsAt: Date.now() + left, total: d.total } : d));
  }, [sheet]); // eslint-disable-line react-hooks/exhaustive-deps

  // #69: a date's countdown — the moment it runs out, her plea and the extend choice come (the server moves the run
  // to them on this read), wherever he is in the scene.
  const timerEndsAt = view?.status === 'active' ? view.timerEndsAt : null;
  useEffect(() => {
    if (!timerEndsAt) return;
    const id = setTimeout(async () => {
      const v = viewRef.current;
      if (!v || busyRef.current) return;
      const fresh = await sceneRun(v.id, stateRef.current.affinity[v.star]).catch(() => null);
      if (fresh && fresh.seq !== v.seq) follow(fresh);
    }, Math.max(0, Date.parse(timerEndsAt) - Date.now()) + 250);
    return () => clearTimeout(id);
  }, [timerEndsAt, follow]);

  // Reconnect: when the network comes back, catch up with anything the server did meanwhile.
  useEffect(() => {
    const onOnline = async () => {
      const v = viewRef.current;
      if (!v || busyRef.current) return;
      const fresh = await sceneRun(v.id, stateRef.current.affinity[v.star]).catch(() => null);
      if (fresh && fresh.seq !== v.seq) follow(fresh);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [follow]);

  const endBy = useCallback(async (reason: 'left' | 'idle') => {
    const v = viewRef.current;
    if (!v || v.status === 'ended') return;
    try {
      const r = await endScene(v, reason, stateRef.current.affinity[v.star]);
      adopt(r.run, false);
    } catch { /* leaving works offline too: the server ends it at the 30-minute cap */ }
    if (reason === 'idle') { setWaiting(null); setDeadline(null); setEnded(true); }
  }, [adopt]);

  const [idle, wake] = useIdle(!!waiting && !busy && !ended, () => void endBy('idle'));

  // Enter / Space moves her line on (the stage itself is a button for pointers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, button, a')) return;
      if ((e.key === 'Enter' || e.key === ' ') && skip.current) { e.preventDefault(); tapLine(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tapLine]);

  useEffect(() => { try { localStorage.setItem('jstar.subs', subs ? 'on' : 'off'); } catch { /* storage blocked */ } }, [subs]);

  const again = async () => {
    rememberRun(sceneId, null);
    setEnded(false); setLine(null); setFloat(null); setLive(false); setComments([]); applied.current = 0;
    try {
      const r = await startScene(sceneId, t.lang, deps(), undefined, preview);
      adopt(r.run, !r.replayed);
      if (r.replayed) resume(r.run); else play(r.run.beats, r.run.seq);
    } catch (e) { setError(errorCode(e)); }
  };

  // Layers: what is on screen, her idle loop, the clips of this segment, and the first clip behind each answer.
  // Her wide and close shots play her base loops (stage.tsx baseLoop): talking while her line plays, listening otherwise.
  const speaking = !!line?.speaking && !line.filler;
  const idleMedia = script.meta.idle ?? script.steps.find((s): s is ClipStep => s.type === 'clip')?.media;
  const idleEntry = clipEntry(baseLoop(idleMedia, false, portrait), portrait);
  /** Her listening loop for a shot: a close one's own close loop, else her wide idle (N-35). */
  const listenOf = (c: ClipStep | null) => (c && isCloseShot({ shot: c.shot, media: footageOf(c, portrait) }) ? clipOf(c, portrait, false) ?? idleEntry : idleEntry);
  const firstClip = useMemo(() => script.steps.find((s): s is ClipStep => s.type === 'clip') ?? null, [script]);
  const shotEntry = clipOf(shot, portrait, speaking);
  const layers = useMemo(() => {
    // N-17: before the run starts, the scene's first shot (both her loops) is already buffering behind the idle.
    const opening = shot ? [] : [clipOf(firstClip, portrait, false), clipOf(firstClip, portrait, true)];
    const want = [
      clipOf(shot, portrait, speaking), clipOf(shot, portrait, !speaking), clipEntry(baseLoop(idleMedia, false, portrait), portrait), ...opening,
      ...queue.beats.slice(queue.i).flatMap((b) => (b.type === 'clip' ? [clipOf(b, portrait)] : [])),
      ...(view?.upcoming ?? []).map((m) => clipEntry(baseLoop(m, false, portrait), portrait))
    ];
    const out = new Map<string, NonNullable<ReturnType<typeof clipEntry>>>();
    for (const e of want) if (e && !out.has(e.id)) out.set(e.id, e);
    return [...out.values()].slice(0, 6);
  }, [shot, speaking, idleMedia, queue, view?.upcoming, portrait, firstClip]);
  useEffect(() => { (view?.upcoming ?? []).forEach((m) => warmPoster(clipEntry(m, portrait))); }, [view?.upcoming, portrait]);
  const loops = useMemo(() => Object.fromEntries(script.steps.flatMap((s) => (s.type === 'clip' ? [[clipEntry(s.media, portrait)?.id ?? s.media, s.loop ?? true]] : []))), [script, portrait]);
  loopsRef.current = loops;
  // #73: the renders of the line playing and of the next ones, mounted (so loaded) before her voice needs them.
  const lipLayers = useMemo(() => {
    const out = lip ? [lip.src] : [];
    const add = (src: string | null) => { if (src && !out.includes(src)) out.push(src); };
    if (!lipsyncReady) return out;
    const srcOf = (b: SceneStep, sh: ClipStep | null) => lipsyncSrc(lipsyncList.current, clipOf(sh, portrait, true)?.id, voiceOf(b));
    const shotOf = (b: SceneStep) => (b.type === 'clip' ? b : null);
    upcomingRenders(queue.beats, queue.i, shot, shotOf, srcOf, 2).forEach(add);
    // Waiting for his answer: her first line on each way he can answer, so whichever he picks is already loaded.
    const ways = waiting?.type === 'choice' ? [...waiting.options.map((o) => o.next), waiting.onTimeout]
      : waiting && 'next' in waiting ? [waiting.next] : [];
    for (const id of ways.slice(0, 4)) {
      const k = script.steps.findIndex((st) => st.id === id);
      if (k >= 0) upcomingRenders(script.steps, k, shot, shotOf, srcOf, 1).forEach(add);
    }
    prefetch.forEach(add);
    return out;
  }, [lipsyncReady, queue, shot, portrait, lip, t, name, waiting, script, prefetch]); // eslint-disable-line react-hooks/exhaustive-deps
  // N-35: while she listens (his silence, a late clip) a close shot stays close — her close loop, not her wide idle.
  const listening = listenOf(shot);
  const onStage = (idle !== 'active' || stalling) && listening ? listening.id : shotEntry?.id ?? idleEntry?.id ?? null;

  // #74: when his voice time is nearly up, she says so once a day, in her own words.
  const voiceLeftSec = state.voice?.leftSeconds;
  useEffect(() => {
    const v = stateRef.current.voice;
    if (!v || voiceLeftSec === undefined || voiceLeftSec <= 0 || voiceLeftSec > VOICE_RULES.lowMinutes * 60) return;
    if (takeLowNotice(v.day)) setToast(t(`voice.low.${script.meta.star}` as Key, { n: minutesLeft(voiceLeftSec) }));
  }, [voiceLeftSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <SceneError code={error} first={first} onRetry={() => { setError(null); setAttempt((a) => a + 1); }} />;

  const title = localText(script.meta.title, t.lang);
  // QA #30: back to HER room — a scene of another of the five (a preview, an invitation) never returns to the room he
  // had open before.
  const home = `/me/home?star=${script.meta.star}`;
  const memory = view?.rewards.memories[view.rewards.memories.length - 1];
  const memoryShot = clipEntry(memory?.still, portrait);
  const promise = view?.rewards.promises[view.rewards.promises.length - 1];
  const endKept = view?.outcome === 'complete' && /^promise(Kept|Morning)$/.test(systemSceneOf(sceneId)?.kind ?? '');
  const sub = idle === 'prompt' ? { text: t('scene.idlePrompt'), speaking: true, key: 0 } : line;
  const timer = view?.timerEndsAt ? Date.parse(view.timerEndsAt) : null;
  const dateOn = !!timer && timer > Date.now() && !ended && closedTimer !== view?.timerEndsAt;
  const w = waiting;
  const typed = (st: SceneStep | null | undefined) => !!st && (st.type === 'input' || (st.type === 'minigame' && st.kind !== 'rps'));
  // When his free answer comes next, the bar is already there while she is still speaking, so he can talk over her (#72).
  // N-49: his answer to her confession is given (it is sent, or its outcome is playing — the hug): the bar and the
  // keep-my-voice box leave the stage, and never come back over the hug.
  const answeredHer = !!confession && (busy && w === null || !!view?.beats.some((b) => b.id === 'yes' || b.id.startsWith('wait-') || b.id.startsWith('no-') || b.id.startsWith('later-')));
  // QA #25: only a free answer is there early; a game's answer waits for her to ask it (ōgiri's topic, her reading's
  // 「どうだった？」, the bargain) — the bar comes when its step does.
  const early = (st: SceneStep | null | undefined) => !!st && (st.type === 'input' || (st.type === 'minigame' && st.kind === 'danmaku'));
  const talkTo = answeredHer ? null : typed(w) ? w : !w && !busy && !ended && view?.status === 'active' && early(view.waiting) ? view.waiting : null;
  const shotName = idle !== 'active' && !isCloseShot({ shot: shot?.shot, media: footageOf(shot, portrait) }) ? 'wide' : shot?.shot ?? 'wide';
  /** #74: today's voice time is used up — the scene goes on in subtitles and the bar takes text only. */
  const outOfVoice = !!state.voice && state.voice.leftSeconds <= 0;
  const cost = state.voice?.extendCost ?? VOICE_RULES.extendCostPoints;
  const payBlock = state.voice ? extendBlock(state.voice, state.points) : state.points < cost ? 'voice.short' as const : null;
  const paidOption = w?.type === 'choice' ? w.options.find((o) => o.pay) : undefined;
  const payNow = (id: string) => {
    // Prototype mode has no ledger: the points come off here; the API does it itself.
    if (!serverMode()) actions.setPoints(stateRef.current.points - cost);
    void answer({ choice: id });
  };

  return (
    <div className="scn" data-shot={shotName} data-idle={idle} data-played={queue.beats.map((b) => b.id).join(' ')} data-live={live ? '' : undefined} data-stall={stalling ? '' : undefined}
      data-weather={script.meta.audio?.ambience /* #67: her window's weather, drawn by scene.css */}
      data-testid="scene">
      <ClipStage layers={layers} active={onStage} loops={loops} handle={stage} held={held} startAt={startAt.current} />
      {lipLayers.map((src) => {
        const on = !!lip && lip.src === src;
        return (
          <LipsyncVideo key={src} src={src} active={on} clock={on && lip!.voiced ? voiceTime : null} className="scn-lipsync" videoClassName="scn-media scn-video"
            style={on ? { animationDelay: `-${lip!.delay.toFixed(2)}s` } : { animation: 'none' }}
            onShown={(v) => {
              lipShown.current = v;
              // P1: her render's slow push-in runs on the clip's own (the clip's restarts whenever its layer comes on,
              // the render's delay is the shot's age): lined up as it takes over, they move as one picture.
              if (v && lip) {
                const push = (el?: Element | null) => el?.getAnimations?.().find((a) => (a as CSSAnimation).animationName === 'scn-push');
                const mine = push(v), theirs = push(stage.current?.video?.(lip.clip) ?? document.querySelector(`.scn-layer.on .scn-media`));
                if (mine) { if (theirs?.currentTime != null) mine.currentTime = theirs.currentTime; else mine.cancel(); }
              }
              // Once it has faded in over the clip, the clip underneath moves to its frame: the hand back is seamless.
              if (v && lip) { const { clip: c, loop, offset: o } = lip; setTimeout(() => { if (lipShown.current === v) void lineUp(c, v, loop, o); }, LIPSYNC_FADE_MS + 20); }
            }} />
        );
      })}
      <div className="scn-scrim" aria-hidden="true" />
      <StreamLayer live={live && !ended} comments={comments} />
      {/* Pointer users move a line on by touching the picture; keyboard users press Enter or Space. */}
      {line?.speaking && !line.filler && !w && !ended && (
        <button type="button" className="scn-tap" tabIndex={-1} aria-hidden="true" onClick={tapLine} />
      )}

      <header className="scn-top">
        <button type="button" className="scn-icon" aria-label={t('scene.leave')} onClick={() => void endBy('left').then(() => { rememberRun(sceneId, null); nav(home); })}>
          <Icon name="close" size={20} />
        </button>
        <h1 className="scn-title"><span className="sr-only">{starName(star, t.lang)} — </span><span className="scn-title-text" lang={t.lang}><Phrased text={title} lang={t.lang} /></span>
          {/* A draft on the test site: her existing clips stand in for the pending ones, the lines await review. */}
          {(preview || standIn) && <small className="scn-preview" data-testid="scene-preview" data-stand-in={standIn}>{t(standIn ? 'scene.preview' : 'scene.previewOnly')}</small>}
        </h1>
        <VoiceMeter className="scn-meter" />
        <button type="button" className="scn-icon scn-cc" aria-pressed={subs} aria-label={t('scene.subs')} onClick={() => setSubs((s) => !s)}>CC</button>
      </header>

      {/* M10: the date's countdown stays up, steady, until the date closes (her closing step, or the end); her
          patience for an answer is a second meta under it, never in its place. */}
      {dateOn && <Countdown endsAt={timer!} total={timer! - Date.parse(view!.waitingSince)} label="scene.timer" />}
      {/* No clock over his answer to her confession: the silence still ends it after five minutes, unannounced. */}
      {deadline && w && !rewait && !sheet && !(w.type === 'input' && w.judge) && <Countdown endsAt={deadline.endsAt} total={deadline.total} label="scene.countdown" second={dateOn} />}
      {float && <AffinityFloat n={float.n} stamp={float.stamp} />}
      {/* N-07: no 「受け取り済み」 while it plays — nothing has happened yet; the end card says it, when it ends complete. */}

      {/* L6: the result is news for a moment after his answer (5 s), not a chip left up through the next round. */}
      {view?.result && resultAt && w === null && busy === false && !ended && line && (view.result.kind === 'rps' ? (
        // L5: her hand, then how it went.
        <p className="scn-note" role="status" data-testid="scene-rps">{`${first}：${t(`scene.rps.${view.result.hers}` as Key)}　${t(`scene.rps.${view.result.result}` as Key)}`}</p>
      ) : view.result.kind === 'ogiri' ? (
        // えいみ's score (#70); the other judged games speak through her lines only.
        <p className="scn-note" role="status" data-testid="scene-score">{t('scene.score', { n: view.result.score, of: view.result.of })}</p>
      ) : null)}

      {/* The subtitle band (B「電影字幕」, as in her room): his line, her words, then what he can say. */}
      <div className="scn-bottom">
        {mine && <p className="scn-mine" aria-hidden="true">{mine}</p>}
        {thinking && !ended && <p className="typing scn-thinking" role="status" aria-label={t('common.typing', { first })} data-testid="scene-thinking"><i /><i /><i /></p>}
        {sub && !ended && <Subtitle text={sub.text} speaking={sub.speaking} visible={subs} filler={!!(sub as Line).filler} who={first} lang={t.lang} progress={sub === line ? progress : undefined} pager={pager} />}
        {idle === 'prompt' && <button type="button" className="js-btn-line scn-choice" onClick={wake}>{t('scene.idleStay')}</button>}
        {outOfVoice && view?.status === 'active' && !ended && (
          <p className="scn-voice-out" role="status" data-testid="voice-out">
            {t('voice.out')}
            {state.voice!.extensionsLeft > 0 && <button type="button" onClick={() => setPaying('')}>{t('voice.outExtend', { min: state.voice!.extendMinutes })}</button>}
          </p>
        )}
        {failed && !busy && !ended && (
          <p className="scn-voice-out" role="alert" data-testid="scene-step-failed">
            {sceneText('stepFailed', t.lang)}
            <button type="button" onClick={() => { const f = failed; setFailed(null); void answer(f.sub, f.said, f.voiceMs); }}>{sceneText('retry', t.lang)}</button>
          </p>
        )}
        {paidOption && payBlock && (
          <p className="scn-voice-out" role="status" data-testid="scene-pay-short">
            {payBlock === 'voice.limit' ? t('voice.limit') : t('scene.payShort', { label: localText(paidOption.label, t.lang), n: Math.max(0, cost - state.points) })}
          </p>
        )}
        {w?.type === 'choice' && (
          <Choices label={w.prompt ? localText(w.prompt, t.lang) : t('scene.choices')} disabled={busy}
            options={w.options.map((o) => {
              // #68: a fixed gift shows its price; the gift sheet shows each price for one he picks.
              const fixed = o.gift && o.gift !== 'pick' ? giftById(o.gift) : undefined;
              return {
                id: o.id,
                // #69 / #74: the paid extension shows its price, and is greyed out without the points or past today's extensions.
                label: o.pay ? `${localText(o.label, t.lang)}（${t('common.pt', { n: cost })}）`
                  : fixed ? `${localText(o.label, t.lang)}（${t('common.pt', { n: fixed.price })}）` : localText(o.label, t.lang),
                off: !!o.pay && !!payBlock
              };
            })}
            onPick={(c) => {
              const o = w.options.find((x) => x.id === c);
              if (o?.pay) setPaying(c);
              else if (o?.gift === 'pick') setGiving(c);
              else void answer({ choice: c });
            }} />
        )}
        {w?.type === 'minigame' && w.kind === 'rps' && (
          <Choices label={t('scene.rps')} disabled={busy} options={(['rock', 'scissors', 'paper'] as const).map((h) => ({ id: h, label: t(`scene.rps.${h}` as Key) }))}
            onPick={(h) => void answer({ minigame: { hand: h as 'rock' | 'scissors' | 'paper' } })} />
        )}
        {talkTo && (
          <>
            {w?.type === 'input' && w.prompt && !rewait && <p className="scn-prompt">{localText(w.prompt, t.lang)}</p>}
            {w?.type === 'input' && w.judge && canKeep && (
              <label className="scn-keep" data-testid="confession-keep">
                <input type="checkbox" checked={keepVoice} onChange={(e) => setKeepVoice(e.target.checked)} />
                <span>{t('confession.keep')}<small>{t('confession.keepNote')}</small></span>
              </label>
            )}
            <InputBar placeholder={talkTo.type === 'minigame' && talkTo.kind === 'danmaku' ? t('scene.comment') : t('scene.placeholder', { first })} disabled={busy} autoFocus={!!w} onTalk={() => { clip.current = null; interrupt(); }} notify={setToast}
              armed={!!w && !busy && !line?.speaking && idle === 'active'}
              keep={keepVoice && talkTo.type === 'input' && talkTo.judge ? (b) => { clip.current = b; } : undefined}
              mic={!outOfVoice}
              onSend={(said, via, ms) => {
                if (via === 'text') clip.current = null;
                void answer(talkTo.type === 'input' ? { input: said } : { minigame: { text: said } }, said, via === 'voice' ? ms : undefined);
              }} />
          </>
        )}
      </div>

      {ended && view && (
        <section className="scn-end" role="dialog" aria-labelledby="scn-end-title" data-testid="scene-end">
          {confession && view.outcome !== 'accepted' ? (
            <h2 id="scn-end-title" className="serif scn-end-msg" data-testid="confession-later">
              {t(view.outcome === 'not_yet' || view.outcome === 'declined' ? 'confession.endLater' : view.outcome === 'quiet' ? 'confession.endQuiet' : 'scene.endIdle', { first })}
            </h2>
          ) : memory && view.outcome !== 'idle' ? (
            <div className="scn-card">
              {/* #51: the shot on screen when the card was made is its picture (the same still 思い出 and his export show). */}
              {(memoryShot ?? shotEntry) && <img className="scn-card-art" data-testid="scene-card-still" src={(memoryShot ?? shotEntry)!.posters?.[0]?.src ?? (memoryShot ?? shotEntry)!.poster} alt="" decoding="async" draggable={false} />}
              <span className="scn-card-tag">{t('scene.endTitle')}</span>
              <h2 id="scn-end-title" className="serif">{sceneMemoryTitle(memory.title, t.lang, sceneId)}</h2>
              <p className="tiny">{starName(star, t.lang)}・{fmtDate(memory.createdAt, t.lang)}</p>
            </div>
          ) : (
            <h2 id="scn-end-title" className="serif scn-end-msg">
              {/* A moment that makes no memory card (goodnight, the weather, a promise kept, #71) ends in her words, not "already received". */}
              {/* M1: every way a scene ends but his leaving (or his silence) is an ending — a named ending without a memory
                  card too; 「下次再繼續吧。」 is for a scene left midway. L9: her promise kept says so, on a replay too. */}
              {endKept ? sceneText('endKept', t.lang) : view.outcome === 'replaced' ? sceneText('replaced', t.lang) : t(view.outcome === 'timeout' ? 'scene.endTimeout' : view.outcome === 'goodnight' ? 'scene.endGoodnight'
                : view.outcome === 'left' || view.outcome === 'idle' || !view.outcome ? 'scene.endIdle'
                  : view.rewardable || view.outcome !== 'complete' ? 'scene.endDone' : 'scene.endNone')}
            </h2>
          )}
          {confession && view.outcome === 'accepted' && <p className="serif" data-testid="confession-anniv">{t('confession.anniv', { first })}</p>}
          {confession && view.outcome === 'accepted' && voiceKept !== null && <p className="small" role="status">{t(voiceKept ? 'confession.kept' : 'confession.keepFailed')}</p>}
          {view.rewards.affinity > 0 && <p className="small">{t('scene.endAffinity', { first, n: view.rewards.affinity })}</p>}
          {promise && <p className="small">{t('scene.endPromise', { text: promise.text })}</p>}
          {/* #57/#66: her 「明日の朝、起こしてあげる」 — the alarm, with her, if he says so. */}
          {promise?.kind === 'wakeup' && serverMode() && <AlarmProposal star={view.star} first={first} promise={promise} />}
          <div className="scn-end-actions">
            <Link to={home} className="btn btn-rose" onClick={() => rememberRun(sceneId, null)}>{t('scene.back')}</Link>
            {/* Her confession is not a scene to replay: she asks again on her own days. */}
            {!confession && <button type="button" className="btn btn-line" onClick={() => void again()}>{t('scene.again')}</button>}
          </div>
        </section>
      )}
      {!view && !error && <p className="scn-prompt scn-wait" role="status">{t('scene.loading')}</p>}
      {giving !== null && (
        // #68: he picks; the step buys it (points, today's gifts) and she reacts before the scene goes on.
        <GiftSheet star={script.meta.star} call /* her face stays clear: the lower night on a phone, beside her wide */ onClose={() => setGiving(null)} onPick={(g) => { const c = giving; setGiving(null); void answer({ choice: c, gift: g }); }} />
      )}
      {paying !== null && (paying
        // The scene's paid option: confirmed here, paid by the API with the step itself.
        ? <ExtendSheet title={localText(w?.type === 'choice' ? w.options.find((o) => o.id === paying)?.label : undefined, t.lang) || undefined}
            onClose={() => setPaying(null)} pay={async () => { const id = paying; setPaying(null); payNow(id); }} />
        : <ExtendSheet onClose={() => setPaying(null)} />)}
      <Toast msg={toast} />
    </div>
  );
}
