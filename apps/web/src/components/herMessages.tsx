import { useEffect, useState, type CSSProperties } from 'react';
import { HER_MESSAGE_RULES } from '@jstar/shared/rules';
import { HER_MESSAGE_MODES, type HerMessageMode } from '@jstar/shared/herMessages';
import { useT } from '../lib/store';
import { http, serverMode } from '../services/http';

/**
 * How often she writes to him on her own (#58): normal, fewer, or none. Takes effect at once (the server checks it
 * before every message). Server mode only: the prototype has no account to keep it on. Notifications stay their own
 * switch, per browser (PushOptIn).
 */
export function HerMessagesSetting({ style }: { style?: CSSProperties }) {
  const t = useT();
  /** undefined while loading; null when it could not be read (the panel then stays hidden). */
  const [mode, setMode] = useState<HerMessageMode | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!serverMode()) return;
    let live = true;
    http.herSettings().then((r) => { if (live) setMode(r.mode); }).catch(() => { if (live) setMode(null); });
    return () => { live = false; };
  }, []);

  if (!serverMode() || !mode) return null;

  const choose = async (next: HerMessageMode) => {
    if (next === mode) return;
    setBusy(true);
    setFailed(false);
    try { setMode((await http.herSettingsSet(next)).mode); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const label: Record<HerMessageMode, string> = {
    normal: t('her.normal', { n: HER_MESSAGE_RULES.perDay }),
    less: t('her.less', { n: HER_MESSAGE_RULES.lessPerDay }),
    off: t('her.off')
  };

  return (
    <section className="panel stack" style={style} aria-labelledby="her-title" data-testid="her-messages" data-mode={mode}>
      <h2 id="her-title" className="serif" style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '0.1em' }}>{t('her.title')}</h2>
      <p className="small" style={{ margin: 0 }}>{t('her.body')}</p>
      <div role="group" aria-label={t('her.label')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {HER_MESSAGE_MODES.map((m) => (
          <button key={m} type="button" className="chip" style={{ minHeight: 44 }} aria-pressed={m === mode} disabled={busy} onClick={() => void choose(m)} data-testid={`her-mode-${m}`}>
            {label[m]}
          </button>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('her.note', { from: HER_MESSAGE_RULES.quietHours.from, to: HER_MESSAGE_RULES.quietHours.to })}</p>
      {failed && <p role="alert" className="small" style={{ margin: 0, color: 'var(--err)' }}>{t('her.failed')}</p>}
    </section>
  );
}
