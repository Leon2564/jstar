/**
 * Voice minutes on the web (#74): the meter in her room and in scenes (minutes left today), the sheet that buys +30
 * minutes with points (never money in v1.1), and today's use on My page. The API decides everything; these only show
 * `state.voice` (from /v1/auth/me) and send the request. Prototype mode and visitors have no voice time: nothing shows.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { VoiceExtendResT } from '@jstar/shared/contracts';
import { VOICE_RULES } from '@jstar/shared/rules';
import { useStore, useT } from '../lib/store';
import { lineRequestId } from '../lib/ttsQueue';
import { errorCode } from '../services/api';
import { http } from '../services/http';
import { Icon } from './ui';
import './gift.css';
import './voiceMinutes.css';

/** Whole minutes left, rounded up (59 s left is still "1 minute"). */
/** C-room L3: whole minutes left, rounded down (568 s is 9, never 10); 1 while any second is left, 0 when none. */
export const minutesLeft = (seconds: number) => (seconds > 0 ? Math.max(1, Math.floor(seconds / 60)) : 0);

/** Why an extension cannot be bought now, as a dictionary key; null when it can. */
export function extendBlock(voice: { extensionsLeft: number; extendCost: number } | null, points: number): 'voice.limit' | 'voice.short' | null {
  if (!voice) return null;
  if (voice.extensionsLeft <= 0) return 'voice.limit';
  return points < voice.extendCost ? 'voice.short' : null;
}

/** 「声 残り7分」: minutes left today; a tap opens the extension sheet. Nothing while there is no voice time to show. */
export function VoiceMeter({ className = 'reward', style }: { className?: string; style?: React.CSSProperties }) {
  const { state } = useStore();
  const t = useT();
  const [open, setOpen] = useState(false);
  const v = state.voice;
  if (!v) return null;
  const n = minutesLeft(v.leftSeconds);
  return (
    <>
      <button type="button" className={`${className} voice-meter${n <= VOICE_RULES.lowMinutes ? ' low' : ''}`} style={style} data-testid="voice-meter"
        aria-haspopup="dialog" aria-label={t('voice.meterLabel', { n })} onClick={() => setOpen(true)}>
        <Icon name="mic" size={12} /><span aria-hidden="true">{t('voice.meter', { n })}</span>
      </button>
      {open && <ExtendSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The confirm sheet: what an extension costs, what he has, and the one button. `pay` replaces the plain extension
 * when the extension is a step of a scene (アリス's 「30分延長する」, #69): the scene's own answer is sent, the API
 * charges the same ledger. The request id is made once per opened sheet, so a retry is charged once.
 */
export function ExtendSheet({ onClose, pay, title, onDone }: { onClose: () => void; pay?: () => Promise<void>; title?: string; onDone?: (r: VoiceExtendResT | null) => void }) {
  const { state, actions } = useStore();
  const t = useT();
  const v = state.voice;
  const cost = v?.extendCost ?? VOICE_RULES.extendCostPoints;
  const minutes = v?.extendMinutes ?? VOICE_RULES.extendMinutes;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(lineRequestId().replace(/^line-/, 'ext-'));
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Prototype mode has no voice time (v is null): a scene's paid option only needs the points there.
  const block = v ? extendBlock(v, state.points) : state.points < cost ? 'voice.short' as const : null;
  const reason = (key: 'voice.limit' | 'voice.short') => t(key, { n: Math.max(0, cost - state.points) });

  async function go() {
    if (busy || block) return;
    setBusy(true);
    setError(null);
    try {
      if (pay) { await pay(); onDone?.(null); }
      else {
        const r = await http.voiceExtend(requestId.current);
        actions.setVoice(r.voice, r.points);
        onDone?.(r);
      }
      onClose();
    } catch (e) {
      const code = errorCode(e);
      setError(code === 'insufficient_points' ? reason('voice.short') : code === 'extend_limit' ? t('voice.limit') : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  // N-02: on document.body, so no stacking context of the page (her room's content layer sits under the tab bar)
  // can put the sheet — and its button — beneath the fixed tab bar.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title ?? t('voice.extendTitle')} className="gift-backdrop" data-testid="voice-extend" onClick={onClose}>
      <div ref={panel} tabIndex={-1} className="panel gift-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 className="serif">{title ?? t('voice.extendTitle')}</h2>
          <button type="button" className="round" onClick={onClose} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </div>
        <p className="small" style={{ margin: 0 }}>{t('voice.extendBody', { cost, min: minutes })}</p>
        <p className="tiny gift-meta" data-testid="voice-extend-meta">
          {t('voice.extendMeta', { points: state.points.toLocaleString('ja-JP'), n: v?.extensionsLeft ?? VOICE_RULES.extendsPerDay })}
        </p>
        <p className="tiny muted gift-note">{t('voice.extendNote')}</p>
        {error && <p className="small gift-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-rose gift-send" data-testid="voice-extend-go" disabled={!!block || busy} onClick={() => void go()}>
          {block ? reason(block) : t('voice.extendGo', { cost })}
        </button>
        {block === 'voice.short' && <Link to="/me/shop" className="tiny gift-charge">{t('gift.charge')}</Link>}
      </div>
    </div>,
    document.body
  );
}

/** My page: today's voice time (used / left) and the way to extend it. */
export function VoiceToday({ style, onNotice }: { style?: React.CSSProperties; onNotice?: (msg: string) => void }) {
  const { state } = useStore();
  const t = useT();
  const [open, setOpen] = useState(false);
  const v = state.voice;
  if (!v) return null;
  return (
    <section className="panel voice-today" style={style} data-testid="voice-today" aria-label={t('voice.today')}>
      <div>
        <h2 className="small" style={{ margin: 0 }}>{t('voice.today')}</h2>
        <p className="tiny muted" style={{ margin: '2px 0 0' }}>{t('voice.usage', { used: Math.ceil(v.usedSeconds / 60), left: minutesLeft(v.leftSeconds) })}</p>
      </div>
      <button type="button" className="btn btn-line" style={{ minHeight: 40 }} onClick={() => setOpen(true)} aria-haspopup="dialog">{t('voice.extendAction')}</button>
      {/* L4: an extension says so (the meter above changes quietly otherwise). */}
      {open && <ExtendSheet onClose={() => setOpen(false)} onDone={(r) => onNotice?.(t('voice.extended', { min: r?.voice.extendMinutes ?? v.extendMinutes }))} />}
    </section>
  );
}

/** JST day he last heard her say his voice time is nearly up (once a day, #74). */
const LOW_KEY = 'jstar.voiceLow';
export function takeLowNotice(day: string): boolean {
  try {
    if (localStorage.getItem(LOW_KEY) === day) return false;
    localStorage.setItem(LOW_KEY, day);
  } catch { /* storage blocked: say it, at most once per page */ }
  return true;
}
