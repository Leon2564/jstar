/**
 * Gifts (#77): the button in her chat and on the companion home, and the sheet he picks a gift in. The API decides
 * everything (points, the daily cap, how it lands with her); the sheet only shows the catalogue, what he has learned
 * she likes, and what a gift is: a digital item bought with points, never refunded or cashed out.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { GiftSendResT, GiftsResT } from '@jstar/shared/contracts';
import { FEATURED_GIFT_IDS, FEATURED_GIFTS, giftById, type GiftId } from '@jstar/shared/gifts';
import { localText } from '@jstar/shared/domain';
import { getStar, type StarId } from '../data/cast';
import { dotSep, starFirst, type Lang } from '../i18n';
import { CONFIG } from '../lib/config';
import { useStore, useT } from '../lib/store';
import { errorCode } from '../services/api';
import { gifts, sendGift } from '../services/gifts';
import { Icon } from './ui';
import { ChargeModal } from './chargeModal';
import './gift.css';

export const giftName = (id: string, lang: Lang): string => localText(giftById(id)?.name, lang);

/** Why the sheet cannot send now, as a dictionary key; null when it can. */
export function giftBlock(list: Pick<GiftsResT, 'sentToday' | 'perDay'> | null, points: number, price: number | null): 'gift.limit' | 'gift.noPoints' | 'gift.pick' | null {
  if (list && list.sentToday >= list.perDay) return 'gift.limit';
  if (price === null) return 'gift.pick';
  return points < price ? 'gift.noPoints' : null;
}

/** A gift's picture (#77), or its emoji when the picture cannot load. */
function GiftIcon({ gift }: { gift: { image: string; icon: string } }) {
  const [ok, setOk] = useState(true);
  return ok
    ? <img className="gift-img" src={gift.image} alt="" width={40} height={40} loading="lazy" decoding="async" draggable={false} onError={() => setOk(false)} />
    : <span className="gift-icon" aria-hidden="true">{gift.icon}</span>;
}

/** 「プレゼント」: opens the sheet for the talent on screen. `onSent` gets the API's answer (her reaction included). */
export function GiftButton({ onSent, className, style }: { onSent: (r: GiftSendResT) => void; className?: string; style?: React.CSSProperties }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} style={style} data-testid="gift-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span aria-hidden="true">🎁</span>{className?.includes('icon-btn') ? <span className="sr-only">{t('gift.open')}</span> : t('gift.open')}
      </button>
      {open && <GiftSheet onClose={() => setOpen(false)} onSent={(r) => { setOpen(false); onSent(r); }} />}
    </>
  );
}

/**
 * `onPick` (#68, a gift inside her scene): the sheet only picks — the scene step buys it, with the move — so it hands
 * the gift over instead of sending it. `star`: whose sheet it is (default: the talent on screen).
 */
