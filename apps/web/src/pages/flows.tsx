import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_RATES, floorRates } from '@jstar/shared/gacha';
import { CAST, getStar } from '../data/cast';
import { THEME } from '../data/theme';
import { quoted, starFirst, starName, verticalName, type Key } from '../i18n';
import { CONFIG } from '../lib/config';
import { safeNext } from '../lib/safeNext';
import { DEMO_SERIALS, SERIAL_RE, formatSerial, isValidSerialFormat, normalizeSerial, serialFromQuery } from '../lib/serial';
import { uid, useStore, useT } from '../lib/store';
import type { Msg } from '../lib/state';
import { ApiError, DEMO_OTP, EMAIL_RE, bootstrap, errorCode, isBlocked, redeemSerial, trialChat, type Login } from '../services/api';
import { Header, Icon, OfflineLine, Toast, Typing, useToast } from '../components/ui';
import { SceneVideo, media, sceneFor, stillOf } from '../components/stage';
import { StarAvatar } from '../components/starAvatar';
import { LIVE_COVERS, ResponsiveLiveCover, liveLayoutForViewport } from '../components/liveCover';
import '../system/system.css';
import '../styles/member.css';
import '../styles/flows.css';
import { useHerVoice } from '../lib/herVoice';
import { setSound, useSound } from '../lib/sound';
import { ChargeModal } from '../components/chargeModal';
import { connectLiveAvatar, type LiveAvatarConnection } from '../lib/viduLive';

const PICK_FACE_X: Record<string, string> = {
  mahiro: '63%',
  nana: '54%',
  unpai: '64%',
  alice: '57%',
  eimi: '70.5%'
};

