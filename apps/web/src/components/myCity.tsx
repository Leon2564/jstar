import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import type { CityCandidateT } from '@jstar/shared/contracts';
import { useT } from '../lib/store';
import { http, serverMode } from '../services/http';

/**
 * His own city, optional (#62): she will know the weather where he is (#63). Chosen from a search, so only a real
 * place name is stored, at city level (the server keeps the name and a position rounded to 0.1°); never the
 * device's location. Clearing it deletes it. Server mode only: the prototype has no account to keep it on.
 */
export function MyCity({ style }: { style?: CSSProperties }) {
  const t = useT();
  /** undefined while loading; null = none chosen. */
  const [city, setCity] = useState<string | null | undefined>(undefined);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CityCandidateT[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!serverMode()) return;
    let live = true;
    http.world().then((w) => { if (live) setCity(w.user?.name ?? null); }).catch(() => { if (live) setCity(null); });
    return () => { live = false; };
  }, []);

  if (!serverMode() || city === undefined) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try { await work(); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) void run(async () => setResults((await http.citySearch(q.trim(), t.lang)).results));
  };
  const choose = (c: CityCandidateT) => run(async () => { setCity((await http.citySet(c.id, t.lang)).user.name); setResults(null); setQ(''); });
  const clear = () => run(async () => { await http.cityClear(); setCity(null); });

  return (
    <section className="panel stack" style={style} aria-labelledby="city-title" data-testid="my-city">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h2 id="city-title" className="serif" style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '0.1em' }}>{t('city.title')}</h2>
        <span className="small muted" data-testid="city-current">{city ?? t('city.unset')}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>{t('city.body')}</p>
      <form onSubmit={search} role="search" style={{ display: 'flex', gap: 8 }}>
        <input className="input" type="search" aria-label={t('city.label')} placeholder={t('city.placeholder')} maxLength={60} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} data-testid="city-q" />
        <button type="submit" className="btn btn-navy" style={{ flex: 'none', minHeight: 50 }} disabled={busy || !q.trim()}>{t('city.search')}</button>
      </form>
      {results && (results.length
        ? (
          <ul className="rowlist" aria-label={t('city.results')} data-testid="city-results">
            {results.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => void choose(c)}>
                  <span>{c.name}</span><span className="small muted">{[c.region, c.country].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )
        : <p className="small muted" role="status" style={{ margin: 0 }}>{t('city.none')}</p>)}
      {city && <button type="button" className="btn-text" style={{ textAlign: 'left' }} disabled={busy} onClick={() => void clear()} data-testid="city-clear">{t('city.clear')}</button>}
      <p className="small muted" style={{ margin: 0 }}>{t('city.note')}</p>
      {/* Open-Meteo's data is CC BY 4.0: credited wherever it is used. */}
      <p className="tiny muted" style={{ margin: 0 }}>{t('city.credit')}</p>
      {failed && <p role="alert" className="small" style={{ margin: 0, color: 'var(--err)' }}>{t('city.failed')}</p>}
    </section>
  );
}
