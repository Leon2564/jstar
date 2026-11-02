import { useEffect, useState, type FormEvent } from 'react';
import { CATALOG_BY_ID } from '@jstar/shared/catalog';
import { PICKUP_RULES, VARIANT_CARDS, type AdminPickupsResT, type PickupRatesT } from '@jstar/shared';
import { api } from './api';

const pct = (x: number) => `${(Math.round(x * 100000) / 1000).toString()}%`;
/** `datetime-local` values are read and shown as Japan time: the business calendar every Pickup is announced in. */
const toIso = (local: string) => new Date(`${local}:00+09:00`).toISOString();
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
const now = () => Date.now();

/**
 * Pickups (#78): schedule a variant card's Pickup, or move its end. The ratio comes from PICKUP_RULES (待确认, #84)
 * and is fixed when the Pickup is created; its odds are published on 提供割合 the moment it is saved, so a change of
 * odds is announced before it starts (docs/compliance-jp.md §3). Every save is in the audit log.
 */
export function Pickups() {
  const [list, setList] = useState<PickupRatesT[]>([]);
  const [form, setForm] = useState({ cardId: VARIANT_CARDS[VARIANT_CARDS.length - 1] ?? '', startsAt: '', endsAt: '' });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const load = () => api<AdminPickupsResT>('/v1/admin/pickups').then((r) => setList(r.pickups)).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);

  async function save(body: { cardId: string; startsAt: string; endsAt: string }) {
    setErr(null); setOk(null);
    try {
      const r = await api<{ pickup: PickupRatesT }>('/v1/admin/pickups', { method: 'PUT', body: JSON.stringify(body) });
      setOk(`Saved ${r.pickup.id}`);
      await load();
    } catch (e) { setErr((e as Error).message); }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.startsAt || !form.endsAt) { setErr('bad_window'); return; }
    void save({ cardId: form.cardId, startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt) });
  }
  return (
    <>
      <h2>Pickups</h2>
      <p className="hint">
        A Pickup is one talent’s pool for an announced window, with her variant card at {pct(PICKUP_RULES.share)} of SSR-or-better draws
        (PICKUP_RULES.share, 待确认). The total SSR-or-better rate, the pity and every other pool stay the same. At most {PICKUP_RULES.maxDays} days;
        once started, only the end can move. Times are Japan time.
      </p>
      <form className="card" onSubmit={submit}>
        <div className="row">
          <label>Variant card
            <select value={form.cardId} onChange={(e) => setForm({ ...form, cardId: e.target.value })}>
              {VARIANT_CARDS.map((id) => <option key={id} value={id}>{CATALOG_BY_ID[id]?.star} · {CATALOG_BY_ID[id]?.title.ja} ({id})</option>)}
            </select>
          </label>
          <label>Starts (JST)<input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></label>
          <label>Ends (JST, exclusive)<input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></label>
        </div>
        <button className="primary" type="submit">Schedule</button>
      </form>
      {err && <p className="err">{err}</p>}
      {ok && <p className="ok">{ok}</p>}
      <table>
        <thead><tr><th>Pickup</th><th>Window (JST)</th><th>Card rate</th><th>State</th><th /></tr></thead>
        <tbody>
          {list.slice().reverse().map((p) => {
            const ended = Date.parse(p.endsAt) <= now();
            return (
              <tr key={p.id}>
                <td><code>{p.id}</code><br />{CATALOG_BY_ID[p.cardId]?.title.ja}</td>
                <td>{jst(p.startsAt)} – {jst(p.endsAt)}</td>
                <td>{pct(p.pickup.rate)} (usually {pct(p.pickup.baseRate)}) · share {pct(p.pickup.share)}</td>
                <td>{p.live ? <span className="ok">live</span> : ended ? 'ended' : 'scheduled'}</td>
                <td>{!ended && <button className="ghost" type="button" onClick={() => void save({ cardId: p.cardId, startsAt: p.startsAt, endsAt: new Date(Math.max(now(), Date.parse(p.startsAt) + 60_000)).toISOString() })}>End now</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
