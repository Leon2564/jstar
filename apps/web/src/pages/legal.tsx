import { Link, useParams } from 'react-router-dom';
import { DEFAULT_RATES, floorRates } from '@jstar/shared/gacha';
import { RULES } from '@jstar/shared/rules';
import { useT } from '../lib/store';
import { Header } from '../components/ui';
import { NotFound } from './siteMore';
import { LEGAL, type DocId } from './legalText';

const DOCS: (DocId | 'rates')[] = ['terms', 'privacy', 'ai', 'rates', 'operator'];
const pct = (value: number) => `${(Math.round(value * 100000) / 1000).toString()}%`;

function Rates() {
  const t = useT();
  const first = floorRates('SR');
  return <div className="stack" style={{ gap: 14 }}>
    <p className="small" style={{ margin: 0 }}>{t('rates.intro')}</p>
    <section className="panel stack" style={{ gap: 8 }}>
      <h2 className="serif" style={{ margin: 0, fontSize: 17 }}>{t('rates.codeTitle')}</h2>
      <p className="small" style={{ margin: 0 }}>{t('serial.gets', { n: RULES.lucky.drawsPerCode })}</p>
      <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>{t('rates.tier')}</th><th style={{ textAlign: 'right' }}>{t('rates.rate')}</th><th style={{ textAlign: 'right' }}>{t('rates.firstCard')}</th></tr></thead>
        <tbody>{(['UR', 'SSR', 'SR', 'R', 'N'] as const).map((tier) => <tr key={tier}><td>{tier}</td><td style={{ textAlign: 'right' }}>{pct(DEFAULT_RATES[tier])}</td><td style={{ textAlign: 'right' }}>{pct(first[tier])}</td></tr>)}</tbody>
      </table>
      <p className="tiny muted" style={{ margin: 0 }}>{t('serial.once')}</p>
    </section>
  </div>;
}

const KO_NOTE = '이 문서는 아직 한국어로 번역되지 않아 영어 원문을 표시합니다. 한국어판은 정식 공개 전에 제공됩니다.';

export function Legal() {
  const { doc } = useParams();
  const t = useT();
  if (!doc || !(DOCS as string[]).includes(doc)) return <NotFound />;
  const lang = (['ja', 'zh-Hant', 'en'] as const).find((item) => item === t.lang) ?? 'en';
  const content = doc === 'rates' ? null : LEGAL[doc as DocId][lang];
  const title = content ? content.title : t('legal.rates');
  return <main className="page night-page js-nightpage">
    <Header back={true} />
    <div className="col pad" style={{ paddingBottom: 32 }}>
      <h1 className="h1" style={{ fontSize: 22, margin: '0 0 8px' }}>{title}</h1>
      <nav aria-label={t('legal.nav')} style={{ display: 'flex', columnGap: 16, flexWrap: 'wrap', margin: '0 0 14px' }} className="small">
        {DOCS.map((item) => <Link key={item} to={`/legal/${item}`} aria-current={item === doc ? 'page' : undefined} style={{ minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', textDecoration: item === doc ? 'none' : 'underline', fontWeight: item === doc ? 600 : 400 }}>{t(`legal.${item}` as never)}</Link>)}
      </nav>
      {content ? <article className="stack" style={{ gap: 16 }} lang={lang}>
        {t.lang === 'ko' && <p className="js-hint" lang="ko" data-testid="legal-ko-note" style={{ margin: 0, padding: '10px 12px', lineHeight: 1.7, wordBreak: 'keep-all' }}>{KO_NOTE}</p>}
        <p className="tiny muted" style={{ margin: 0 }}>{t('legal.draft', { date: content.updated })}</p>
        {content.sections.map((section) => <section key={section.h}>
          <h2 className="serif" style={{ fontSize: 16, margin: '0 0 6px' }}>{section.h}</h2>
          {section.p.map((paragraph, index) => <p key={index} className="small" style={{ margin: '0 0 8px', lineHeight: 1.9 }}>{paragraph}</p>)}
        </section>)}
      </article> : <Rates />}
    </div>
  </main>;
}
