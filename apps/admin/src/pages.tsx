import { useEffect, useState, type FormEvent } from 'react';
import { CALL_STAGES, ROUTINE_SLOTS, RULES, SEASONS, STAR_IDS, WORLD, formatSerial, weatherPoint, type CardDef } from '@jstar/shared';
import { api } from './api';

export function Cards() {
  const [cards, setCards] = useState<CardDef[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api<{ cards: CardDef[] }>('/v1/admin/cards').then((r) => setCards(r.cards)).catch((e: Error) => setMsg(e.message));
  useEffect(() => { void load(); }, []);

  async function save(card: CardDef) {
    setMsg(null);
    try {
      await api('/v1/admin/cards', { method: 'PUT', body: JSON.stringify(card) });
      setMsg(`saved ${card.id}`);
      await load();
    } catch (e) { setMsg((e as Error).message); }
  }
  return (
    <>
      <h2>Cards</h2>
      <p className="hint">Artwork and voice URLs stay empty until the asset team delivers them; the app shows a labelled slot in the meantime.</p>
      {msg && <p className={msg.startsWith('saved') ? 'ok' : 'err'}>{msg}</p>}
      <table>
        <thead><tr><th>ID</th><th>Talent</th><th>Rarity</th><th>Source</th><th>Art URL</th><th /></tr></thead>
        <tbody>{cards.map((c) => <CardRow key={c.id} card={c} onSave={save} />)}</tbody>
      </table>
    </>
  );
}

function CardRow({ card, onSave }: { card: CardDef; onSave: (c: CardDef) => void }) {
  const [artUrl, setArtUrl] = useState(card.art ?? '');
  return (
    <tr>
      <td><code>{card.id}</code></td>
      <td>{card.star} · {card.title.ja}</td>
      <td>{card.rarity}</td>
      <td>{card.source === 'photo' ? 'real photo' : 'AI'}</td>
      <td><input value={artUrl} placeholder="https://cdn…" onChange={(e) => setArtUrl(e.target.value)} /></td>
      <td><button className="ghost" onClick={() => onSave({ ...card, art: artUrl.trim() || null })}>Save</button></td>
    </tr>
  );
}

export function SerialBatches() {
  const [form, setForm] = useState<{ label: string; quantity: number; trialDays: number; draws: number }>({ label: '', quantity: 20, trialDays: RULES.serialDefaultTrialDays, draws: RULES.lucky.drawsPerCode });
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null); setCodes([]);
    try {
      const r = await api<{ codes: string[] }>('/v1/admin/serial-batches', { method: 'POST', body: JSON.stringify(form) });
      setCodes(r.codes);
    } catch (e) { setErr((e as Error).message); }
  }
  const download = () => {
    // Same columns as the printer's sheet from tools/luckcards, so both kinds of batch read alike.
    const csv = ['code,code_formatted', ...codes.map((c) => `${c},${formatSerial(c)}`)].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${form.label || 'batch'}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <h2>Serial batches</h2>
      <p className="hint">
        Small batches of lucky-card codes for events and partner samples. Each code gives its draws (the first SR or better) and pass days.
        Print runs are generated offline with <code>tools/luckcards</code> and imported into the database, not here.
      </p>
      <p className="err">Codes are stored hashed and shown exactly once. Download the CSV before leaving this page — it cannot be recovered.</p>
      <form className="card" onSubmit={submit}>
        <div className="row">
          <label>Label<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="print-run-2026-10" /></label>
          <label>Quantity<input type="number" min={1} max={10000} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} /></label>
          <label>Draws per code<input type="number" min={1} max={10} value={form.draws} onChange={(e) => setForm({ ...form, draws: Number(e.target.value) })} /></label>
          <label>Pass days<input type="number" min={0} max={90} value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: Number(e.target.value) })} /></label>
        </div>
        <button className="primary" type="submit">Generate</button>
      </form>
      {err && <p className="err">{err}</p>}
      {codes.length > 0 && (
        <div className="card">
          <p className="ok">{codes.length} codes generated. <button className="ghost" onClick={download}>Download CSV</button></p>
          <p className="hint">First five: {codes.slice(0, 5).map((c) => <code key={c} style={{ marginRight: 8 }}>{formatSerial(c)}</code>)}</p>
        </div>
      )}
    </>
  );
}

interface UserView {
  user: { id: string; email: string | null; nickname: string; via: string; createdAt: string; banned: boolean; points: number; freePulls: number; pity: number; shards: number; passUntil: string | null; birthdayConfirmed: boolean };
  owned: { cardId: string; copies: number; viaSerial: boolean }[];
  codes: { serialId: string; drawId: string; cards: string[]; createdAt: string }[];
  draws: { id: string; pool: string; cost: number; cards: string[]; createdAt: string }[];
}
interface SerialView { id: string; batchId: string; status: 'unused' | 'redeemed' | 'void'; redeemedAt: string | null; redeemedByUserId: string | null; pendingOnDevice: boolean }

