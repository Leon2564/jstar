import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { CONFIG } from '../lib/config';
import { useStore, useT } from '../lib/store';
import { buyPoints } from '../services/api';
import { Icon } from './ui';
import '../styles/charge.css';

type ChargeModalProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Shared chat-credit top-up sheet. The commercial pack lives in shared/rules.ts.
 */
export function ChargeModal({ open, onClose }: ChargeModalProps) {
  const { state, actions } = useStore();
  const t = useT();
  const packs = CONFIG.pointPacks;
  const initial = packs[0]?.points ?? 0;
  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pack = useMemo(() => packs.find((item) => item.points === selected) ?? packs[0], [packs, selected]);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    const id = window.setTimeout(() => panel.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(id); window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  async function confirm() {
    if (!pack || busy || !state.user) return;
    setBusy(true);
    setNotice(null);
    try {
      actions.setPoints(await buyPoints(state, pack.points));
      setNotice(t('shop.done', { n: pack.points.toLocaleString() }));
    } catch {
      setNotice(t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (!open || !pack) return null;
  return createPortal(
    <div className="charge-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={panel} className="charge-sheet" role="dialog" aria-modal="true" aria-labelledby="charge-title" tabIndex={-1} data-testid="charge-modal">
        <button type="button" className="charge-close" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" size={18} />
        </button>

        <header className="charge-head">
          <span className="charge-kicker">JSTAR CREDITS</span>
          <h2 id="charge-title" className="serif">{t('shop.heading')}</h2>
          <p>{t('shop.body')}</p>
        </header>

        <div className="charge-balance">
          <span>{t('shop.balance')}</span>
          <strong className="serif" data-testid="shop-points">{t('common.pt', { n: state.points.toLocaleString() })}</strong>
        </div>

        <div className="charge-packs" role="radiogroup" aria-label={t('shop.choose')}>
          {packs.map((item) => {
            const active = item.points === pack.points;
            return (
              <button key={item.points} type="button" role="radio" aria-checked={active}
                className={`charge-pack${active ? ' is-selected' : ''}`}
                onClick={() => { setSelected(item.points); setNotice(null); }}>
                <span className="charge-popular">{t('shop.popular')}</span>
                <span className="charge-gem" aria-hidden="true"><Icon name="spark" size={16} /></span>
                <strong className="serif">{t('common.pt', { n: item.points.toLocaleString() })}</strong>
                <span>${item.usd.toFixed(2)}</span>
              </button>
            );
          })}
        </div>

        <p className="charge-use"><Icon name="spark" size={13} />{t('shop.use')}</p>

        {state.user
          ? <button type="button" className="btn btn-rose charge-submit" onClick={() => void confirm()} disabled={busy}>
              {busy ? t('shop.processing') : t('shop.buyPack', { stones: pack.points.toLocaleString(), price: pack.usd.toFixed(2) })}
            </button>
          : <Link className="btn btn-rose charge-submit" to="/signup?next=/me/shop" onClick={onClose}>{t('shop.signup')}</Link>}

        <div className="charge-foot" aria-live="polite">
          {notice ? <span className={notice === t('common.error') ? 'err' : 'ok'}>{notice}</span> : <span>{t('shop.demo')}</span>}
          <span>{t('shop.expiry', { days: CONFIG.pointExpiryDays })}</span>
        </div>
      </section>
    </div>,
    document.body
  );
}
