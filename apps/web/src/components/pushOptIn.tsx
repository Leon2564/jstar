import { useEffect, useState, type CSSProperties } from 'react';
import { getStar, type StarId } from '../data/cast';
import { starFirst } from '../i18n';
import { useT } from '../lib/store';
import { disablePush, enablePush, pushStatus, sendTestPush, syncPush, type PushStatus } from '../lib/push';
import { isDemo } from '../services/api';

/** iOS share glyph (a box with an arrow out of it), as drawn on the Safari toolbar. */
const ShareGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12M8 7l4-4 4 4" /><path d="M7 11H5v10h14V11h-2" />
  </svg>
);
const AddGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" />
  </svg>
);
const AppGlyph = () => (
  <svg width="18" height="18" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false">
    <rect x="-11.5" y="-11.5" width="23" height="23" rx="5" fill="var(--navy-deep)" stroke="currentColor" strokeOpacity=".6" />
    <path d="M0 -7 C.7 -1.4 1.4 -.7 7 0 C1.4 .7 .7 1.4 0 7 C-.7 1.4 -1.4 .7 -7 0 C-1.4 -.7 -.7 -1.4 0 -7 Z" fill="var(--rose)" />
  </svg>
);

/** iOS allows Web Push only for a site opened from the home screen, so the first step is getting it there. */
export function IosGuide() {
  const t = useT();
  const steps = [[<ShareGlyph key="s" />, t('push.ios1')], [<AddGlyph key="a" />, t('push.ios2')], [<AppGlyph key="p" />, t('push.ios3')]] as const;
  return (
    <>
      <p className="small" style={{ margin: 0 }}>{t('push.iosTitle')}</p>
      <ol className="push-steps" data-testid="push-ios-guide">
        {steps.map(([glyph, text], i) => (
          <li key={i}><span className="push-step-n">{i + 1}</span><span className="push-step-g">{glyph}</span><span>{text}</span></li>
        ))}
      </ol>
    </>
  );
}

/**
 * Turning her notifications on or off for this browser. Placed where the user already expects settings (My page,
 * and the wake-up alarm right after he saves one, #57) and never shown by itself on load: the browser's
 * permission prompt appears only after a tap here. Hidden entirely while push is off on the server.
 */
export function PushOptIn({ star, style }: { star: StarId; style?: CSSProperties }) {
  const t = useT();
  const first = starFirst(getStar(star), t.lang);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    void pushStatus().then((s) => {
      if (!live) return;
      setStatus(s);
      // The same browser may be signed in to another account now, or the API dropped the row: keep them in step.
      if (s === 'on') void syncPush();
    }).catch(() => { if (live) setStatus('unavailable'); });
    return () => { live = false; };
  }, []);

  if (!status || status === 'unavailable') return null;

  const toggle = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (status === 'on') { await disablePush(); setStatus('off'); }
      else setStatus(await enablePush());
    } catch {
      setMessage({ text: t('push.failed'), error: true });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try { setMessage({ text: t('push.testSent', { n: (await sendTestPush(star)).sent }), error: false }); } catch { setMessage({ text: t('push.failed'), error: true }); } finally { setBusy(false); }
  };

  const switchable = status === 'on' || status === 'off';
  return (
    <section className="panel stack" style={style} aria-labelledby="push-title" data-testid="push-optin" data-status={status}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h2 id="push-title" className="serif" style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '0.1em' }}>{t('push.title')}</h2>
        {switchable && <span className="small muted">{t(status === 'on' ? 'push.on' : 'push.off')}</span>}
      </div>
      {status === 'ios-install' && <IosGuide />}
      {status === 'denied' && <p className="small" style={{ margin: 0 }}>{t('push.denied')}</p>}
      {status === 'unsupported' && <p className="small" style={{ margin: 0 }}>{t('push.unsupported')}</p>}
      {switchable && (
        <>
          <p className="small" style={{ margin: 0 }}>{t(status === 'on' ? 'push.onBody' : 'push.offBody', { first })}</p>
          <button type="button" className={`btn ${status === 'on' ? 'btn-ghost' : 'btn-navy'}`} disabled={busy} aria-pressed={status === 'on'} onClick={() => void toggle()} data-testid="push-toggle">
            {t(status === 'on' ? 'push.disable' : 'push.enable')}
          </button>
        </>
      )}
      <p className="small muted" style={{ margin: 0 }}>{t('push.note')}</p>
      {message && <p role={message.error ? 'alert' : 'status'} className="small" style={{ margin: 0, color: message.error ? 'var(--err)' : undefined }}>{message.text}</p>}
      {status === 'on' && isDemo() && <button type="button" className="btn-text" style={{ textAlign: 'left' }} disabled={busy} onClick={() => void test()}>{t('push.test')}</button>}
    </section>
  );
}
