/**
 * The scene's interface layer, over the stage, in A2 (docs/design-system.md) as her room's subtitle band: her words
 * (centred at the foot, a small wave over them while she speaks), his numbered choices under them, the hairline input,
 * the affinity float (top-right), the countdown (top) and the memory card at the end (centre). Every control is a real
 * button or input, so the scene plays by keyboard alone.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { pageEnds, quoteLine } from '../lib/lines';
import { Phrased, phrasesOf } from './phrases';
import { Icon } from '../components/ui';
import { HandsFreeToggle, MicButton, useHandsFree, useVoice } from '../components/voice';
import { useT } from '../lib/store';
import type { Key } from '../i18n';
import '../system/system.css';

/** Three bars that move while she speaks; still (and just a mark) under reduced motion. */
export function Wave({ on }: { on: boolean }) {
  return <span className={`scn-wave${on ? ' on' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

/** Lets the player turn her subtitle's page (a tap, Enter): true when there was a next page to turn to. */
export interface Pager { next: () => boolean }

/**
 * Her words, in her language's quotes (M5, L1), at most three lines at a time (M4, the B rule): a longer line is cut
 * into pages at whole sentences (lib/lines.ts, as her room does), ▼ marking that more follows. The pages turn with
 * `progress` (how much of the line she has said, 0–1: her voice's clock, or the reading time) or by `pager` (a tap).
 * Always whole in the live region for screen readers; hiding subtitles only hides them visually.
 * `filler` lines (a reaction while a clip or her reply is on its way) are marked so tests and styles can tell.
 */
export function Subtitle({ text, speaking, visible, filler, who, lang, progress, pager }: {
  text: string; speaking: boolean; visible: boolean; filler?: boolean; who: string; lang: string;
  progress?: () => number; pager?: MutableRefObject<Pager | null>;
}) {
  const quoted = quoteLine(text, lang);
  const [o, c] = [quoted[0] ?? '', quoted.slice(-1)];
  const body = quoted.slice(1, -1);
  const measure = useRef<HTMLParagraphElement>(null);
  const [ends, setEnds] = useState<number[]>([body.length]);
  const [w, setW] = useState(0);
  useEffect(() => {
    const bump = () => setW((x) => x + 1);
    void document.fonts?.ready.then(bump);
    window.addEventListener('resize', bump);
    return () => window.removeEventListener('resize', bump);
  }, []);
  useLayoutEffect(() => {
    const m = measure.current;
    const cs = m ? getComputedStyle(m) : null;
    const max = cs ? parseFloat(cs.lineHeight) * 3 + 1 : 0;
    const next = m && max > 1 && m.offsetWidth > 0
      ? pageEnds(body, (s) => { m.replaceChildren(...phrasesOf(`${o}${s}${c}▼`, lang).flatMap((p, i) => (i ? [document.createElement('wbr'), p] : [p]))); return m.offsetHeight <= max; }) : [body.length];
    if (m) m.textContent = '';
    setEnds((e) => (e.join() === next.join() ? e : next));
  }, [body, w, o, c, lang]);
  // The page he turned to (a floor: her voice may run ahead of it, never back), reset by a new line.
  const [turned, setTurned] = useState({ text: body, page: 0 });
  const floor = turned.text === body ? turned.page : 0;
  const [said, setSaid] = useState(0);
  const pages = ends[ends.length - 1] === body.length ? ends : [body.length];
  useEffect(() => {
    if (pages.length < 2 || !progress) { setSaid(0); return undefined; }
    const tick = () => setSaid(Math.max(0, Math.min(1, progress())));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [pages.length, progress, body]);
  const byVoice = pages.findIndex((e) => e > Math.floor(said * body.length));
  const page = Math.min(pages.length - 1, Math.max(floor, byVoice < 0 ? pages.length - 1 : byVoice));
  const last = page === pages.length - 1;
  const latest = useRef({ page, last, body });
  latest.current = { page, last, body };
  useEffect(() => {
    if (!pager) return undefined;
    pager.current = { next: () => {
      const l = latest.current;
      if (l.last) return false;
      setTurned({ text: l.body, page: l.page + 1 });
      return true;
    } };
    return () => { pager.current = null; };
  }, [pager]);
  const shown = `${page ? '' : o}${body.slice(page ? pages[page - 1] : 0, pages[page])}${last ? c : ''}`;
  return (
    <div className={`scn-sub${visible ? '' : ' hidden'}`} data-testid="scene-sub" data-filler={filler ? 'true' : undefined} data-page={pages.length > 1 ? `${page + 1}/${pages.length}` : undefined}>
      <Wave on={speaking} />
      {/* One page: the line itself is the live region. Paged: the page is seen, the whole line is read. */}
      <p className={visible ? '' : 'sr-only'} aria-live={pages.length > 1 ? undefined : 'polite'} aria-hidden={pages.length > 1 || undefined} lang={lang}>
        {pages.length > 1 ? null : <span className="sr-only">{who}: </span>}<Phrased text={shown} lang={lang} />{!last && <span className="js-more">▼</span>}
      </p>
      {pages.length > 1 && <p className="sr-only" aria-live="polite">{who}: {quoted}</p>}
      <p ref={measure} className="scn-measure" aria-hidden="true" lang={lang} />
    </div>
  );
}

/** Answers above the input bar. Number keys pick them too; the first takes focus so Enter answers at once. */
export function Choices({ label, options, onPick, disabled }: { label: string; options: { id: string; label: string; off?: boolean }[]; onPick: (id: string) => void; disabled?: boolean }) {
  const first = useRef<HTMLButtonElement>(null);
  const ids = options.map((o) => o.id).join(' ');
  // Focus moves once per new set of answers, never on a re-render (that would pull focus off the subtitle switch).
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, [ids]);
  // One listener for the life of the choices: a key press also wakes the idle timer, and a listener swapped out
  // during that same key press would never hear it.
  const latest = useRef({ options, onPick, disabled });
  latest.current = { options, onPick, disabled };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
      const { options: opts, onPick: pick, disabled: off } = latest.current;
      const n = Number(e.key);
      if (n >= 1 && n <= opts.length && !off && !opts[n - 1].off) { e.preventDefault(); pick(opts[n - 1].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    // L7: the arrow keys move between them, as in any group of options.
    <div className="scn-choices" role="group" aria-label={label} data-testid="scene-choices" onKeyDown={(e) => {
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      all[(at + step + all.length) % all.length]?.focus();
    }}>
      {options.map((o, i) => (
        <button key={o.id} ref={i === 0 ? first : undefined} type="button" className="js-btn-line js-reply" disabled={disabled || o.off} data-testid={`scene-choice-${o.id}`} onClick={() => onPick(o.id)}>
          <kbd aria-hidden="true">{i + 1}</kbd>{o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Your words to her: typed, or said into the mic (#72) — the box shows them as they are heard, and they go the same
 * way. `onTalk` fires the moment he reaches for the mic, so she stops mid-line; `notify` tells him when it failed.
 */
export function InputBar({ placeholder, onSend, disabled, autoFocus, onTalk, notify, keep, mic = true, armed = false }: {
  /** `via`: said into the mic, or typed. `ms`: how long he talked (#74 voice time), for what he said. */
  placeholder: string; onSend: (text: string, via: 'voice' | 'text', ms?: number) => void; disabled?: boolean; autoFocus?: boolean; onTalk?: () => void; notify?: (msg: string) => void;
  /** He chose to keep his voice (her confession, #55): the recording is handed over here as it goes to be heard. */
  keep?: (clip: Blob) => void;
  /** False once today's voice time is used up (#74): the bar takes text only. */
  mic?: boolean;
  /** Hands-free (#72): she has finished and waits for him — the mic may listen by itself, if he turned that on. */
  armed?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const off = useRef(disabled);
  off.current = disabled;
  const talkFrom = useRef(0);
  const auto = useRef(false);
  const voice = useVoice({
    auto,
    onStart: () => { talkFrom.current = Date.now(); onTalk?.(); },
    // While her answer is still on its way, what he said waits in the box instead of being lost.
    onFinal: (said) => { if (off.current) setText(said); else onSend(said, 'voice', talkFrom.current ? Date.now() - talkFrom.current : undefined); },
    onNotice: notify,
    field: ref,
    keep
  });
  const [handsFree, setHandsFree, canHandsFree] = useHandsFree(voice, mic && armed && !disabled && !text, auto, notify);
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (voice.listening) { voice.ctl.toggle(); return; }
    const v = text.trim().slice(0, 500);
    if (!v || disabled) return;
    setText('');
    onSend(v, 'text');
  };
  return (
    <form className="scn-input" onSubmit={submit} data-testid="scene-input">
      {mic && <MicButton voice={voice} className="scn-mic" disabled={disabled} />}
      {mic && <HandsFreeToggle on={handsFree} set={setHandsFree} possible={canHandsFree} className="scn-mic" />}
      <label htmlFor="scene-text" className="sr-only">{t('scene.inputLabel')}</label>
      <input ref={ref} id="scene-text" value={voice.listening ? voice.text : text} maxLength={500} autoComplete="off" enterKeyHint="send"
        placeholder={voice.listening ? t('voice.listening') : placeholder} disabled={disabled}
        onChange={(e) => { if (voice.listening) voice.ctl.cancel(); setText(e.target.value); }} />
      <button type="submit" className="scn-send" aria-label={t('common.send')} disabled={disabled || !(voice.listening || text.trim())}><Icon name="send" size={18} /></button>
    </form>
  );
}

/** "+n" rising at the top right when the server granted affinity. */
export function AffinityFloat({ n, stamp }: { n: number; stamp: number }) {
  const t = useT();
  return <p key={stamp} className="scn-float" role="status" data-testid="scene-affinity">{t('scene.affinity', { n })}</p>;
}

/** Seconds left, at the top: her patience for an answer, or the date timer. */
export function Countdown({ endsAt, total, label, second }: { endsAt: number; total: number; label: Key; second?: boolean }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, [endsAt]);
  const left = Math.max(0, endsAt - now);
  const s = Math.ceil(left / 1000);
  const text = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s);
  return (
    // N-54: the chip says what it counts (「返事まで残り 30」), never a bare number with a bar.
    <div className={`scn-count${second ? ' second' : ''}`} data-testid={label === 'scene.timer' ? 'scene-timer' : 'scene-countdown'} role="timer" aria-label={t(label, { t: text })}>
      <span aria-hidden="true">{t(label, { t: text })}</span>
      <i aria-hidden="true" style={{ transform: `scaleX(${total > 0 ? left / total : 0})` }} />
    </div>
  );
}
