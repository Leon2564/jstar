import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { POOL_IDS, disclosure, poolCards } from '@jstar/shared/gacha';
import { RULES, VARIANT_CARDS } from '@jstar/shared/rules';
import { CAST, getStar } from '../data/cast';
import { CARD_BY_ID, CARDS, RARITIES, cardTitle } from '../data/cards';
import { starName } from '../i18n';
import { useT } from '../lib/store';
import { Header } from '../components/ui';
import { NotFound } from './siteMore';
import { LEGAL, type DocId } from './legalText';
import type { GachaRatesResT, PickupRatesT } from '@jstar/shared/contracts';
import { fetchRates, fmtJst, localPickups } from '../lib/pickups';

const DOCS: (DocId | 'rates')[] = ['terms', 'privacy', 'ai', 'rates', 'operator'];
const pct = (x: number) => `${(Math.round(x * 100000) / 1000).toString()}%`;

type Pool = GachaRatesResT['pools'][number];

/** 提供割合: per pool, per tier, per card, and the pity-adjusted rate — the numbers the server draws with. */
function Rates() {
  const t = useT();
  const local = (): Pool[] => POOL_IDS.map((id) => ({ id, ...disclosure(poolCards(id, CARDS)) }));
  const [pools, setPools] = useState<Pool[]>(local);
  // Pickups (#78): live and scheduled, each with the odds computed from its config — announced before it starts.
  const [pickups, setPickups] = useState<PickupRatesT[]>(() => localPickups(CARDS));
  const [open, setOpen] = useState<string>('all');
  useEffect(() => {
    void fetchRates().then((d) => {
      if (d?.pools) setPools(d.pools);
      if (d?.pickups) setPickups(d.pickups);
    });
  }, []);
  const label = (id: string) => (id === 'all' ? t('gacha.poolAll') : starName(getStar(id.slice(5) as never), t.lang));
  // Variant cards (#75) are listed from the configuration, so the note fits whichever cards the owner picks (#84), or none.
  const variants = VARIANT_CARDS.map((id) => CARD_BY_ID[id]).filter(Boolean);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="small" style={{ margin: 0 }}>{t('rates.intro', { pity: RULES.pityPulls, shards: RULES.shardsForExchange })}</p>
      {pools.map((p) => (
        <section key={p.id} className="panel stack" style={{ gap: 8 }} data-testid={`rates-${p.id}`}>
          <h2 className="serif" style={{ margin: 0, fontSize: 17 }}>{label(p.id)}</h2>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>{t('rates.tier')}</th><th style={{ textAlign: 'right' }}>{t('rates.rate')}</th><th style={{ textAlign: 'right' }}>{t('rates.perCard')}</th><th style={{ textAlign: 'right' }}>{t('rates.cards')}</th></tr></thead>
            <tbody>{[...p.rows].reverse().map((r) => <tr key={r.tier}><td>{r.tier}</td><td style={{ textAlign: 'right' }}>{pct(r.rate)}</td><td style={{ textAlign: 'right' }}>{pct(r.perCard)}</td><td style={{ textAlign: 'right' }}>{r.cards}</td></tr>)}</tbody>
          </table>
          <p className="tiny muted" style={{ margin: 0 }}>{t('rates.effective', { rate: pct(p.effectiveTopRate), pity: p.pity })}</p>
          <button type="button" className="btn-text" style={{ alignSelf: 'flex-start', textDecoration: 'underline' }} aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? '' : p.id)}>{t('rates.list')}</button>
          {open === p.id && (
            <ul className="tiny" style={{ margin: 0, paddingLeft: 16, columns: 2 }}>
              {RARITIES.slice().reverse().flatMap((tier) => poolCards(p.id as never, CARDS).filter((c) => c.rarity === tier).map((c) => (
                <li key={c.id}>{tier} · {starName(getStar(c.star), t.lang)}「{cardTitle(c, t.lang)}」{pct(p.rows.find((r) => r.tier === tier)?.perCard ?? 0)}</li>
              )))}
            </ul>
          )}
        </section>
      ))}
      {pickups.filter((p) => CARD_BY_ID[p.cardId]).map((p) => <PickupRates key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? '' : p.id)} />)}
      <section className="panel stack" style={{ gap: 6 }}>
        <h2 className="serif" style={{ margin: 0, fontSize: 17 }}>{t('rates.codeTitle')}</h2>
        <p className="small" style={{ margin: 0 }}>{t('rates.code', { n: RULES.lucky.drawsPerCode, ur: pct(pools[0].firstCodeDraw.UR), ssr: pct(pools[0].firstCodeDraw.SSR), sr: pct(pools[0].firstCodeDraw.SR) })}</p>
      </section>
      {variants.length > 0 && (
        <section className="panel stack" style={{ gap: 6 }} data-testid="rates-variants">
          <h2 className="serif" style={{ margin: 0, fontSize: 17 }}>{t('rates.variantsTitle')}</h2>
          <p className="small" style={{ margin: 0 }}>{t('rates.variants', { n: variants.length })}</p>
          <ul className="tiny" style={{ margin: 0, paddingLeft: 16 }}>
            {variants.map((c) => <li key={c.id}>{c.rarity} · {starName(getStar(c.star), t.lang)}「{cardTitle(c, t.lang)}」</li>)}
          </ul>
        </section>
      )}
      <p className="tiny muted" style={{ margin: 0 }}>{t('rates.note', { n: CAST.length })}</p>
    </div>
  );
}

/**
 * One Pickup's 提供割合 (#78). 景品表示法 (docs/compliance-jp.md §3): the boosted card's rate is a number beside its
 * usual one — never only "UP" — with the period, and the table shows what the other cards of the band come down to.
 */
