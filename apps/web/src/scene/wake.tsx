/**
 * Her wake-up moment (#57): `/me/wake?star=&inbox=`, where her wake-up push lands (and her face's badge, and her
 * room before 11:00 when he has no push). Built from the scene engine's pieces (#64) — the full-screen stage with
 * her morning clip, her subtitle with its sound wave, the answers above the bottom edge — without a scene run: the
 * morning is one line and one question, and its only server state is the wake-up itself.
 *
 * The shots follow the engine's grammar (empty shot, then her): her room in the morning light (`<star>-morning`, an
 * empty shot), then a hard cut to her as she speaks — her morning hero clip once it exists (`<star>-hero-morning`,
 * as the home picks it), her hero clip until then.
 *
 * She says her recorded morning greeting (her voice), then the morning's wake-up line (#82; its recording is #83),
 * and asks 「起きた？」. 「あと5分」 asks the API to call again in five minutes, once a morning.
 *
 * Prototype mode has no server and no alarm: the screen plays her greeting and 「起きた」 only, as a preview.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { WakeOpenResT } from '@jstar/shared/contracts';
import { getStar, isStarId, type StarId } from '../data/cast';
import { starFirst, type Lang } from '../i18n';
import { useStore, useT } from '../lib/store';
import { duck, playVoice, soundOn } from '../lib/sound';
import { lineFor, voiceUrl } from '../components/voiceLines';
import { mediaFor, usePortrait, useSceneMediaState } from '../components/stage';
import { Icon, Toast, useToast } from '../components/ui';
import { errorCode, serverMode } from '../services/api';
import { http } from '../services/http';
import { ClipStage, type StageHandle } from './stage';
import { Phrased } from './phrases';
import { wrongTimeSalutation } from '@jstar/shared/salutation';
import { clockSlot } from '../lib/companion';
import { Choices, Subtitle } from './ui';
import './scene.css';
import '../styles/alarm.css';

const e2e = () => !!(window as unknown as { __E2E__?: boolean }).__E2E__;
const lineMs = (text: string) => (e2e() ? 150 : Math.min(7000, Math.max(2200, 1400 + 110 * [...text].length)));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How long the empty shot of her morning room holds before she appears. */
const EMPTY_MS = 1800;
/** N-42: the title of a wake-up that is not a morning one (kept in this lazy chunk, off the entry dictionary). */
const NOT_MORNING_TITLE: Record<Lang, string> = { ja: '{first}からの目覚まし', 'zh-Hant': '{first}的鬧鐘', en: 'A wake-up call from {first}', ko: '{first}의 알람' };
/** The server's id for "her recorded morning greeting is the wake-up line" (apps/api/src/lib/wakeup.ts). */
const GREET = 'greet-morning';

interface Said { text: string; voice: string | null }
interface Moment {
  id: string | null; star: StarId; lines: Said[]; replies: { awake: string; snooze: string } | null;
  /** Her recordings of her two answers (#83), when made. */
  replyVoices?: { awake: string | null; snooze: string | null } | null;
  /** Her 「明日の朝、起こしてあげる」 that this wake-up kept (#57, #66), quoted. */
  kept?: string | null;
  snoozeLeft: number; snoozeMinutes: number;
}

/**
 * What she says, in order: her greeting in her own voice, then the morning's line (unless the greeting is it) — in
 * her recorded voice too once #83 made it (`voice`), subtitles alone until then.
 * M12: a wake-up is his morning, whatever the hour he set it for — an alarm at 04:06 opens with her morning greeting,
 * never her bedtime line; a wake-up line that greets another time of day (the N-38 guard) is left out.
 */
export function momentLines(star: StarId, lang: Lang, line: string | null, lineId: string | null, voice: string | null = null): Said[] {
  const greet: Said = { text: lineFor(star, 'morning', lang), voice: voiceUrl(star, 'morning') };
  // The server's "greeting is the wake-up line" is her morning greeting, as sent.
  if (!line || lineId === GREET) return [line ? { ...greet, text: line } : greet];
  return wrongTimeSalutation(line, MORNING_HOUR) ? [greet] : [greet, { text: line, voice }];
}
/** An hour of the morning, for the N-38 guard's "does this line greet the morning". */
const MORNING_HOUR = 7;

function fromServer(r: WakeOpenResT, lang: Lang): Moment {
  return {
    id: r.id, star: r.star, lines: momentLines(r.star, lang, r.line, r.lineId, r.voice ?? null), replies: r.replies,
    replyVoices: r.replyVoices ?? null, kept: r.keptPromise ?? null, snoozeLeft: r.snoozeLeft, snoozeMinutes: r.snoozeMinutes
  };
}

