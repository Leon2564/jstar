import { Link } from 'react-router-dom';
import type { Key } from '../i18n';
import { useT } from '../lib/store';
import { Icon } from './ui';
import '../styles/footer.css';

/** Legal pages (built by the engineering stream); every page footer and the menu link here. */
export const LEGAL: [string, Key][] = [
  ['/legal/terms', 'legal.terms'], ['/legal/privacy', 'legal.privacy'], ['/legal/ai', 'legal.ai'],
  ['/legal/operator', 'legal.operator'], ['/legal/rates', 'legal.rates']
];
/** Official social accounts. Listed only once confirmed, so there is never a dead link. */
export const SNS: { name: string; href: string }[] = [];

export function Footer() {
  const t = useT();
  return (
    <footer className="site-foot">
      <div className="foot-in">
        <div className="foot-brand">
          <span className="brand" style={{ padding: 0 }}><Icon name="spark" size={14} />JSTAR</span>
          <p className="tiny">{t('top.aiNote')}<br />{t('foot.adult')}</p>
        </div>
        <nav aria-label={t('foot.legal')} className="foot-links">
          {LEGAL.map(([to, key]) => <Link key={to} to={to}>{t(key)}</Link>)}
        </nav>
        {SNS.length > 0 && <nav aria-label="SNS" className="foot-links">{SNS.map((s) => <a key={s.name} href={s.href} target="_blank" rel="noopener noreferrer">{s.name}</a>)}</nav>}
        <p className="tiny foot-copy">© 2026 JSTAR</p>
      </div>
    </footer>
  );
}