export function PickStar() {
  const { actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const vertical = verticalName(t.lang);
  const [hover, setHover] = useState<string | null>(null);
  return (
    <main className="page night-page pick-page">
      <Header back="/" />
      <h1 className="h1 pad site-w" style={{ fontSize: 26, marginBottom: 18 }}>{t('pick.title')}</h1>
      <div className="pick-slats">
        {CAST.map((c, k) => {
          const clip = media(`${c.id}-idle-16x9`);
          const still = stillOf(clip);
          return (
            <button key={c.id} type="button" aria-label={t('pick.talkTo', { name: starName(c, t.lang) })}
              className={`pick-slat${still ? ' has-still' : ''}${hover === c.id ? ' is-active' : ''}`} style={{ background: c.tint, '--accent': THEME[c.id].accent, '--d': k, '--slat-face-x': PICK_FACE_X[c.id] ?? '50%' } as React.CSSProperties}
              onPointerEnter={() => setHover(c.id)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(c.id)} onBlur={() => setHover(null)}
              onClick={() => { actions.setTrialStar(c.id); nav('/trial'); }}>
              {still && <img className="slat-img" src={still} alt="" decoding="async" draggable={false} />}
              {(c.id === 'eimi' || hover === c.id) && clip && <SceneVideo entry={clip} active className="slat-video" />}
              <span className={`pick-name${vertical ? '' : ' h'}`}>{starName(c, t.lang)}</span>
              <span aria-hidden="true" className="pick-rule" />
            </button>
          );
        })}
      </div>
      <p className="small muted pad site-w" style={{ margin: 0, padding: '16px 24px 24px' }}>{t('pick.note')}</p>
    </main>
  );
}

const QUICK = ['trial.q1', 'trial.q2', 'trial.q3'] as const;
export function TrialChat() {
  const { state, actions } = useStore();
  const t = useT();
  const star = getStar(state.trialStar);
  const her = useHerVoice(star.id, t.lang);
  const sound = useSound();
  const first = starFirst(star, t.lang);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pullStart = useRef<number | null>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  /** Her reply while it streams in; null before the first token and once it is stored in the log. */
  const [live, setLive] = useState<string | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  const avatarStream = useRef<HTMLDivElement>(null);
  /** M7: his messages that did not go through: `retry` can be sent again, `blocked` cannot. */
  const [failed, setFailed] = useState<Record<string, 'retry' | 'blocked'>>({});
  const [toast, setToast] = useToast();
  const endRef = useRef<HTMLDivElement>(null);
  const done = state.trialLeft <= 0;
  // B-P2: her two-line line as one — after a full-width 。 nothing, a space only between Latin sentences.
  const opening: Msg = { id: 'open', from: 'her', text: `${oneLine(t(`star.${star.id}.line` as Key))}\n${t('trial.open')}` };
  const log = [opening, ...state.trialLog];
  useEffect(() => {
    let alive = true;
    let retryTimer = 0;
    let startTimer = 0;
    let retryAttempt = 0;
    let connection: LiveAvatarConnection | null = null;
    const target = avatarStream.current;
    if (!target) return;
    setAvatarReady(false);
    const retry = () => {
      if (!alive) return;
      retryTimer = window.setTimeout(start, Math.min(15_000, 2_400 * (2 ** retryAttempt)));
      retryAttempt += 1;
    };
    const start = () => {
      if (!alive) return;
      target.replaceChildren();
      void connectLiveAvatar(star.id, target, () => alive && setAvatarReady(true), 'ja', liveLayoutForViewport()).then((next) => {
        if (!alive) { void next?.close(); return; }
        if (!next) { retry(); return; }
        retryAttempt = 0;
        connection = next;
      }).catch(retry);
    };
    startTimer = window.setTimeout(start, 100);
    return () => {
      alive = false;
      window.clearTimeout(startTimer);
      window.clearTimeout(retryTimer);
      void connection?.close();
    };
  }, [star.id]);

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }); }, [log.length, busy, live, done]);
  // A reply picked on the home page (?say=) is sent once on arrival, then dropped from the address.
  const loc = useLocation();
  const navTo = useNavigate();
  const said = useRef(false);
  useEffect(() => {
    const say = new URLSearchParams(loc.search).get('say');
    if (!say || said.current || state.user) return;
    said.current = true;
    navTo('/trial', { replace: true });
    void send(say);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // H3: a member is in her room; a reply picked on the home page (?say=) still goes out from her chat.
  if (state.user) return <Navigate to={new URLSearchParams(loc.search).get('say') ? `/me/chat${loc.search}` : '/me/home'} replace />;

  /** Sends his words; `again` resends one that failed (it is already in the log). */
  async function send(text: string, again?: string) {
    const msg = text.trim().slice(0, 200);
    if (!msg || busy || done) return;
    setHistoryOpen(false);
    setBusy(true);
    const id = again ?? uid();
    if (!again) { setDraft(''); actions.trialAppend([{ id, from: 'me', text: msg }]); }
    setFailed((f) => { const n = { ...f }; delete n[id]; return n; });
    try {
      const r = await trialChat(state, star.id, msg, t.lang, (text) => setLive(text));
      actions.trialAppend([{ id: uid(), from: 'her', text: r.reply }]);
      actions.setTrialLeft(r.trialMessagesLeft ?? 0);
      her.speak(r.reply, r.voiceSig);
    } catch (e) {
      const code = errorCode(e);
      if (code === 'trial_exhausted') actions.setTrialLeft(0);
      else {
        setFailed((f) => ({ ...f, [id]: isBlocked(e) ? 'blocked' : 'retry' }));
        setToast(t(isBlocked(e) ? 'chat.blocked' : code === 'challenge_required' ? 'common.challenge' : code === 'rate_limited' ? 'trial.rateLimit' : 'common.error'));
      }
    } finally {
      setLive(null);
      setBusy(false);
    }
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void send(draft); };
  const visibleFrom = Math.max(0, log.length - (busy ? 1 : 2));
  const onHistoryTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    pullStart.current = e.touches[0]?.clientY ?? null;
  };
  const onHistoryTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const y = e.touches[0]?.clientY;
    if (pullStart.current === null || y === undefined || y - pullStart.current < 54) return;
    pullStart.current = null;
    setHistoryOpen(true);
    requestAnimationFrame(() => chatBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
  };
  const onHistoryTouchEnd = () => { pullStart.current = null; };

  return (
    <div className={`page chat chat-night trial${historyOpen ? ' history-open' : ''}${avatarReady ? ' is-avatar-ready' : ''}`} data-star={star.id}>
      <div className="trial-avatar" aria-label={`${starName(star, t.lang)} 1v1 live`}>
        <ResponsiveLiveCover cover={LIVE_COVERS[star.id]} className="trial-avatar-cover" eager />
        <div ref={avatarStream} className="trial-avatar-stream" />
        <i className="trial-avatar-glass" aria-hidden="true" />
      </div>
      <div className="trial-col">
        <header className="chat-hdr">
          <Link to="/pick" className="icon-btn" aria-label={t('common.back')}><Icon name="back" /></Link>
          <StarAvatar id={star.id} />
          <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <span className="serif" style={{ fontSize: 16, fontWeight: 600 }}>{starName(star, t.lang)}</span>
            <span className="tiny muted">{t('common.aiBadge')}</span>
          </span>
          {her.available && (
            <button type="button" className={`icon-btn sound-btn${her.on && sound ? ' on' : ''}`}
              aria-label={her.on && sound ? t('top.soundOff') : t('top.soundOn')} aria-pressed={her.on && sound}
              onClick={() => {
                const next = !(her.on && sound);
                her.setOn(next);
                setSound(next);
              }}>
              <Icon name={her.on && sound ? 'speaker' : 'mute'} size={20} />
            </button>
          )}
          <span className="tiny trial-left" data-testid="trial-left">{t('trial.left', { n: state.trialLeft })}</span>
        </header>
        <OfflineLine />
        <div ref={chatBodyRef} className="chat-body" role="log" aria-live="polite" aria-label={t('trial.log', { name: starName(star, t.lang) })}
          onTouchStart={onHistoryTouchStart} onTouchMove={onHistoryTouchMove} onTouchEnd={onHistoryTouchEnd} onTouchCancel={onHistoryTouchEnd}>
          {log.map((m, i) => (
            <div key={m.id} className={`msg-row ${m.from}${i < visibleFrom ? ' is-old' : ''}`}>
              <p className={`msg ${m.from}${failed[m.id] ? ' is-failed' : ''}`}>{m.text}</p>
              {failed[m.id] && (
                <span className="msg-fail" data-testid="trial-failed">
                  {t('trial.failed')}
                  {failed[m.id] === 'retry' && <button type="button" className="msg-retry" disabled={busy || done} onClick={() => void send(m.text, m.id)}>{t('trial.retry')}</button>}
                </span>
              )}
            </div>
          ))}
          {busy && (live ? <p className="msg her" data-testid="chat-live" aria-hidden="true">{live}</p> : <Typing label={t('common.typing', { first })} />)}
          {done && !busy && (
            <section className="trial-end fade-in" aria-labelledby="trial-end-h">
              {/* A-polish: why her chat ends here, also when he opens another star after the trial was used up. */}
              <p className="small trial-end-b" data-testid="trial-used">{t('trial.used')}</p>
              <p id="trial-end-h" className="serif trial-end-h">{t('trial.doneTitle')}</p>
              <p className="small trial-end-b">{t('trial.doneBody', { first })}</p>
              {/* H3 (member round): saved, the conversation goes on in her room (the trial lines are merged into it at sign-up). */}
              <Link to="/signup?next=/me/home" className="btn btn-rose" data-testid="trial-done">{t('trial.doneCta')}</Link>
            </section>
          )}
          <div ref={endRef} />
        </div>
        {!done && (
          <div className="chips" role="group" aria-label={t('trial.suggest')}>
            {QUICK.map((q) => <button key={q} type="button" className="chip" disabled={busy} onClick={() => void send(t(q))}>{t(q)}</button>)}
          </div>
        )}
        <form className="composer" onSubmit={onSubmit}>
          <label htmlFor="trial-input" className="sr-only">{t('common.message')}</label>
          <input id="trial-input" value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} disabled={done} placeholder={done ? t('trial.phDone') : t('trial.ph')} autoComplete="off" enterKeyHint="send" />
          <button type="submit" className="round trial-send" aria-label={t('common.send')} disabled={done || busy || !draft.trim()}><Icon name="send" size={18} /></button>
        </form>
      </div>
      <Toast msg={toast} />
    </div>
  );
}

