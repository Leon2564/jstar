import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { CardDef } from '../data/cards';
import { CARD_BY_ID } from '../data/cards';
import { useStore, useT } from '../lib/store';
import { SiteHeader } from '../components/ui';
import { CardShowcase } from '../components/cardShowcase';
import { RevealCard, Sparks, SpecialReveal, useReveal, type RevealItem } from '../components/reveal';
import { tierOf, titleOf } from '../components/cardArt';
import { getStar } from '../data/cast';
import { starName } from '../i18n';
import '../styles/publicGacha.css';

function RedeemedCards({ items }: { items: RevealItem[] }) {
  const { state, actions } = useStore();
  const t = useT();
  const reveal = useReveal(items, !!state.lastRedeem?.seen);
  const [showcase, setShowcase] = useState<CardDef | null>(null);
  useEffect(() => { if (reveal.open && !state.lastRedeem?.seen) actions.redeemSeen(); }, [actions, reveal.open, state.lastRedeem?.seen]);
  return <div className="pg-result pg-result-6 is-dealt">
    <div className="rv-grid pg-six">
      {items.map((item, index) => <div key={`${item.card.id}-${index}`} className={`pg-result-card${reveal.face[index] ? ' is-open' : ''}`} data-testid="gacha-result-card">
        <RevealCard k={index} item={item} face={reveal.face[index]} omen={reveal.omen[index]} onTap={() => reveal.tap(index)} label={t('res.flip', { n: index + 1 })} dup={<span className="rv-dup">{t('res.added')}</span>}>
          {reveal.face[index] && <button type="button" className="pg-card-meta" onClick={() => setShowcase(item.card)}>
            <b>{tierOf(item.card)}</b><span>{starName(getStar(item.card.star), t.lang)} · {titleOf(item.card, t.lang)}</span>
          </button>}
        </RevealCard>
      </div>)}
    </div>
    {reveal.open && <Link className="pg-primary pg-result-link" to={state.user ? '/gacha' : '/signup?next=/me/cards'}>{state.user ? t('pg.again') : t('res.save')}</Link>}
    {reveal.special != null && <SpecialReveal card={items[reveal.special].card} onClose={reveal.closeSpecial} />}
    {showcase && <CardShowcase card={showcase} onClose={() => setShowcase(null)} />}
  </div>;
}

export function SerialGachaResult() {
  const { state } = useStore();
  const t = useT();
  const items = useMemo<RevealItem[]>(() => (state.lastRedeem?.cards ?? []).flatMap((drawn) => {
    const card = CARD_BY_ID[drawn.id];
    return card ? [{ card, isNew: drawn.isNew }] : [];
  }), [state.lastRedeem]);
  if (!items.length) return <Navigate to="/gacha" replace />;
  return <main className="pg-page pg-redeem-result js-nightpage">
    <SiteHeader />
    <div className="pg-stars" aria-hidden="true" />
    <div className="pg-shell">
      <section className="pg-copy"><p className="pg-kicker">STAR GENESIS · FIRST FIVE</p><h1 data-testid="pg-title">{t('pg.title')}</h1><p className="pg-lede">{t('serial.gets', { n: items.length })}</p><p className="pg-redeem-note">+{t('common.pt', { n: 100 })}</p></section>
      <section className="pg-altar has-result"><div className="pg-halo" aria-hidden="true" /><RedeemedCards items={items} /></section>
    </div>
    <Sparks />
  </main>;
}
