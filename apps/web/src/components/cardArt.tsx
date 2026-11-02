/**
 * Presentation around CardTile (engineering owns the tile and its tier frames in cards.css): a stand-in still of
 * her while the card's own art is pending or fails to load, and the pointer tilt with a moving glare.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { RARITY_ORDER, cardArt, cardTitle, type CardDef, type Rarity } from '../data/cards';
import { tierCounts } from '@jstar/shared/gacha';
import { dotSep, type Key, type Lang } from '../i18n';
import { CardTile } from './cardTile';
import { fallbackArt } from './stills';
import '../styles/card.css';

export type Tier = Rarity;
export const TIERS: Tier[] = ['N', 'R', 'SR', 'SSR', 'UR'];
/** Tier colours: the omen light, the particles and the ladder. */
export const TIER_COLOR: Record<Tier, string> = { N: '#CFC8DA', R: '#C9D6EC', SR: '#EBA5B5', SSR: '#F3CF86', UR: '#F7B2E0' };

export const tierOf = (c: CardDef): Tier => c.rarity;
/** 0 (N) … 4 (UR). */
export const rankOf = (c: CardDef): number => (RARITY_ORDER[c.rarity] ?? 2) - 1;
export const bestCard = <T extends CardDef>(cards: T[]): T => [...cards].sort((a, b) => rankOf(b) - rankOf(a))[0];
export const titleOf = (c: CardDef, lang: Lang): string => cardTitle(c, lang);

/**
 * H1: one line for a draw — how many cards, then every tier it holds (UR, SSR, SR, R, N), rarest first; the counts add
 * up to the cards drawn. The gacha and serial results, the gacha history and the serial history all say it this way.
 */
export function drawSummary(rarities: Rarity[], t: (k: Key, v?: Record<string, string | number>) => string, lang: Lang): string {
  const c = tierCounts(rarities);
  return t('gr.summary', { n: c.total, tiers: c.tiers.map((x) => `${x.tier} ${x.n}`).join(dotSep(lang)) });
}

const probed = new Map<string, Promise<boolean>>();
function artLoads(src: string): Promise<boolean> {
  if (!probed.has(src)) probed.set(src, new Promise((res) => { const i = new Image(); i.onload = () => res(true); i.onerror = () => res(false); i.src = src; }));
  return probed.get(src)!;
}

export function CardArt({ card, locked, to, small, tilt, className, style }: {
  card: CardDef; locked?: boolean; to?: string; small?: boolean; tilt?: boolean; className?: string; style?: CSSProperties;
}) {
  const own = locked ? null : cardArt(card, small ? 'sm' : 'full');
  const [ownOk, setOwnOk] = useState<boolean | null>(own ? null : false);
  useEffect(() => {
    let live = true;
    if (own) void artLoads(own).then((ok) => { if (live) setOwnOk(ok); });
    return () => { live = false; };
  }, [own]);
  const n = Number(/(\d+)$/.exec(card.id)?.[1] ?? 1);
  const fb = !locked && ownOk === false ? fallbackArt(card, rankOf(card)) : undefined;
  return (
    <div className={`cardx tier-${card.rarity}${tilt ? ' tilt' : ''}${locked ? ' is-locked' : ''}${fb ? ' stand-in' : ''}${className ? ` ${className}` : ''}`} style={style}>
      {fb && <img className="cardx-art" src={fb} alt="" draggable={false} loading="lazy" decoding="async" style={{ objectPosition: `${38 + ((n * 17) % 26)}% 20%` }} />}
      <CardTile card={card} locked={locked} to={to} small={small} />
      {tilt && <i className="cardx-glare" aria-hidden="true" />}
    </div>
  );
}