/** A-L11: the address he typed survives a visit to the terms and back (this tab only). */
const EMAIL_DRAFT = 'jstar.signupEmail';
const draftEmail = () => { try { return sessionStorage.getItem(EMAIL_DRAFT) ?? ''; } catch { return ''; } };
const keepEmail = (v: string | null) => { try { if (v) sessionStorage.setItem(EMAIL_DRAFT, v); else sessionStorage.removeItem(EMAIL_DRAFT); } catch { /* storage blocked */ } };
/** M1: how long before 「コードを再送する」 can be pressed again (the API also limits sends per address and IP). */
export const RESEND_WAIT_S = 60;

/** M2 / A-M5: her line when he is asked to log in on the way somewhere (a link, the menu): what that place is. */
const DEST_LINE: [RegExp, Key][] = [[/^\/me\/gacha/, 'su.herGacha'], [/^\/me\/cards/, 'su.herCards'], [/^\/me\/shop/, 'su.herPoints']];

/** M1 / L11: what a refused sign-in says — an expired or spent code needs a new one; a 429 says how long to wait. */
export function otpError(e: unknown, t: (k: Key, v?: Record<string, string | number>) => string): string {
  const code = errorCode(e);
  if (code === 'rate_limited') {
    const ms = e instanceof ApiError ? e.retryAfterMs : undefined;
    return t('su.errWait', { m: Math.max(1, Math.ceil((ms ?? 60_000) / 60_000)) });
  }
  const key: Key = code === 'invalid_code' ? 'su.errCode' : code === 'code_expired' ? 'su.errExpired' : code === 'code_attempts' ? 'su.errTries'
    : code === 'signup_cooldown' ? 'su.errCooldown' : code === 'invalid_email' || code === 'invalid_request' ? 'su.errEmail' : code === 'challenge_required' ? 'common.challenge' : 'common.error';
  return t(key);
}

