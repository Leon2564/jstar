import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { RULES } from '@jstar/shared/rules';
import type { CardDef } from '../data/cards';
import { CARDS, CARD_BY_ID, cardTitle } from '../data/cards';
import { useStore, useT } from '../lib/store';
import { SiteHeader } from '../components/ui';
import { CardShowcase } from '../components/cardShowcase';
import { ShardExchange } from '../components/shardExchange';
import { RevealCard, Sparks, SpecialReveal, useReveal, type RevealItem } from '../components/reveal';
import { bestCard, tierOf, titleOf } from '../components/cardArt';
import { CAST, getStar } from '../data/cast';
import { starFirst, starName } from '../i18n';
import { drawCards, errorCode } from '../services/api';
import { usePickups } from '../lib/pickups';
import { heroEntry } from '../data/heroMedia';
import '../styles/publicGacha.css';

type Mode = 1 | 6;

const OFFSETS: Record<CardDef['star'], number> = { mahiro: 0, nana: 30, unpai: 60, alice: 90, eimi: 120 };
const serialOf = (card: CardDef) => {
  const local = Number(/-(\d+)$/.exec(card.id)?.[1] ?? 0);
  return `S1 · ${String(OFFSETS[card.star] + local).padStart(3, '0')}`;
};
function Result({ items, mode, onAgain, onShow, initialOpen = false, onOpened, actionLabel, openAction }: {
  items: RevealItem[];
  mode: Mode;
  onAgain: () => void;
  onShow: (card: CardDef) => void;
  initialOpen?: boolean;
  onOpened?: () => void;
  actionLabel?: string;
  openAction?: ReactNode;
}) {
  const t = useT();
  const rv = useReveal(items, initialOpen);
  const [dealt, setDealt] = useState(initialOpen);
  useEffect(() => {
    if (initialOpen) return;
    const timer = window.setTimeout(() => setDealt(true), mode === 1 ? 720 : 1180);
    return () => window.clearTimeout(timer);
  }, [initialOpen, mode]);
  useEffect(() => { if (rv.open) onOpened?.(); }, [onOpened, rv.open]);
  return (
    <section className={`pg-result pg-result-${mode} ${dealt ? 'is-dealt' : 'is-dealing'}`} aria-live="polite">
      <div className={`rv-grid ${mode === 1 ? 'rv-single' : 'pg-six'}`}>
        {items.map((item, k) => (
          <div
            key={`${item.card.id}-${k}`}
            className={`pg-result-card${rv.face[k] ? ' is-open' : ''}`}
            data-testid="gacha-result-card"
            style={{ '--deal-index': k } as React.CSSProperties}
            role={rv.face[k] ? 'button' : undefined}
            tabIndex={rv.face[k] ? 0 : undefined}
            aria-label={rv.face[k] ? `${tierOf(item.card)} · ${serialOf(item.card)} · ${t('gallery.showcase')}` : undefined}
            onClick={() => { if (rv.face[k]) onShow(item.card); }}
            onKeyDown={(event) => {
              if (rv.face[k] && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onShow(item.card);
              }
            }}
          >
            <RevealCard k={k} item={item} face={rv.face[k]} omen={rv.omen[k]} onTap={() => rv.tap(k)} interactive={dealt} label={t('res.flip', { n: k + 1 })}
              dup={<span className="rv-dup">{t('gr.dupShards', { n: RULES.duplicateShards[tierOf(item.card)] })}</span>}>
              {rv.face[k] && <div className="pg-card-meta"><b>{tierOf(item.card)} · {serialOf(item.card)}</b><span>{starName(getStar(item.card.star), t.lang)} · {titleOf(item.card, t.lang)}</span></div>}
            </RevealCard>
          </div>
        ))}
      </div>
      <div className="pg-result-actions">
        {rv.open && (openAction ?? <button type="button" className="pg-primary" onClick={onAgain}>{actionLabel ?? t('pg.again')}</button>)}
      </div>
      {rv.special != null && <SpecialReveal card={items[rv.special].card} onClose={rv.closeSpecial} />}
    </section>
  );
}