/** Customer support: find an account and compensate it; look up a code and void a lost or leaked one. */
export function Support() {
  const [q, setQ] = useState('');
  const [view, setView] = useState<UserView | null>(null);
  const [grant, setGrant] = useState({ points: 0, freePulls: 0, reason: '' });
  const [code, setCode] = useState('');
  const [serial, setSerial] = useState<SerialView | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const findUser = async (e?: FormEvent) => {
    e?.preventDefault(); setMsg(null);
    const key = q.trim();
    try { setView(await api<UserView>(`/v1/admin/users?${key.includes('@') ? 'email' : 'id'}=${encodeURIComponent(key)}`)); } catch (x) { setView(null); setMsg((x as Error).message); }
  };
  const doGrant = async () => {
    if (!view) return;
    try {
      await api(`/v1/admin/users/${view.user.id}/grant`, { method: 'POST', body: JSON.stringify(grant) });
      setMsg(`saved: granted ${grant.points} Star Stones / ${grant.freePulls} pulls`); setGrant({ points: 0, freePulls: 0, reason: '' });
      await findUser();
    } catch (x) { setMsg((x as Error).message); }
  };
  const findCode = async (e?: FormEvent) => {
    e?.preventDefault(); setMsg(null);
    const key = code.trim();
    const byCode = /^[\d\s-]{12,16}$/.test(key);
    try { setSerial(await api<SerialView>(`/v1/admin/serials?${byCode ? 'code' : 'id'}=${encodeURIComponent(key)}`)); } catch (x) { setSerial(null); setMsg((x as Error).message); }
  };
  const doVoid = async () => {
    if (!serial || !confirm(`Void ${serial.id}? This cannot be undone.`)) return;
    try { await api(`/v1/admin/serials/${encodeURIComponent(serial.id)}/void`, { method: 'POST', body: JSON.stringify({ reason: voidReason }) }); setMsg(`saved: voided ${serial.id}`); setVoidReason(''); await findCode(); } catch (x) { setMsg((x as Error).message); }
  };

  return (
    <>
      <h2>Support</h2>
      <p className="hint">Every grant and void is written to the audit log with your account and the reason.</p>
      {msg && <p className={msg.startsWith('saved') ? 'ok' : 'err'}>{msg}</p>}
      <div className="card">
        <form className="row" onSubmit={(e) => void findUser(e)}><input placeholder="email or user id" value={q} onChange={(e) => setQ(e.target.value)} /><button className="primary">Find user</button></form>
        {view && (
          <>
            <p><code>{view.user.id}</code> · {view.user.email ?? '—'} · {view.user.nickname} · {view.user.via} · joined {new Date(view.user.createdAt).toLocaleDateString()}{view.user.banned ? ' · CLOSED' : ''}{view.user.birthdayConfirmed ? '' : ' · birthday not confirmed'}</p>
            <p>{view.user.points} Star Stones · {view.user.freePulls} free pulls · pity {view.user.pity} · {view.user.shards} shards · pass {view.user.passUntil ? new Date(view.user.passUntil).toLocaleDateString() : '—'} · {view.owned.length} cards</p>
            <div className="row">
              <label>Star Stones<input type="number" min="0" value={grant.points} onChange={(e) => setGrant({ ...grant, points: Number(e.target.value) })} /></label>
              <label>Free pulls<input type="number" min="0" max="100" value={grant.freePulls} onChange={(e) => setGrant({ ...grant, freePulls: Number(e.target.value) })} /></label>
              <label>Reason<input value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} placeholder="e.g. outage 9/25" /></label>
              <button className="primary" disabled={grant.reason.trim().length < 2 || (!grant.points && !grant.freePulls)} onClick={() => void doGrant()}>Grant</button>
            </div>
            <h3>Codes redeemed</h3>
            <table><thead><tr><th>When</th><th>Serial</th><th>Cards</th></tr></thead>
              <tbody>{view.codes.map((c) => <tr key={c.drawId}><td>{new Date(c.createdAt).toLocaleString()}</td><td><code>{c.serialId}</code></td><td>{c.cards.join(', ')}</td></tr>)}</tbody></table>
            <h3>Latest draws</h3>
            <table><thead><tr><th>When</th><th>Pool</th><th>Cost</th><th>Cards</th></tr></thead>
              <tbody>{view.draws.map((d) => <tr key={d.id}><td>{new Date(d.createdAt).toLocaleString()}</td><td>{d.pool}</td><td>{d.cost}</td><td>{d.cards.join(', ')}</td></tr>)}</tbody></table>
          </>
        )}
      </div>
      <div className="card">
        <form className="row" onSubmit={(e) => void findCode(e)}><input placeholder="12-digit code or serial number (2026A-00001)" value={code} onChange={(e) => setCode(e.target.value)} /><button className="primary">Look up code</button></form>
        {serial && (
          <>
            <p><code>{serial.id}</code> · batch <code>{serial.batchId}</code> · <strong>{serial.status}</strong>{serial.redeemedAt ? ` · ${new Date(serial.redeemedAt).toLocaleString()}` : ''}{serial.redeemedByUserId ? ` · user ${serial.redeemedByUserId}` : ''}{serial.pendingOnDevice ? ' · waiting on a visitor device' : ''}</p>
            {serial.status === 'unused' && (
              <div className="row">
                <label>Reason<input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="lost / leaked / misprint" /></label>
                <button className="ghost" disabled={voidReason.trim().length < 2} onClick={() => void doVoid()}>Void code</button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

interface BlockedEntry { id: string; actorId: string; meta: { star?: string; reason?: string; excerpt?: string }; createdAt: string }

/** Moderation queue: hard-blocked chat messages (80-character excerpts). Look up the account under Support. */
export function Moderation() {
  const [entries, setEntries] = useState<BlockedEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api<{ entries: BlockedEntry[] }>('/v1/admin/moderation').then((r) => setEntries(r.entries)).catch((e: Error) => setErr(e.message)); }, []);
  return (
    <>
      <h2>Moderation</h2>
      <p className="hint">Messages the safety layer refused. Visitors show as device:…; accounts can be looked up under Support by id.</p>
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Talent</th><th>Reason</th><th>Excerpt</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td>{new Date(e.createdAt).toLocaleString()}</td><td><code>{e.actorId}</code></td><td>{e.meta.star}</td><td>{e.meta.reason}</td><td>{e.meta.excerpt}</td></tr>)}</tbody>
      </table>
    </>
  );
}

interface AuditEntry { id: string; actorId: string; action: string; target: string; createdAt: string }

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  useEffect(() => { void api<{ entries: AuditEntry[] }>('/v1/admin/audit').then((r) => setEntries(r.entries.slice().reverse())); }, []);
  return (
    <>
      <h2>Audit log</h2>
      <p className="hint">Every content, serial, grant and void is recorded with the admin who made it.</p>
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td>{new Date(e.createdAt).toLocaleString()}</td><td><code>{e.actorId}</code></td><td>{e.action}</td><td><code>{e.target}</code></td></tr>)}</tbody>
      </table>
    </>
  );
}

