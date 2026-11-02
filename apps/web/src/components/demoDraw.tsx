/**
 * "Try a draw" on the home page: one real card from the catalog, turned with the real reveal (omen, SSR/UR
 * moment, tier frame). Client-only and labelled as a demo: nothing is saved and no server is called.
 * Odds are those of the first card of a lucky code (SR or better), the published rates.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { floorRates, pickCard, rollTier } from '@jstar/shared/gacha';
import { CARDS } from '../data/cards';
import { getStar } from '../data/cast';
import { starName } from '../i18n';
import { useStore, useT } from '../lib/store';
import { tierOf, titleOf } from './cardArt';
import { RevealCard, Sparks, SpecialReveal, useReveal, type RevealItem } from './reveal';

function Round({ onAgain }: { onAgain: () => void }) {
  const { state } = useStore();
  const t = useT();
  const [items] = useState<RevealItem[]>(() => [{ card: pickCard(rollTier(Math.random, floorRates('SR')), Math.random, CARDS), isNew: true }]);
  const rv = useReveal(items);
  const card = items[0].card;
  return (
    <div className="demo" data-testid="demo">
      <span className="demo-tag demo-tag-lg">{t('home.demoTag')}</span>
      <div className="demo-card">
        <RevealCard k={0} item={items[0]} face={rv.face[0]} omen={rv.omen[0]} onTap={() => rv.tap(0)} label={t('res.flip', { n: 1 })} dup={null} />
      </div>
      <div className={`demo-result${rv.open ? ' is-open' : ''}`} aria-live="polite">
        {rv.open
          ? <><span className={`badge r-${tierOf(card)}`}>{tierOf(card)}</span><strong>{titleOf(card, t.lang)}</strong><small>{starName(getStar(card.star), t.lang)}</small></>
          : <p className="tiny demo-note">{t('res.tap')}</p>}
      </div>
      {rv.open && (
        <div className="demo-ctas fade-in">
          <button type="button" className="btn btn-line" onClick={onAgain}>{t('home.demoAgain')}</button>
          {state.user
            ? <Link to="/gacha" className="btn btn-rose magnetic">{t('home.demoReal')}</Link>
            : <Link to="/signup?next=/gacha" className="btn btn-rose magnetic">{t('home.demoJoin')}</Link>}
        </div>
      )}
      <Sparks />
      {rv.special != null && <SpecialReveal card={items[0].card} onClose={rv.closeSpecial} />}
    </div>
  );
}

export default function DemoDraw() {
  const [n, setN] = useState(0);
  return <Round key={n} onAgain={() => setN((x) => x + 1)} />;
}
