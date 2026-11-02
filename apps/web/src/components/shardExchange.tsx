import { useMemo, useState } from 'react';
import { RULES } from '@jstar/shared/rules';
import type { Rarity } from '@jstar/shared/domain';
import { CARDS, CARD_BY_ID, RARITY_ORDER, cardTitle } from '../data/cards';
import { useStore, useT } from '../lib/store';
import { errorCode, exchangeCard } from '../services/api';
import { CardTile } from './cardTile';
import { Icon } from './ui';
import '../styles/shardExchange.css';

const TIERS: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR'];

export function ShardExchange({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const { state, actions } = useStore();
  const t = useT();
  const [tier, setTier] = useState<Rarity>('SR');
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cards = useMemo(() => CARDS.filter((card) => card.rarity === tier).sort((a, b) => RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity]), [tier]);
  const selected = pick ? CARD_BY_ID[pick] : null;
  const cost = selected ? RULES.exchangeShards[selected.rarity] : RULES.exchangeShards[tier];
  const enough = state.shards >= cost;

  async function confirm() {
    if (!selected || busy || !enough) return;
    setBusy(true);
    try {
      const result = await exchangeCard(state, selected.id);
      actions.applyExchange(result);
      onDone(t('gacha.exchanged', { title: cardTitle(selected, t.lang) }));
    } catch (error) {
      onDone(t(errorCode(error) === 'insufficient_shards' ? 'gacha.noShards' : 'common.error'));
    } finally { setBusy(false); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={t('gacha.exchange')} className="shard-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="shard-sheet">
        <header className="shard-head">
          <div><span>STAR SHARD EXCHANGE</span><h2 className="serif">{t('gacha.exchange')}</h2></div>
          <button type="button" className="round" onClick={onClose} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </header>
        <div className="shard-balance"><span>{t('gacha.shardBalance')}</span><strong>{t('gacha.shardUnit', { n: state.shards })}</strong></div>
        <nav className="shard-tiers" aria-label={t('gacha.exchangeTier')}>
          {TIERS.map((rarity) => <button key={rarity} type="button" aria-pressed={tier === rarity} onClick={() => { setTier(rarity); setPick(null); }}><b>{rarity}</b><small>{t('gacha.duplicateYield', { n: RULES.duplicateShards[rarity] })}</small><small>{t('gacha.shardCost', { n: RULES.exchangeShards[rarity] })}</small></button>)}
        </nav>
        <p className="shard-note">{t('gacha.exchangeBody', { n: state.shards, need: RULES.exchangeShards[tier], tier })}</p>
        <div className="shard-cards">
          {cards.map((card) => <button key={card.id} type="button" aria-pressed={pick === card.id} onClick={() => setPick(card.id)}><CardTile card={card} small /></button>)}
        </div>
        <button type="button" className="btn btn-rose shard-confirm" disabled={!selected || !enough || busy} onClick={() => void confirm()}>
          {selected ? (enough ? t('gacha.exchangeGoCost', { n: cost }) : t('gacha.noShardsNeed', { n: cost - state.shards })) : t('gacha.exchangePick')}
        </button>
      </section>
    </div>
  );
}
