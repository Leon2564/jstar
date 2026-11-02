import { StrictMode, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, getToken, setToken } from './api';
import { Audit, Cards, Moderation, SerialBatches, Support, World } from './pages';
import { Metrics } from './metrics';
import { Pickups } from './pickups';
import './styles.css';

const TABS = [
  ['metrics', '指標 Metrics', Metrics],
  ['cards', 'Cards', Cards],
  ['pickups', 'Pickups', Pickups],
  ['serials', 'Serial batches', SerialBatches],
  ['support', 'Support', Support],
  ['moderation', 'Moderation', Moderation],
  ['world', 'Talent world', World],
  ['audit', 'Audit log', Audit]
] as const;

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try { await api('/v1/auth/otp/start', { method: 'POST', body: JSON.stringify({ email }) }); setSent(true); }
    catch (e) { setErr((e as Error).message); }
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api<{ token: string }>('/v1/auth/otp/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
      setToken(r.token);
      onDone();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <main style={{ maxWidth: 380, margin: '14vh auto' }}>
      <h2>JSTAR admin</h2>
      <p className="hint">Sign in with the one-time code sent to an account that has the admin role.</p>
      <form className="card" onSubmit={sent ? verify : start}>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {sent && <label style={{ display: 'block', marginTop: 12 }}>Code<input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>}
        {err && <p className="err">{err}</p>}
        <button className="primary" style={{ marginTop: 14 }} type="submit">{sent ? 'Sign in' : 'Send code'}</button>
      </form>
    </main>
  );
}

function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('cards');
  if (!authed) return <SignIn onDone={() => setAuthed(true)} />;
  const Current = TABS.find(([id]) => id === tab)![2];
  return (
    <div className="layout">
      <nav className="side">
        <h1>JSTAR</h1>
        {TABS.map(([id, label]) => (
          <button key={id} aria-current={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
        <button style={{ marginTop: 'auto' }} onClick={() => { setToken(null); setAuthed(false); }}>Sign out</button>
      </nav>
      <main><Current /></main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