export function Signup() {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  const query = new URLSearchParams(loc.search);
  // H3: after the trial (and by default) he lands in her room, the conversation he had merged into it.
  const next = safeNext(query.get('next'), '/me/home');
  // One e-mail code both signs up and logs in. Only a visitor carrying a trial conversation is asked to save it
  // (「会話を保存して続ける」); anyone else — the menu, a link into the member pages — gets the neutral log-in words (M2, A-M5).
  const saving = query.get('mode') !== 'login' && state.trialLog.length > 0;
  const herLine: Key = saving ? 'su.her' : DEST_LINE.find(([re]) => re.test(next))?.[1] ?? 'su.loginHer';
  const star = getStar(state.trialLog.length ? state.trialStar : state.star);
  const [step, setStep] = useState<'choose' | 'code'>('choose');
  const [email, setEmail] = useState(draftEmail);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // B-N5: an address closed under 18 is refused (signup_cooldown): no resend offered for it, until the address changes.
  const [refused, setRefused] = useState(false);
  const [ttl, setTtl] = useState(10);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  useEffect(() => {
    if (!wait) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.user) return <Navigate to={next} replace />;

  function signedIn(r: Login) {
    keepEmail(null);
    actions.login(r.user);
    if (r.me) actions.hydrateMe(r.me);
    nav(next, { replace: true });
  }
  async function send(resend: boolean) {
    if (!EMAIL_RE.test(email.trim())) { setErr(t('su.errEmail')); return; }
    setBusy(true); setErr(null); setNote(null);
    setTtl(10);
    setWaitUntil(Date.now() + RESEND_WAIT_S * 1000);
    setNow(Date.now());
    setStep('code');
    if (resend) { setCode(''); setNote(t('su.resent')); }
    setBusy(false);
  }
  const onEmail = (e: FormEvent) => { e.preventDefault(); void send(false); };
  async function onCode(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}$/.test(code)) { setErr(t('su.errFmt')); return; }
    setBusy(true); setErr(null); setNote(null);
    if (code !== DEMO_OTP) { setErr(t('su.errCode')); setBusy(false); return; }
    signedIn({
      user: {
        via: 'email',
        email: email.trim(),
        nickname: email.split('@')[0].replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12) || 'あなた'
      },
      me: null
    });
  }

  const art = stillOf(sceneFor(star.id, false) ?? media(`${star.id}-hero-9x16`), true);
  return (
    // #21: A2 on the night — her picture (a print of her hero clip), her name and her line, the form under them.
    <div className="page login signup-login" data-star={star.id}>
      {art && <img className="login-art" src={art} alt="" decoding="async" draggable={false} />}
      <Header back={true} />
      {verticalName(t.lang) && <span className="js-vname login-name" aria-hidden="true"><span className="js-vname-jp">{starName(star, t.lang)}</span><span className="js-vname-ro">{star.romaji}</span></span>}
      <div className="col login-col">
        <section aria-labelledby="su-title" className="login-form">
          <p className="login-her">{quoted(t(herLine), t.lang)}</p>
          <h1 id="su-title" className="h1">{t(saving ? 'su.title' : 'su.loginTitle')}</h1>
          {step === 'choose' ? (
            <>
              <form className="stack" onSubmit={onEmail} noValidate>
                <div className="field">
                  <label htmlFor="email">{t('su.email')}</label>
                  <input id="email" className="input" type="email" inputMode="email" autoComplete="email" maxLength={120} value={email} onChange={(e) => { setEmail(e.target.value); keepEmail(e.target.value); setRefused(false); }} aria-invalid={!!err} aria-describedby={err ? 'su-err' : undefined} placeholder="you@example.com" />
                </div>
                {err && <p id="su-err" className="err" role="alert">{err}</p>}
                <button type="submit" className="btn btn-rose" disabled={busy}>{busy ? t('su.sending') : t('su.send')}</button>
              </form>
              <p className="login-note" data-testid="su-other">{t(saving ? 'su.returning' : 'su.loginNew')}</p>
            </>
          ) : (
            <form className="stack fade-in" onSubmit={onCode} noValidate>
              <p className="login-note">{t('su.sent', { email })}<br /><span data-testid="su-ttl">{t('su.ttl', { m: ttl })}</span></p>
              <p className="login-note">{t('su.demo', { code: DEMO_OTP })}</p>
              <div className="field">
                <label htmlFor="otp">{t('su.code')}</label>
                <input id="otp" className="input login-otp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{4}" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-invalid={!!err} aria-describedby={err ? 'su-err' : undefined} autoFocus />
              </div>
              {err && <p id="su-err" className="err" role="alert">{err}</p>}
              {note && <p className="login-note" role="status">{note}</p>}
              <button type="submit" className="btn btn-rose" disabled={busy}>{busy ? t('su.checking') : t(saving ? 'su.submit' : 'su.loginSubmit', { first: starFirst(star, t.lang) })}</button>
              {/* M1: a code that expired or was spent by wrong tries is replaced here, after a short wait. */}
              {!refused && <button type="button" className="btn-text" disabled={busy || wait > 0} onClick={() => void send(true)} data-testid="su-resend">{wait > 0 ? t('su.resendIn', { s: wait }) : t('su.resend')}</button>}
              <button type="button" className="btn-text" onClick={() => { setStep('choose'); setCode(''); setErr(null); setNote(null); }}>{t('su.change')}</button>
            </form>
          )}
          <p className="login-legal">{t('su.agreeA')}<Link to="/legal/terms">{t('legal.terms')}</Link>{t('su.agreeB')}<Link to="/legal/privacy">{t('legal.privacy')}</Link>{t('su.agreeC')}</p>
        </section>
      </div>
    </div>
  );
}