const fieldState = (confirmed: boolean) => (confirmed
  ? <span className="ok">Confirmed — shown in the app</span>
  : <span className="err">Not confirmed — hidden everywhere</span>);

/**
 * Talent world config (packages/shared/src/world.ts) as this build ships it. Read-only on purpose:
 * an agency sign-off is a reviewed PR that flips `confirmed`, so every change keeps a history.
 */
export function World() {
  return (
    <>
      <h2>Talent world</h2>
      <p className="hint">
        Birthday and hometown reach the site and the AI only once confirmed; until then her weather uses Tokyo. To change or confirm a
        value, edit <code>packages/shared/src/world.ts</code> in a PR and run <code>npm run world:agent -w @jstar/shared</code>.
      </p>
      {STAR_IDS.map((id) => {
        const w = WORLD[id];
        const h = w.hometown.value;
        return (
          <div className="card" key={id}>
            <h3 style={{ marginTop: 0 }}>{id}</h3>
            <table>
              <thead><tr><th>Field</th><th>Value</th><th>State</th><th>Note</th></tr></thead>
              <tbody>
                <tr><td>Birthday</td><td>{w.birthday.value}</td><td>{fieldState(w.birthday.confirmed)}</td><td>{w.birthday.note}</td></tr>
                <tr>
                  <td>Hometown</td>
                  <td>{h.city.ja} / {h.city['zh-Hant']} / {h.city.en} · {h.prefecture.ja} · {h.lat}, {h.lon}</td>
                  <td>{fieldState(w.hometown.confirmed)}</td><td>{w.hometown.note}</td>
                </tr>
                <tr><td>Weather city</td><td>{weatherPoint(id).city.en}</td><td className="hint">follows the hometown</td><td /></tr>
                <tr><td>Signature scene</td><td>{w.signatureScene.title.ja} <code>{w.signatureScene.id}</code></td><td className="hint">character design</td><td /></tr>
                <tr><td>Call names</td><td>{CALL_STAGES.map((s) => `${s}: ${w.callNames[s]}`).join(' · ')}</td><td className="hint">draft (#56)</td><td /></tr>
                {ROUTINE_SLOTS.map((slot) => (
                  <tr key={slot}>
                    <td>Routine · {slot}</td>
                    <td>{w.routine[slot].status.ja} / {w.routine[slot].status['zh-Hant']} / {w.routine[slot].status.en}</td>
                    <td className="hint">{w.routine[slot].presence}</td><td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Seasons</h3>
        <table>
          <thead><tr><th>Event</th><th>Window (MM-DD, JST)</th></tr></thead>
          <tbody>
            {SEASONS.map((s) => (
              <tr key={s.id}>
                <td>{s.name.ja} · {s.name.en}</td>
                <td>{'from' in s.window ? `${s.window.from} – ${s.window.to}` : Object.entries(s.window).map(([city, win]) => `${city} ${win.from}–${win.to}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