function PickupRates({ p, open, onToggle }: { p: PickupRatesT; open: boolean; onToggle: () => void }) {
  const t = useT();
  const card = CARD_BY_ID[p.cardId];
  const name = starName(getStar(p.star), t.lang);
  const title = cardTitle(card, t.lang);
  const perCard = (id: string, tier: string) => (id === p.cardId ? p.pickup.rate : p.rows.find((r) => r.tier === tier)?.perCard ?? 0);
  return (
    <section className="panel stack" style={{ gap: 8, borderColor: 'var(--rose)' }} data-testid={`rates-${p.id}`}>
      <h2 className="serif" style={{ margin: 0, fontSize: 17 }}>{t('rates.pickupTitle', { title, name })}</h2>
      <p className="tiny muted" style={{ margin: 0 }}>{t('rates.pickupPeriod', { from: fmtJst(p.startsAt, t.lang), to: fmtJst(p.endsAt, t.lang), status: t(p.live ? 'rates.pickupLive' : 'rates.pickupSoon') })}</p>
      <p className="small" style={{ margin: 0 }} data-testid="rates-pickup-row">{t('rates.pickupRow', { title, tier: p.pickup.tier, rate: pct(p.pickup.rate), name, base: pct(p.pickup.baseRate), share: pct(p.pickup.share) })}</p>
      <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>{t('rates.tier')}</th><th style={{ textAlign: 'right' }}>{t('rates.rate')}</th><th style={{ textAlign: 'right' }}>{t('rates.perCard')}</th><th style={{ textAlign: 'right' }}>{t('rates.cards')}</th></tr></thead>
        <tbody>{[...p.rows].reverse().map((r) => <tr key={r.tier}><td>{r.tier}</td><td style={{ textAlign: 'right' }}>{pct(r.rate)}</td><td style={{ textAlign: 'right' }}>{r.cards === 1 && p.pickup.tier === r.tier ? pct(p.pickup.rate) : pct(r.perCard)}</td><td style={{ textAlign: 'right' }}>{r.cards}</td></tr>)}</tbody>
      </table>
      <p className="tiny muted" style={{ margin: 0 }}>{t('rates.effective', { rate: pct(p.effectiveTopRate), pity: p.pity })} {t('rates.pickupEffective', { title, rate: pct(p.pickup.effectiveRate) })}</p>
      <p className="tiny muted" style={{ margin: 0 }}>{t('rates.pickupNote', { name })}</p>
      <button type="button" className="btn-text" style={{ alignSelf: 'flex-start', textDecoration: 'underline' }} aria-expanded={open} onClick={onToggle}>{t('rates.list')}</button>
      {open && (
        <ul className="tiny" style={{ margin: 0, paddingLeft: 16, columns: 2 }}>
          {RARITIES.slice().reverse().flatMap((tier) => poolCards(`star:${p.star}`, CARDS).filter((c) => c.rarity === tier).map((c) => (
            <li key={c.id} style={c.id === p.cardId ? { fontWeight: 600 } : undefined}>{tier} · 「{cardTitle(c, t.lang)}」{pct(perCard(c.id, tier))}</li>
          )))}
        </ul>
      )}
    </section>
  );
}

/**
 * There is no Korean text of these documents yet (they are drafts awaiting counsel, legalText.ts): in Korean the
 * English text is shown under this note, so nobody takes it for a reviewed Korean version (M10).
 */
const KO_NOTE = '이 문서는 아직 한국어로 번역되지 않아 영어 원문을 표시합니다. 한국어판은 정식 공개 전에 제공됩니다.';

export function Legal() {
  const { doc } = useParams();
  const t = useT();
  // L5: an unknown document is a missing page, not the terms.
  if (!doc || !(DOCS as string[]).includes(doc)) return <NotFound />;
  const lang = (['ja', 'zh-Hant', 'en'] as const).find((l) => l === t.lang) ?? 'en';
  const content = doc === 'rates' ? null : LEGAL[doc as DocId][lang];
  const title = content ? content.title : t('legal.rates');
  return (
    <main className="page night-page js-nightpage">
      <Header back={true} />
      <div className="col pad" style={{ paddingBottom: 32 }}>
        <h1 className="h1" style={{ fontSize: 22, margin: '0 0 8px' }}>{title}</h1>
        <nav aria-label={t('legal.nav')} style={{ display: 'flex', columnGap: 16, flexWrap: 'wrap', margin: '0 0 14px' }} className="small">
          {DOCS.map((d) => <Link key={d} to={`/legal/${d}`} aria-current={d === doc ? 'page' : undefined} style={{ minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', textDecoration: d === doc ? 'none' : 'underline', fontWeight: d === doc ? 600 : 400 }}>{t(`legal.${d}` as never)}</Link>)}
        </nav>
        {content ? (
          <article className="stack" style={{ gap: 16 }} lang={lang}>
            {/* A-N1: a hint strip on the night (ivory on navy, the rose rule), Korean broken between words only. */}
            {t.lang === 'ko' && <p className="js-hint" lang="ko" data-testid="legal-ko-note" style={{ margin: 0, padding: '10px 12px', lineHeight: 1.7, wordBreak: 'keep-all' }}>{KO_NOTE}</p>}
            <p className="tiny muted" style={{ margin: 0 }}>{t('legal.draft', { date: content.updated })}</p>
            {content.sections.map((s) => (
              <section key={s.h}>
                <h2 className="serif" style={{ fontSize: 16, margin: '0 0 6px' }}>{s.h}</h2>
                {s.p.map((p, k) => <p key={k} className="small" style={{ margin: '0 0 8px', lineHeight: 1.9 }}>{p}</p>)}
              </section>
            ))}
          </article>
        ) : <Rates />}
      </div>
    </main>
  );
}
