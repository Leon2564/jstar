import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { cardArt, cardLine, cardTitle, type CardDef } from '../data/cards';
import { getStar } from '../data/cast';
import { starName } from '../i18n';
import { useT } from '../lib/store';
import './cards.css';

const CARD_BACK = '/cards/jstar-genesis-back.png';
const CARD_OFFSET: Record<CardDef['star'], number> = { mahiro: 0, nana: 30, unpai: 60, alice: 90, eimi: 120 };

function cardNumber(card: CardDef): string {
  const local = Number(/-(\d+)$/.exec(card.id)?.[1] ?? 0);
  return String(CARD_OFFSET[card.star] + local).padStart(3, '0');
}

/** Card faces live in their own chunk with the catalog, so the first screen doesn't carry 150 cards. */
export function RarityBadge({ r }: { r: CardDef['rarity'] | 'MEM' }) {
  const t = useT();
  return <span className={`badge r-${r}`}>{r === 'MEM' ? t('common.memory') : r}</span>;
}

/** The UR card's gold-foil comment (deck: コメント箔押し): the first phrase of her line, short enough to sign. */
export function foilNote(line: string): string {
  const first = (/^[^。！？!?.]*[。！？!?.]?/.exec(line.trim())?.[0] ?? '').trim();
  return [...first].length > 16 ? `${[...first].slice(0, 15).join('')}…` : first;
}

export function CardTile({ card, locked, to, glow, small, className, style }: { card: CardDef; locked?: boolean; to?: string; glow?: boolean; small?: boolean; className?: string; style?: CSSProperties }) {
  const t = useT();
  const star = getStar(card.star);
  const name = starName(star, t.lang);
  const title = cardTitle(card, t.lang);
  const [artOk, setArtOk] = useState(true);
  const src = !locked && artOk ? cardArt(card, small ? 'sm' : 'full') : null;
  const face = (
    <>
      {src && <img className="art" src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setArtOk(false)} />}
      <span className="r"><RarityBadge r={card.rarity} /></span>
      {card.rarity === 'UR' && src && !small && <span className="foil-note" aria-hidden="true">{foilNote(cardLine(card, t.lang))}</span>}
      {!small && <span className="src">{card.source === 'photo' ? t('common.photo') : t('common.ai')}</span>}
      <span className="cap"><b>{name}</b><span>{title}</span></span>
    </>
  );
  const body = locked
    ? <>
        <img className="card-back-art" src={CARD_BACK} alt="" loading="lazy" decoding="async" draggable={false} />
        <span className={`card-back-rarity r-${card.rarity}`} aria-hidden="true">{card.rarity}</span>
        <span className="card-back-no" aria-hidden="true">S1 · {cardNumber(card)}</span>
      </>
    : face;
  const cls = `card tier-${card.rarity}${locked ? ' is-locked' : ''}${src ? ' has-art' : ''}${glow ? ' glow' : ''}${className ? ` ${className}` : ''}`;
  const label = `${name}「${locked ? t('common.locked') : title}」${card.rarity}`;
  return to && !locked
    ? <Link to={to} className={`${cls} card-link`} style={{ background: star.tint, ...style }} aria-label={label}>{body}</Link>
    : <div className={cls} style={{ background: star.tint, ...style }} role="img" aria-label={label}>{body}</div>;
}