/** Her recorded voice, when sound is on; resolves when she finishes, or at once when the browser refuses to play. */
function speak(url: string, refused: () => void): { done: Promise<void>; stop: () => void } | null {
  if (!soundOn() || e2e()) return null;
  const a = new Audio(url);
  let finish: () => void = () => undefined;
  const done = new Promise<void>((r) => { finish = () => { duck(false); r(); }; });
  a.onended = finish; a.onerror = finish; a.onpause = finish;
  duck(true);
  // Opened from a notification, the page has had no tap yet and autoplay may be refused: the listen button stays.
  void a.play().catch(() => { refused(); finish(); });
  return { done, stop: () => a.pause() };
}

type Phase = 'loading' | 'speaking' | 'ask' | 'reply' | 'done';

export default function WakeMoment() {
  const [params] = useSearchParams();
  const { state } = useStore();
  const id = params.get('inbox');
  const star = params.get('star');
  // A wake-up is an inbox item on the server; without one there is nothing to open (the prototype previews one).
  if (serverMode() && !id) return <Navigate to="/me/home" replace />;
  const who = isStarId(star) ? star : state.star;
  // A new wake-up (or another talent's preview) is a new moment, even when the router reuses this screen for it.
  return <Wake key={`${id ?? 'preview'}:${who}`} id={id} fallbackStar={who} />;
}