export function PublicGacha({ redeemResult = false }: { redeemResult?: boolean } = {}) {
  const { state, actions } = useStore();
  const t = useT();
  const redeemedItems = useMemo<RevealItem[]>(() => (state.lastRedeem?.cards ?? []).flatMap((drawn) => {
    const card = CARD_BY_ID[drawn.id];
    return card ? [{ card, isNew: drawn.isNew }] : [];
  }), [state.lastRedeem]);
  const [mode, setMode] = useState<Mode>(() => redeemResult ? 6 : 1);
  const [items, setItems] = useState<RevealItem[] | null>(() => redeemResult ? redeemedItems : null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showcase, setShowcase] = useState<CardDef | null>(null);
  const [exchange, setExchange] = useState(false);
  const [poolFx, setPoolFx] = useState(0);
  const redeemedBest = redeemedItems.length ? bestCard(redeemedItems.map((item) => item.card)) : null;
  const published = usePickups(CARDS);
  const pickups = (published ?? []).filter((pickup) => pickup.live && CARD_BY_ID[pickup.cardId]);
  const pool = state.gachaPool;
  const activePickup = pickups.find((pickup) => pickup.id === pool);
  const poolStarId = pool.startsWith('star:') ? pool.slice(5) : activePickup ? CARD_BY_ID[activePickup.cardId]?.star : undefined;
  const poolStar = CAST.find((star) => star.id === poolStarId);
  const poolPoster = poolStar ? heroEntry(poolStar.id, false)?.poster : undefined;
  useEffect(() => {
    if (published && pool.startsWith('pickup:') && !pickups.some((pickup) => pickup.id === pool)) actions.setGachaPool('all');
  }, [actions, pickups, pool, published]);
  const rates = useMemo(() => Object.entries(RULES.rates) as [keyof typeof RULES.rates, number][], []);
  const eligible = state.freePulls >= mode;

  async function draw() {
    if (busy) return;
    if (!eligible) {
      setNotice(t('gacha.noFree'));
      return;
    }
    setBusy(true); setNotice('');
    try {
      const result = await drawCards(state, mode, true, pool);
      actions.applyDraw(result);
      setItems(result.cards.flatMap((drawn) => {
        const card = CARD_BY_ID[drawn.id];
        return card ? [{ card, isNew: drawn.isNew }] : [];
      }));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'pool_closed') actions.setGachaPool('all');
      setNotice(t(code === 'no_free_pull' ? 'gacha.noFree' : code === 'draw_in_progress' ? 'gacha.busy' : code === 'pool_closed' ? 'gacha.pickupClosed' : 'common.error'));
    } finally { setBusy(false); }
  }

  function choose(next: Mode) {
    if (redeemResult) return;
    setMode(next);
    setItems(null);
    setNotice('');
  }

  function choosePool(next: string) {
    if (next === pool) return;
    actions.setGachaPool(next);
    setItems(null);
    setNotice('');
    setPoolFx((value) => value + 1);
  }

  if (redeemResult && (!state.lastRedeem || !items?.length)) return <Navigate to="/serial" replace />;

  const finishResult = () => {
    if (!redeemResult) { setItems(null); return; }
  };

  return (
    <main className={`pg-page js-nightpage${redeemResult ? ' pg-redeem-result' : ''}${poolPoster ? ' has-pool-art' : ''}`}>
      <SiteHeader extra={(
        <aside className="pg-assets" aria-label={t('gacha.assets')}>
          <span><i aria-hidden="true">✦</i><small>{t('gacha.freePull')}</small><b>{state.freePulls.toLocaleString()}</b></span>
          <button type="button" onClick={() => setExchange(true)}><i aria-hidden="true">◆</i><small>{t('gacha.starShards')}</small><b>{state.shards.toLocaleString()}</b></button>
        </aside>
      )} />
      <div className="pg-pool-scene" aria-hidden="true">
        {poolPoster && <img key={poolPoster} src={poolPoster} alt="" />}
      </div>
      <div className="pg-stars" aria-hidden="true" />
      <div className="pg-shell">
        <section className="pg-copy">
          <p className="pg-kicker">STAR GENESIS · FIRST FIVE</p>
          <h1 data-testid="pg-title">
            {t('pg.title').split('\n').map((line) => <span key={line}>{line}</span>)}
          </h1>
          <p className="pg-lede">{t('pg.body')}</p>
          {redeemResult && state.lastRedeem && redeemedBest && (
            <div className="pg-redeem-note">
              {state.lastRedeem.days > 0 && <p data-testid="lucky-bonus">{t('res.bonus', { first: starFirst(getStar(redeemedBest.star), t.lang), days: state.lastRedeem.days })}</p>}
              <p>{t(state.user ? 'res.added' : 'res.keep')}</p>
            </div>
          )}
          {!redeemResult && <div className="pg-modes" role="group" aria-label={t('pg.mode')}>
            <button type="button" aria-pressed={mode === 1} onClick={() => choose(1)}><span>01</span><b>{t('pg.single')}</b><small>{t('pg.singleNote')}</small></button>
            <button type="button" aria-pressed={mode === 6} onClick={() => choose(6)}><span>06</span><b>{t('pg.six')}</b><small>{t('pg.sixNote')}</small></button>
          </div>}
          {!redeemResult && <nav className="pg-pools" aria-label={t('gacha.pools')}>
            <span>{t('gacha.pools')}</span>
            <button type="button" aria-pressed={pool === 'all'} onClick={() => choosePool('all')}>{t('gacha.poolAll')}</button>
            {CAST.map((star) => {
              const id = `star:${star.id}`;
              return <button key={id} type="button" aria-pressed={pool === id} onClick={() => choosePool(id)}>{starName(star, t.lang)}</button>;
            })}
            {pickups.map((pickup) => <button key={pickup.id} type="button" aria-pressed={pool === pickup.id} onClick={() => choosePool(pickup.id)}>✦ {cardTitle(CARD_BY_ID[pickup.cardId], t.lang)}</button>)}
          </nav>}
          <div className="pg-rates" aria-label={t('pg.rates')}>
            {rates.map(([tier, rate]) => <span key={tier} className={`pg-rate-${tier}`}><b>{tier}</b>{(rate * 100).toFixed(tier === 'SSR' || tier === 'UR' ? 1 : 0)}%</span>)}
          </div>
          {!redeemResult && <p className="pg-pity">{t('pg.pity', { n: RULES.pityPulls - state.pity })}</p>}
          <div className="pg-links"><Link to="/legal/rates">{t('gacha.rates')}</Link>{!redeemResult && <Link to="/me/gacha/history">{t('gacha.history')}</Link>}</div>
          {!redeemResult && <p className="pg-wallet">{t('gacha.free', { n: state.freePulls })}</p>}
          {notice && <p className="pg-notice" role="alert">{notice}</p>}
        </section>

        <section className={`pg-altar${items ? ' has-result' : ''}`}>
          <div className="pg-halo" aria-hidden="true" />
          {items
            ? <Result
                key={`${mode}-${items.map((x) => x.card.id).join('-')}`}
                items={items}
                mode={mode}
                onAgain={finishResult}
                onShow={setShowcase}
                initialOpen={redeemResult && !!state.lastRedeem?.seen}
                onOpened={redeemResult ? actions.redeemSeen : undefined}
                actionLabel={redeemResult && !state.user ? t('res.save') : undefined}
                openAction={redeemResult ? <Link className="pg-primary pg-result-link" to={state.user ? '/gacha' : '/signup?next=/me/cards'}>{state.user ? t('pg.again') : t('res.save')}</Link> : undefined}
              />
            : <>
                <div className={`pg-deck pg-deck-${mode}${poolFx ? ` is-pool-refresh-${poolFx % 2 ? 'a' : 'b'}` : ''}`} data-testid="gacha-deck" aria-hidden="true">
                  {Array.from({ length: 6 }, (_, i) => (
                    <img
                      key={i}
                      src="/cards/jstar-genesis-back.webp"
                      alt=""
                      style={{
                        '--i': i,
                        '--fan-x': `${(i - 2.5) * 22}%`,
                        '--fan-y': `${Math.abs(i - 2.5) * 4}%`,
                        '--fan-r': `${(i - 2.5) * 4}deg`,
                        '--open-delay': `${i * 38}ms`,
                        '--close-delay': `${(5 - i) * 24}ms`,
                      } as React.CSSProperties}
                    />
                  ))}
                </div>
                <button type="button" className={`pg-primary pg-draw${eligible ? '' : ' is-locked'}`} onClick={() => void draw()} disabled={busy} aria-disabled={!eligible || undefined} aria-busy={busy || undefined}><span>{mode === 1 ? t('pg.single') : t('pg.six')}</span><small>{busy ? t('gacha.busy') : t('pg.draw')}</small></button>
              </>}
        </section>
      </div>
      <Sparks />
      {showcase && <CardShowcase card={showcase} onClose={() => setShowcase(null)} />}
      {exchange && <ShardExchange onClose={() => setExchange(false)} onDone={(message) => { setExchange(false); setNotice(message); }} />}
    </main>
  );
}

export function SerialGachaResult() {
  return <PublicGacha redeemResult />;
}
