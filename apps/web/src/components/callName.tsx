import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { BOND_RULES } from '@jstar/shared/rules';
import { cleanCallName } from '@jstar/shared/bond';
import { getStar } from '../data/cast';
import { starFirst } from '../i18n';
import { useStore, useT } from '../lib/store';
import { http, serverMode } from '../services/http';

/**
 * 「呼び方」 (#56): the name all five use for him, in place of his account name. Each keeps her own form of it by stage
 * (さん / くん / the name alone), and asks before she changes it. Checked here as the server checks it (length, no
 * contact details); the persona service's safety filter checks the words. Server mode only, like the other settings.
 */
export function CallNameSetting({ style }: { style?: CSSProperties }) {
  const t = useT();
  const { state } = useStore();
  const star = getStar(state.star);
  /** undefined while loading; null = none set. */
  const [name, setName] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [called, setCalled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<'saved' | 'invalid' | 'failed' | null>(null);

  const preview = () => http.bond(star.id, t.lang).then((b) => setCalled(b.callName)).catch(() => setCalled(null));
  useEffect(() => {
    if (!serverMode()) return;
    let live = true;
    http.callNameGet().then((r) => { if (live) { setName(r.name); setDraft(r.name ?? ''); } }).catch(() => { if (live) setName(null); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (serverMode()) void preview(); }, [star.id, t.lang]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!serverMode() || name === undefined) return null;

  const save = async (next: string | null) => {
    if (next !== null && !cleanCallName(next)) { setNote('invalid'); return; }
    setBusy(true);
    setNote(null);
    try {
      const r = await http.callNameSet(next);
      setName(r.name);
      setDraft(r.name ?? '');
      setNote('saved');
      // L11 (C-room): 「X 現在叫你：…」 follows the saved name — read again until it does (a read may still answer with
      // the old one for a moment), at most three times.
      for (let i = 0; i < 3; i++) {
        const b = await http.bond(star.id, t.lang).catch(() => null);
        if (b) setCalled(b.callName);
        if (!b || b.callName !== called || r.name === name) break;
        await new Promise((ok) => setTimeout(ok, 800));
      }
    } catch (e) {
      setNote((e as { code?: string }).code === 'invalid_name' ? 'invalid' : 'failed');
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void save(draft.trim() ? draft : null); };

  return (
    <section className="panel stack" style={style} aria-labelledby="call-title" data-testid="call-name">
      <h2 id="call-title" className="serif" style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '0.1em' }}>{t('call.title')}</h2>
      <p className="small" style={{ margin: 0 }}>{t('call.body')}</p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
        <input className="input" aria-label={t('call.label')} placeholder={t('call.placeholder')} maxLength={BOND_RULES.nameMax} autoComplete="nickname" value={draft}
          onChange={(e) => { setDraft(e.target.value); setNote(null); }} data-testid="call-input" />
        <button type="submit" className="btn btn-navy" style={{ flex: 'none', minHeight: 50 }} disabled={busy || draft.trim() === (name ?? '')}>{t('call.save')}</button>
      </form>
      {called && <p className="small muted" style={{ margin: 0 }} data-testid="call-now">{t('call.now', { first: starFirst(star, t.lang), call: called })}</p>}
      {name && <button type="button" className="btn-text" style={{ textAlign: 'left' }} disabled={busy} onClick={() => void save(null)} data-testid="call-clear">{t('call.clear')}</button>}
      {note === 'saved' && <p role="status" className="small" style={{ margin: 0 }}>{t('call.saved')}</p>}
      {(note === 'invalid' || note === 'failed') && (
        <p role="alert" className="small" style={{ margin: 0, color: 'var(--err)' }}>{note === 'invalid' ? t('call.invalid', { n: BOND_RULES.nameMax }) : t('call.failed')}</p>
      )}
    </section>
  );
}