function Wake({ id, fallbackStar }: { id: string | null; fallbackStar: StarId }) {
  const { actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const portrait = usePortrait();
  const [moment, setMoment] = useState<Moment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [line, setLine] = useState<{ text: string; speaking: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [shot, setShot] = useState<'empty' | 'her'>('empty');
  /** Set when the API said the snooze is used up after all (another device, a stale screen). */
  const [snoozeGone, setSnoozeGone] = useState(false);
  const [toast, setToast] = useToast();
  const stage = useRef<StageHandle | null>(null);
  const skip = useRef<(() => void) | null>(null);
  // Her morning room and morning loop are in the lazy catalogue (data/media.ts): the moment starts once it is here.
  // N-48: failed after its tries, the moment goes on with her clips from the core catalogue (her hero loop): never a
  // blank screen; the morning clips swap in if the catalogue comes later.
  const mediaState = useSceneMediaState().state;
  const mediaReady = mediaState !== 'loading';

  useEffect(() => {
    let live = true;
    if (serverMode() && id) {
      http.wakeOpen(id, t.lang).then((r) => {
        if (!live) return;
        // Read on the server: the badge on her face goes down with it.
        actions.inboxRead({ item: r.item, unread: r.unread });
        setMoment(fromServer(r, t.lang));
      }).catch((e) => { if (live) setError(errorCode(e)); });
    } else {
      setMoment({ id: null, star: fallbackStar, lines: momentLines(fallbackStar, t.lang, null, null), replies: null, snoozeLeft: 0, snoozeMinutes: 5 });
    }
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Her lines, one after another; a tap on the picture (or Enter) moves on, as in a scene.
  useEffect(() => {
    if (!moment || !mediaReady) return;
    let cancelled = false;
    void (async () => {
      setPhase('speaking');
      setShot('empty');
      await sleep(e2e() ? 50 : EMPTY_MS);
      if (cancelled) return;
      setShot('her');
      for (const said of moment.lines) {
        if (cancelled) return;
        setLine({ text: said.text, speaking: true });
        const voice = said.voice ? speak(said.voice, () => setRefused(true)) : null;
        await Promise.race([
          Promise.all([sleep(lineMs(said.text)), voice ? Promise.race([voice.done, sleep(15_000)]) : Promise.resolve()]),
          new Promise<void>((r) => { skip.current = r; })
        ]);
        skip.current = null;
        voice?.stop();
      }
      if (cancelled) return;
      setLine((l) => (l ? { ...l, speaking: false } : l));
      setPhase('ask');
    })();
    return () => { cancelled = true; skip.current = null; };
  }, [moment, mediaReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, button, a')) return;
      if ((e.key === 'Enter' || e.key === ' ') && skip.current) { e.preventDefault(); skip.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const s = getStar(moment?.star ?? fallbackStar);
  const first = starFirst(s, t.lang);
  // N-42: her morning room and morning clip only in the morning; otherwise her room by day or by night.
  const slot = clockSlot(new Date().getHours());
  const room = slot === 'morning' ? mediaFor(`${s.id}-morning`, portrait) : mediaFor(`${s.id}-${slot === 'day' ? 'day' : 'night'}`, portrait) ?? mediaFor(`${s.id}-morning`, portrait);
  const her = (slot === 'morning' ? mediaFor(`${s.id}-hero-morning`, portrait) : undefined) ?? mediaFor(`${s.id}-hero`, portrait) ?? room;
  // Both are mounted from the start, so the cut to her only flips which layer shows (scene/stage.tsx).
  const layers = useMemo(() => [room, her].filter((e, i, a): e is NonNullable<typeof e> => !!e && a.findIndex((x) => x?.id === e.id) === i), [room, her]);
  const onStage = (shot === 'empty' && room ? room : her)?.id ?? null;

  /** Her recorded answer, when there is one (#83); the tap on 「起きた」 already allowed sound. */
  const sayReply = (url: string | null | undefined) => { if (url) speak(url, () => undefined); };

  const answer = async (choice: string) => {
    if (!moment || busy) return;
    if (choice === 'awake') {
      setPhase(moment.replies ? 'reply' : 'done');
      if (moment.replies) { setLine({ text: moment.replies.awake, speaking: true }); sayReply(moment.replyVoices?.awake); }
      return;
    }
    setBusy(true);
    try {
      if (moment.id) await http.wakeSnooze(moment.id);
      setNote(t('wake.snoozed', { n: moment.snoozeMinutes, first }));
      setPhase(moment.replies ? 'reply' : 'done');
      if (moment.replies) { setLine({ text: moment.replies.snooze, speaking: true }); sayReply(moment.replyVoices?.snooze); }
    } catch (e) {
      const code = errorCode(e);
      // N-37: a wake-up the server no longer has says so, instead of a bare error.
      if (code === 'snooze_used' || code === 'wake_over' || code === 'wake_not_found') {
        setNote(t(code === 'snooze_used' ? 'wake.snoozeUsed' : code === 'wake_over' ? 'wake.over' : 'wake.gone', { n: moment.snoozeMinutes, first }));
        setSnoozeGone(true);
      } else {
        setToast(t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  // Her answer, read like any line; then the way to her room.
  useEffect(() => {
    if (phase !== 'reply' || !line) return;
    const id = setTimeout(() => { setLine((l) => (l ? { ...l, speaking: false } : l)); setPhase('done'); }, lineMs(line.text));
    return () => clearTimeout(id);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="scn scn-error" role="alert">
        <p>{t(error === 'wake_not_found' ? 'wake.over' : 'wake.error')}</p>
        <Link to="/me/home" className="btn btn-rose">{t('wake.room', { first })}</Link>
      </div>
    );
  }

  const options = moment ? [
    { id: 'awake', label: t('wake.awake') },
    ...(moment.snoozeLeft > 0 && !snoozeGone ? [{ id: 'snooze', label: t('wake.snooze', { n: moment.snoozeMinutes }) }] : [])
  ] : [];
  const greetVoice = moment?.lines.find((l) => l.voice)?.voice;

  return (
    <div className={`scn wake tod-${slot}${portrait ? '' : ' wake-wide'}`} data-slot={slot} data-shot={shot === 'empty' ? 'empty' : 'wide'} data-testid="wake" data-phase={phase}>
      <ClipStage layers={mediaReady ? layers : []} active={onStage} loops={{}} handle={stage} />
      {/* Her clips are graded for the evening; the home's morning light (immersive.css) makes them morning. */}
      <i className="tod-light" aria-hidden="true" />
      <div className="scn-scrim" aria-hidden="true" />
      {line?.speaking && phase === 'speaking' && (
        <button type="button" className="scn-tap" tabIndex={-1} aria-hidden="true" onClick={() => skip.current?.()} />
      )}

      <header className="scn-top">
        <button type="button" className="scn-icon" aria-label={t('common.close')} onClick={() => nav('/me/home')}><Icon name="close" size={20} /></button>
        <h1 className="scn-title" lang={t.lang}><Phrased text={slot === 'morning' ? t('wake.title', { first }) : NOT_MORNING_TITLE[t.lang].replace('{first}', first)} lang={t.lang} /></h1>
        {greetVoice ? (
          <button type="button" className="scn-icon" aria-label={t('wake.listen', { first })} data-refused={refused || undefined} onClick={() => void playVoice(greetVoice, true)}>
            <Icon name="speaker" size={20} />
          </button>
        ) : <span className="scn-icon" />}
      </header>

      <div className="scn-bottom">
        {line && <Subtitle text={line.text} speaking={line.speaking} visible who={first} lang={t.lang} />}
        {/* #57/#66: her promise from last night, kept this morning. */}
        {moment?.kept && phase !== 'loading' && <p className="wake-note" data-testid="wake-kept">{t('wake.kept', { first, text: moment.kept })}</p>}
        {note && <p className="wake-note" role="status" data-testid="wake-note">{note}</p>}
        {phase === 'ask' && (
          <>
            <p className="scn-prompt">{t('wake.ask')}</p>
            <Choices label={t('wake.ask')} options={options} disabled={busy} onPick={(c) => void answer(c)} />
          </>
        )}
        {phase === 'done' && (
          <Link to="/me/home" className="js-btn-line scn-choice" data-testid="wake-room">{t('wake.room', { first })}</Link>
        )}
      </div>
      {phase === 'loading' && <p className="scn-prompt scn-wait" role="status">{t('common.loading')}</p>}
      <Toast msg={toast} />
    </div>
  );
}
