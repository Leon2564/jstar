import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useNavigate } from 'react-router-dom';
import type { RedemptionHistoryResT } from '@jstar/shared/contracts';
import { BOND_RULES } from '@jstar/shared/rules';
import { cleanCallName } from '@jstar/shared/bond';
import { CARD_BY_ID, cardTitle } from '../data/cards';
import { getStar } from '../data/cast';
import { dotSep, fmtDate, quoted, starFirst } from '../i18n';
import { useStore, useT } from '../lib/store';
import { confirmBirthday, deleteAccount, errorCode, logout, redemptions, serverMode } from '../services/api';
import { http } from '../services/http';
import { Header, Toast, useToast } from '../components/ui';
import { RarityBadge } from '../components/cardTile';
import { drawSummary } from '../components/cardArt';
import { StarAvatar } from '../components/starAvatar';
import { media, stillOf } from '../components/stage';
import { MemoryExportButton } from '../components/memoryExport';
import { PushOffer } from '../components/pushOffer';
import '../system/system.css';
import '../styles/flows.css';
import '../styles/member.css';

/**
 * M7: the account's own screens before and after her room (the birthday check, his name, a closed or deleted account)
 * are A2 on the night like the log-in page they follow — her picture, the brand, the words under it — never a bare
 * light page. `top` leads back to the site (never a dead end); `right` is the header's other end (log out).
 */
function NightPage({ children, top = true, right, testId }: { children: ReactNode; top?: boolean; right?: ReactNode; testId?: string }) {
  const { state } = useStore();
  const art = stillOf(media(`${state.star}-hero-9x16`), true);
  return (
    <div className="page login dark" data-testid={testId}>
      {art && <img className="login-art" src={art} alt="" decoding="async" draggable={false} />}
      {/* Without a way back the brand still sits in the middle (flows.css draws it into the header's first span). */}
      {top ? <Header back="/" right={right} /> : <header className="hdr"><i style={{ width: 44 }} /><span /><i style={{ width: 44 }} /></header>}
      <div className="col login-col"><section className="login-form">{children}</section></div>
    </div>
  );
}