const SERIAL_ERRORS: Record<string, Key> = {
  invalid_serial_format: 'serial.errFormat', invalid_request: 'serial.errFormat', serial_not_found: 'serial.errNotfound', serial_already_used: 'serial.errUsed', challenge_required: 'common.challenge'
};

const pct = (x: number) => Math.round(x * 1000) / 10;

/** Published rates of one printed code (docs/compliance-jp.md): the guaranteed first card, then the rest. */
function LuckyRates() {
  const t = useT();
  const first = floorRates('SR');
  const rest = DEFAULT_RATES;
  return (
    <details className="small" data-testid="lucky-rates">
      <summary className="rates-sum">{t('gacha.rates')}</summary>
      <p style={{ margin: '6px 0 0' }}>{t('serial.ratesFirst', { ur: pct(first.UR), ssr: pct(first.SSR), sr: pct(first.SR) })}</p>
      <p style={{ margin: '4px 0 0' }}>{t('serial.ratesRest', { n: CONFIG.lucky.drawsPerCode, ur: pct(rest.UR), ssr: pct(rest.SSR), sr: pct(rest.SR), r: pct(rest.R), nn: pct(rest.N) })}</p>
    </details>
  );
}

export function SerialInput() {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  const fromQr = serialFromQuery(loc.search);
  const [code, setCode] = useState(fromQr ? formatSerial(fromQr) : '');
  const [err, setErr] = useState<string | null>(null);
  const [chargeOpen, setChargeOpen] = useState(false);
  // M6: another QR scanned (or a ?code link followed) while this page is open fills the field again.
  const seen = useRef(fromQr);
  useEffect(() => {
    if (fromQr === seen.current) return;
    seen.current = fromQr;
    if (fromQr) { setCode(formatSerial(fromQr)); setErr(null); }
  }, [fromQr]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const locked = state.serialLockUntil > now;
  useEffect(() => {
    if (!locked) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [locked]);

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    // Grouped as printed (1234-5678-9012) only while typing at the end and outside IME composition,
    // so the caret never jumps during an edit in the middle; blur tidies up the rest.
    const atEnd = el.selectionStart === el.value.length && !(e.nativeEvent as InputEvent).isComposing;
    setCode(atEnd ? formatSerial(el.value) : el.value);
    setErr(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked || busy) return;
    const n = normalizeSerial(code);
    // Twelve digits with a wrong check digit is a typo on a real code; anything else is not a code at all.
    if (!isValidSerialFormat(n)) { setErr(t(SERIAL_RE.test(n) ? 'serial.errTypo' : 'serial.errFormat')); return; }
    setBusy(true); setErr(null);
    try {
      const r = await redeemSerial(state, n);
      actions.applyRedeem(r.code, r);
      // A member's duplicates raise their bond on the server; reload the account so it shows (no-op offline).
      if (r.claimed) void bootstrap().then((b) => { if (b.kind === 'member') actions.hydrateMe(b.me); });
      nav('/gacha/redeem', { replace: true });
    } catch (e) {
      const code = errorCode(e);
      // The API decides the lockout; the browser mirrors it so the countdown shows without another request.
      if (code === 'serial_locked') actions.serialLock(Date.now() + CONFIG.serialLockMs);
      else if (code === 'serial_not_found') actions.serialFail(Date.now());
      setErr(code === 'serial_locked' ? null : t(SERIAL_ERRORS[code] ?? 'common.error'));
    } finally {
      setBusy(false);
    }
  }
  const mins = Math.ceil((state.serialLockUntil - now) / 60000);
  return (
    <main className="page night-page serial-page">
      <Header back="/" title={t('serial.title')} />
      <div className="col">
        <section className="stack pad" style={{ gap: 14, marginTop: 12 }}>
          <h1 className="h1 pre">{t('serial.h1')}</h1>
          <p className="small muted" style={{ margin: 0, fontSize: 13 }}>{t('serial.body')}</p>
          <p className="small" data-testid="serial-gets" style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="spark" size={14} /></span>{t('serial.gets', { n: CONFIG.lucky.drawsPerCode, days: CONFIG.serialDefaultTrialDays })}
          </p>
        </section>
        <form onSubmit={onSubmit} noValidate className="panel stack" style={{ margin: '24px 24px 0' }}>
          <div className="field">
            <label htmlFor="serial">{t('serial.label')}</label>
            <input id="serial" className="input serif" value={code} maxLength={24} inputMode="numeric" autoComplete="off" spellCheck={false}
              onChange={onChange} onBlur={() => code && setCode(formatSerial(code))}
              aria-invalid={!!err} aria-describedby="serial-help" placeholder="1234-5678-9012" style={{ fontSize: 19, letterSpacing: '0.1em' }} disabled={locked} />
          </div>
          <div id="serial-help" aria-live="polite">
            {locked ? <p className="err" role="alert" style={{ margin: 0 }}>{t('serial.locked', { m: mins })}</p>
              : err ? <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>
                : fromQr ? <p className="ok" style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="check" size={14} />{t('serial.qr')}</p>
                  : <p className="tiny muted" style={{ margin: 0 }}>{t('serial.help')}</p>}
          </div>
          <div className="serial-demo" aria-label={t('serial.demoLabel')}>
            <span className="tiny muted">{t('serial.demoLabel')}</span>
            <div>
              {DEMO_SERIALS.map((item) => {
                const used = state.redeemed.includes(item);
                return <button key={item} type="button" disabled={used || busy || locked}
                  aria-label={`${t('serial.demoUse')} ${formatSerial(item)}`}
                  onClick={() => { setCode(formatSerial(item)); setErr(null); }}>
                  {formatSerial(item)}
                </button>;
              })}
            </div>
          </div>
          <button type="submit" className="btn btn-rose" disabled={busy || locked || !code.trim()}>{busy ? t('serial.checking') : t('serial.submit')}</button>
        </form>
        <div className="serial-charge">
          <div><span className="js-label">STAR STONE</span><p>{t('serial.chargeBody')}</p></div>
          <button type="button" className="btn btn-line" onClick={() => setChargeOpen(true)} aria-haspopup="dialog">{t('serial.charge')}</button>
        </div>
        <div className="tiny muted pad" style={{ textAlign: 'center', margin: '14px 0 24px' }}>
          <p style={{ margin: '0 0 6px' }}>{t('serial.once')}</p>
          <LuckyRates />
        </div>
      </div>
      <ChargeModal open={chargeOpen} onClose={() => setChargeOpen(false)} />
    </main>
  );
}

export { StarAvatar };

/** B-P2: a line written on two lines, as one: no half-width space after a full-width stop (。！？…」), one between Latin sentences. */
export const oneLine = (s: string) => s.replace(/([。！？…」』])\n/g, '$1').replace(/\n/g, ' ');
