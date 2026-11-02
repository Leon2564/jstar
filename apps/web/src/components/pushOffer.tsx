import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getStar } from '../data/cast';
import { starFirst } from '../i18n';
import { useStore, useT } from '../lib/store';
import { enablePush, pushStatus } from '../lib/push';
import { IosGuide } from './pushOptIn';
import { Icon } from './ui';
import './gift.css';

/** Set once the offer was shown (whatever he answered): she asks once per browser, never again. */
const OFFERED_KEY = 'jstar.pushOffered';
/** The alarm page says so when he saves an alarm (pages/alarm.tsx): the other moment she offers it. */
export const ALARM_SET_EVENT = 'jstar:alarm-set';
/** His message went and she answered (pages/chatSend.ts, her room and her chat alike): the first moment she offers it. */
export const REPLIED_EVENT = 'jstar:replied';

/** B-R3: how long his choices stay on their own before her notifications are offered over them. */
export const REPLIED_WAIT_MS = 4_000;

const offered = (): boolean => { try { return localStorage.getItem(OFFERED_KEY) === '1'; } catch { return true; } };
const markOffered = () => { try { localStorage.setItem(OFFERED_KEY, '1'); } catch { /* storage blocked: this visit only */ } };

/**
 * M11: her notifications are offered at the two moments they mean something — after his first reply to her, and when he
 * sets her alarm — as an A2 sheet over the screen, once, dismissible. Only while the browser can turn push on here and
 * now (status `off`); the permission prompt still only follows his tap on 「通知を受け取る」. My page keeps the switch.
 */
export function PushOffer() {
  const { state } = useStore();
  const t = useT();
  // `ios`: iPhone Safari outside the home screen, where only adding JSTAR to it makes notifications possible.
  const [open, setOpen] = useState<false | 'off' | 'ios'>(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const offer = () => {
      if (offered()) return;
      void pushStatus().then((s) => { if ((s === 'off' || s === 'ios-install') && !offered()) { markOffered(); setOpen(s === 'off' ? 'off' : 'ios'); } }).catch(() => undefined);
    };
    // B-R3: after her reply his choices come first — the sheet waits REPLIED_WAIT_MS of him reading them; a tap (or a
    // key) in that time is him answering her, and the offer waits for her next reply instead of landing on it.
    let wait: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (wait) { clearTimeout(wait); wait = null; } };
    const replied = () => { if (offered() || wait) return; wait = setTimeout(() => { wait = null; offer(); }, REPLIED_WAIT_MS); };
    window.addEventListener(ALARM_SET_EVENT, offer);
    window.addEventListener(REPLIED_EVENT, replied);
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('keydown', stop, true);
    return () => {
      stop();
      window.removeEventListener(ALARM_SET_EVENT, offer);
      window.removeEventListener(REPLIED_EVENT, replied);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
    };
  }, []);
  if (!open) return null;
  const first = starFirst(getStar(state.star), t.lang);
  const close = () => setOpen(false);
  const on = async () => {
    setBusy(true);
    try { await enablePush(); } catch { /* My page's switch says what went wrong if he tries again there */ } finally { setBusy(false); close(); }
  };
  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="push-offer-title" className="gift-backdrop call" data-testid="push-offer" onClick={close}>
      <div className="panel gift-sheet call solid" onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 id="push-offer-title">{t('push.offerTitle', { first })}</h2>
          <button type="button" className="round" onClick={close} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </div>
        <p className="small" style={{ margin: 0 }}>{t('push.offBody', { first })}</p>
        {/* The guide's numbers and glyphs are drawn in navy on a light page: turned over for the night sheet. */}
        {open === 'ios' && <div style={{ display: 'contents', '--navy': '#EFE8ED', '--ivory': '#1B1E3D' } as React.CSSProperties}><IosGuide /></div>}
        <p className="tiny" style={{ margin: 0, color: 'var(--iv-meta)' }}>{t('push.note')}</p>
        {open === 'off' && <button type="button" className="btn btn-rose" disabled={busy} onClick={() => void on()} data-testid="push-offer-yes">{t('push.enable')}</button>}
        <button type="button" className="btn-text" onClick={close} data-testid="push-offer-no">{t(open === 'off' ? 'push.later' : 'common.close')}</button>
      </div>
    </div>,
    document.body
  );
}