/** The header's 「ログアウト」 on the screens before her room: he can always leave instead (M7). */
function SignOutLink() {
  const { actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  return <button type="button" className="btn-text" style={{ padding: '0 12px' }} data-testid="gate-logout" onClick={() => { logout(); actions.logout(true); nav('/', { replace: true }); }}>{t('me.logout')}</button>;
}

/** M4: saves his nickname — the account's (server mode) or this browser's (prototype). Throws `invalid_name`. */
export async function saveNickname(raw: string, apply: { hydrate: (me: Awaited<ReturnType<typeof http.setNickname>>) => void; rename: (n: string) => void }): Promise<void> {
  const name = cleanCallName(raw);
  if (!name) throw new Error('invalid_name');
  if (serverMode()) apply.hydrate(await http.setNickname(name));
  else apply.rename(name);
}

/**
 * Member pages stay behind a one-time birthday check (18+). The age gate before sign-up is a self-declaration;
 * this is the record the API keeps. Offline prototype mode has no account to record it on, so it never asks.
 * M4: right after it, once, she asks what to call him (skippable; My page changes it later).
 */
export function BirthdayGate() {
  const { state, actions } = useStore();
  const t = useT();
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [askName, setAskName] = useState(false);
  if (closed) return <Closed />;
  if (askName) return <NameStep onDone={() => setAskName(false)} />;
  if (!serverMode() || state.birthdayOk || !state.user) return <><Outlet /><PushOffer /></>;
  const today = new Date();
  const max = `${today.getFullYear() - 18}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { setErr(t('acct.bdayInvalid')); return; }
    setBusy(true); setErr('');
    try {
      const me = await confirmBirthday(value);
      if (me) {
        if (!me.user.named) setAskName(true);
        actions.hydrateMe(me);
      }
    } catch (x) {
      const code = errorCode(x);
      if (code === 'underage') { logout(); setClosed(true); return; }
      setErr(code === 'invalid_birthday' ? t('acct.bdayInvalid') : t('acct.failed'));
    } finally { setBusy(false); }
  };
  return (
    <NightPage right={<SignOutLink />} testId="birthday-gate">
      <h1 className="h1" style={{ margin: 0 }}>{t('acct.bdayTitle')}</h1>
      <p className="login-note">{t('acct.bdayBody')}</p>
      <form className="stack" onSubmit={(e) => void onSubmit(e)} noValidate data-testid="birthday-form">
        <div className="field">
          <label htmlFor="birthday">{t('acct.bdayLabel')}</label>
          <input id="birthday" className="input" type="date" min="1900-01-01" max={max} value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!err} aria-describedby={err ? 'bday-err' : undefined} required style={{ colorScheme: 'dark' }} />
        </div>
        {err && <p id="bday-err" className="err" role="alert">{err}</p>}
        <button type="submit" className="btn btn-rose" disabled={busy || !value}>{t('acct.bdaySave')}</button>
      </form>
    </NightPage>
  );
}

/** M4: 「なんて呼べばいい？」 once, after the birthday: his nickname, which the five call him by unless he sets 「呼び方」. */
function NameStep({ onDone }: { onDone: () => void }) {
  const { actions } = useStore();
  const t = useT();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await saveNickname(draft, { hydrate: actions.hydrateMe, rename: actions.rename });
      onDone();
    } catch (x) {
      setErr((x as Error).message === 'invalid_name' || errorCode(x) === 'invalid_name' ? t('call.invalid', { n: BOND_RULES.nameMax }) : t('acct.failed'));
    } finally { setBusy(false); }
  };
  return (
    <NightPage top={false} testId="name-step">
      <p className="login-her">{quoted(t('acct.nameTitle'), t.lang)}</p>
      <p className="login-note">{t('acct.nameBody')}</p>
      <form className="stack" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="nickname">{t('me.name')}</label>
          <input id="nickname" className="input" autoComplete="nickname" maxLength={BOND_RULES.nameMax} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('call.placeholder')} aria-invalid={!!err} aria-describedby={err ? 'name-err' : undefined} autoFocus data-testid="name-input" />
        </div>
        {err && <p id="name-err" className="err" role="alert">{err}</p>}
        <button type="submit" className="btn btn-rose" disabled={busy || !draft.trim()} data-testid="name-save">{t('call.save')}</button>
        <button type="button" className="btn-text" onClick={onDone} data-testid="name-skip">{t('acct.nameSkip')}</button>
      </form>
    </NightPage>
  );
}

/** The account is already closed server-side; leaving this screen clears the browser too. */
function Closed() {
  const { actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  return (
    <NightPage top={false}>
      <p className="login-note" role="alert" data-testid="underage">{t('acct.underage')}</p>
      <button type="button" className="btn btn-ghost" onClick={() => { actions.resetAll(); nav('/age', { replace: true }); }}>{t('nf.cta')}</button>
    </NightPage>
  );
}

/** シリアルコード履歴: each redeemed code by its printed serial number, with the cards it drew. */
export function Redemptions() {
  const t = useT();
  const [rows, setRows] = useState<RedemptionHistoryResT['redemptions'] | null | undefined>(undefined);
  useEffect(() => { void redemptions().then((r) => setRows(r ? r.redemptions : null)).catch(() => setRows(null)); }, []);
  return (
    <div className="page member js-nightpage">
      <Header back={true} title={t('acct.redTitle')} />
      <div className="col pad" style={{ paddingBottom: 24 }}>
        <p className="tiny muted">{t('acct.redNote')}</p>
        {rows === undefined ? <p className="small muted">{t('common.loading')}</p>
          : !rows || !rows.length ? <p className="small muted" data-testid="redemptions-empty">{t('acct.redEmpty')}</p>
            : (
              <ol style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="redemptions">
                {rows.map((r) => (
                  <li key={r.drawId} style={{ padding: '10px 0', borderBottom: '1px solid var(--hair)' }}>
                    <div className="tiny muted">{fmtDate(r.createdAt, t.lang)}{dotSep(t.lang)}No. {r.serialId}</div>
                    <div className="small" data-testid="redemption-summary" style={{ marginTop: 4 }}>{drawSummary(r.cards.map((c) => c.rarity), t, t.lang)}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                      {/* L10: whose card each one is — her face and her name — as the gacha history shows its pool. */}
                      {r.cards.map((c, k) => {
                        const card = CARD_BY_ID[c.id];
                        return (
                          <span key={k} className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <RarityBadge r={c.rarity} />{card && <StarAvatar id={card.star} size={22} />}
                            {card ? `${starFirst(getStar(card.star), t.lang)}${quoted(cardTitle(card, t.lang), t.lang)}` : c.id}
                          </span>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ol>
            )}
      </div>
    </div>
  );
}

/** 退会: typed confirmation, then the API erases personal data and this browser forgets everything. */
export function DeleteAccount() {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [toast, setToast] = useToast();
  // The browser cache is cleared when this page is left, not before: clearing the user would unmount it
  // (RequireAuth) before the goodbye is shown.
  useEffect(() => { if (done) return () => actions.resetAll(); }, [done, actions]);
  if (done) {
    return (
      <NightPage top={false} testId="goodbye">
        <p className="login-note" role="status" data-testid="deleted">{t('acct.deleted')}</p>
        <button type="button" className="btn btn-ghost" onClick={() => nav('/', { replace: true })}>{t('nf.cta')}</button>
      </NightPage>
    );
  }
  if (!state.user) return <Navigate to="/" replace />;
  const onDelete = async () => {
    setBusy(true); setErr('');
    try {
      await deleteAccount();
      setDone(true);
    } catch { setErr(t('acct.failed')); } finally { setBusy(false); }
  };
  return (
    <div className="page member js-nightpage">
      <Header back={true} title={t('acct.delTitle')} />
      <div className="col pad stack" style={{ gap: 16, paddingBottom: 24 }}>
        <p className="small" style={{ margin: 0, lineHeight: 1.9 }}>{t('acct.delBody')}</p>
        {/* L12: his memories are his — the export is offered here, before they are erased. */}
        <div className="panel stack" style={{ gap: 0, padding: '14px 0 4px' }} data-testid="delete-export">
          <p className="small" style={{ margin: '0 24px' }}>{t('acct.delExport')}</p>
          <MemoryExportButton onNotice={setToast} />
          <Link to="/me/cards?tab=memory" className="small" style={{ margin: '0 24px', minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'underline' }}>{t('cards.memories')}</Link>
        </div>
        <div className="field">
          <label htmlFor="del-confirm">{t('acct.delType')}</label>
          <input id="del-confirm" className="input" autoComplete="off" autoCapitalize="characters" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
        {/* B-N2: on the night, erasing is this page's one main action: the rose block. */}
        <button type="button" className="js-btn-rose" disabled={busy || typed.trim() !== 'DELETE'} onClick={() => void onDelete()}>{t('acct.delConfirm')}</button>
      </div>
      <Toast msg={toast} />
    </div>
  );
}