export function GiftSheet({ onClose, onSent, onPick, star, call, localSession = false }: { onClose: () => void; onSent?: (r: GiftSendResT) => void; onPick?: (id: GiftId) => void; star?: StarId; call?: boolean; localSession?: boolean }) {
  const { state, actions } = useStore();
  const t = useT();
  const c = getStar(star ?? state.star);
  const first = starFirst(c, t.lang);
  const [list, setList] = useState<GiftsResT | null | undefined>(undefined);
  const [pick, setPick] = useState<GiftId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charge, setCharge] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void gifts(state, c.id, localSession).then((r) => { if (live) setList(r); });
    return () => { live = false; };
  }, [c.id, localSession]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const chosen = pick ? giftById(pick) ?? null : null;
  const known = (list?.gifts ?? []).filter((g) => g.known && FEATURED_GIFT_IDS.includes(g.id as typeof FEATURED_GIFT_IDS[number])).map((g) => g.id);
  const block = giftBlock(list ?? null, state.points, chosen?.price ?? null);
  const left = list ? Math.max(0, list.perDay - list.sentToday) : null;
  // M9: nothing he can afford (or he picked what he cannot): where points come from, with the ways there.
  const earn = block === 'gift.noPoints' || (!!list && FEATURED_GIFTS.every((g) => g.price > state.points));

  async function give() {
    if (!chosen || busy || block) return;
    if (onPick) { onPick(chosen.id); return; }
    setBusy(true);
    setError(null);
    try {
      const r = localSession
        ? await sendGift(state, c.id, chosen.id, t.lang, true)
        : await sendGift(state, c.id, chosen.id, t.lang);
      actions.applyGift(c.id, r);
      onSent?.(r);
    } catch (e) {
      const code = errorCode(e);
      if (code === 'insufficient_points') setCharge(true);
      setError(t(code === 'insufficient_points' ? 'gift.noPoints' : code === 'gift_limit' ? 'gift.limit' : 'common.error'));
    } finally {
      setBusy(false);
    }
  }

  // On document.body, above the tab bar, like the voice sheet (N-02).
  return <>
    {createPortal(<div role="dialog" aria-modal="true" aria-label={t('gift.title', { first })} className={`gift-backdrop${call ? ' call' : ''}`} data-testid="gift-sheet" onClick={onClose}>
      {/* One A2 sheet everywhere: the grid, her favourites marked, balance and 贈る below. `call` (her video call) keeps it
          to the night under her face (beside it on a wide screen). */}
      <div ref={panel} tabIndex={-1} className={`panel gift-sheet${call ? ' call' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 className="serif">{t('gift.title', { first })}</h2>
          <button type="button" className="round" onClick={onClose} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </div>
        {known.length > 0 && (
          <p className="small gift-known" data-testid="gift-known">
            <span aria-hidden="true">♥ </span>{t('gift.knownList', { first, list: known.map((id) => giftName(id, t.lang)).join('、') })}
          </p>
        )}
        {list === null && <p className="small" role="alert">{t('gift.loadFailed')}</p>}
        {earn && (
          <p className="gift-earn" role="note" data-testid="gift-earn">
            {t('gacha.noPoints', { daily: CONFIG.dailyLoginPoints })}{' '}
            <button type="button" onClick={() => setCharge(true)}>{t('gacha.earnHow')}</button>{dotSep(t.lang)}<Link to="/serial">{t('me.serial')}</Link>
          </p>
        )}
        <div className="gift-grid" role="group" aria-label={t('gift.pick')}>
          {FEATURED_GIFTS.map((g) => {
            const liked = known.includes(g.id);
            const lack = g.price > state.points ? t('gift.short', { n: g.price - state.points }) : '';
            return (
              <button key={g.id} type="button" className={`gift-tile${lack ? ' short' : ''}`} aria-pressed={pick === g.id} data-testid={`gift-${g.id}`} disabled={!list}
                aria-label={`${localText(g.name, t.lang)} ${t('common.pt', { n: g.price })}${lack && ` ${lack}`}${liked ? `（${t('gift.known')}）` : ''}`}
                onClick={() => { setPick(g.id); setError(null); if (g.price > state.points) setCharge(true); }}>
                <GiftIcon gift={g} />
                <span className="gift-name">{localText(g.name, t.lang)}</span>
                <span className="gift-price">{t('common.pt', { n: g.price })}</span>
                {lack && <span>{lack}</span>}
                {liked && <span className="gift-heart" aria-hidden="true">♥ {t('gift.known')}</span>}
              </button>
            );
          })}
        </div>
        <p className="tiny muted gift-note">{t('gift.taste', { first })}<br />{t('gift.note')}</p>
        {error && <p className="small gift-error" role="alert">{error}</p>}
        <div className="gift-foot">
          <button type="button" className="gift-balance" onClick={() => setCharge(true)}>
            <span data-testid="gift-points">{t('gift.points', { n: state.points.toLocaleString('ja-JP') })}</span>
            {left !== null && <span data-testid="gift-left">{t('gift.today', { n: left })}</span>}
            <span aria-hidden="true">›</span>
          </button>
          <button type="button" className="gift-give" data-testid="gift-send" disabled={!list || !!block || busy} onClick={() => void give()}>
            {block ? t(block) : t('gift.send', { price: chosen!.price })}
          </button>
        </div>
      </div>
    </div>, document.body)}
    <ChargeModal open={charge} onClose={() => setCharge(false)} />
  </>;
}
