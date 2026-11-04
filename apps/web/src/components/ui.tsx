import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { LANG_NAMES, SELECTABLE_LANGS, type Lang } from '../i18n';
import { useStore, useT } from '../lib/store';
import { setSound, useSound } from '../lib/sound';

type IconName = 'spark' | 'back' | 'menu' | 'close' | 'play' | 'send' | 'mic' | 'lock' | 'chat' | 'gacha' | 'cards' | 'user' | 'speaker' | 'mute' | 'check' | 'chev' | 'clock' | 'ear';

export function Icon({ name, size = 20, fill }: { name: IconName; size?: number; fill?: string }) {
  const p = { width: size, height: size, 'aria-hidden': true as const, focusable: false as const };
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'spark':
      return <svg {...p} viewBox="-10 -10 20 20"><path d="M0 -10 C1 -2 2 -1 10 0 C2 1 1 2 0 10 C-1 2 -2 1 -10 0 C-2 -1 -1 -2 0 -10 Z" fill={fill ?? 'var(--rose)'} /></svg>;
    case 'back': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M15 5l-7 7 7 7" /></svg>;
    case 'chev': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M9 5l7 7-7 7" /></svg>;
    case 'close': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M5 5l14 14M19 5L5 19" /></svg>;
    case 'menu': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M3 9h18M9 15h12" /></svg>;
    case 'play': return <svg {...p} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;
    case 'send': return <svg {...p} viewBox="0 0 24 24" {...s} strokeWidth={1.7}><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
    case 'mic': return <svg {...p} viewBox="0 0 24 24" {...s}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v3" /></svg>;
    case 'lock': return <svg {...p} viewBox="0 0 24 24" {...s}><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
    case 'chat': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M4 5h16v11H9l-5 4z" /></svg>;
    case 'gacha': return <svg {...p} viewBox="0 0 24 24" {...s}><rect x="8" y="3" width="12" height="16" rx="1.5" /><path d="M5 7v12.5A1.5 1.5 0 0 0 6.5 21H16" /></svg>;
    case 'cards': return <svg {...p} viewBox="0 0 24 24" {...s}><rect x="4" y="4" width="7" height="9" /><rect x="13" y="4" width="7" height="9" /><rect x="4" y="15" width="7" height="5" /><rect x="13" y="15" width="7" height="5" /></svg>;
    case 'user': return <svg {...p} viewBox="0 0 24 24" {...s}><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" /></svg>;
    case 'speaker': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>;
    case 'mute': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M16 10l4 4M20 10l-4 4" /></svg>;
    case 'check': return <svg {...p} viewBox="0 0 24 24" {...s} strokeWidth={2}><path d="M5 12l4 4 10-10" /></svg>;
    case 'clock': return <svg {...p} viewBox="0 0 24 24" {...s}><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.5 2M5 5.5l2.5-2M19 5.5l-2.5-2" /></svg>;
    // Hands-free (#72): an ear that listens by itself.
    case 'ear': return <svg {...p} viewBox="0 0 24 24" {...s}><path d="M7 10a5 5 0 0 1 10 0c0 3-3 4-3 6.5A2.5 2.5 0 0 1 9.5 19M9.5 10a2.5 2.5 0 0 1 5 0" /><path d="M3.5 8.5a9 9 0 0 1 2-4M20.5 8.5a9 9 0 0 0-2-4" /></svg>;
  }
}

export function LangSelect() {
  const { state, actions } = useStore();
  const t = useT();
  return (
    <>
      <label htmlFor="lang-select" className="sr-only">{t('menu.lang')}</label>
      <select id="lang-select" className="lang-select" value={state.lang} onChange={(e) => actions.setLang(e.target.value as Lang)}>
        {SELECTABLE_LANGS.map((l) => <option key={l} value={l} lang={l}>{LANG_NAMES[l]}</option>)}
      </select>
    </>
  );
}

export const SITE_NAV = [
  ['/', 'nav.home', 'Home'], ['/stars', 'nav.stars', 'Stars'], ['/features', 'nav.features', 'Features'],
  ['/gacha', 'nav.gacha', 'Gacha'], ['/gallery', 'nav.cards', 'Cards'], ['/events', 'nav.events', 'Events']
] as const;
/** Recharge is contextual: it opens from a credit balance or when chat credit is short. */
export const siteNav = (_member: boolean) => SITE_NAV;

/** The persistent music / UI sound switch (lib/sound.ts). */
export function SoundToggle() {
  const t = useT();
  const on = useSound();
  return (
    <button type="button" className={`icon-btn sound-btn${on ? ' on' : ''}`} aria-label={on ? t('top.soundOff') : t('top.soundOn')} aria-pressed={on} onClick={() => setSound(!on)}>
      <Icon name={on ? 'speaker' : 'mute'} size={22} />
    </button>
  );
}

/**
 * Site header: brand + icons on phones, full horizontal navigation on desktop (≥1024px).
 * The menu (login, legal, social) is reachable at every size. `cta` shows the "talk to her" button
 * (the home page hides it on the first screen, where the same call to action is already in view).
 */
export function SiteHeader({ extra, cta = true }: { extra?: ReactNode; cta?: boolean }) {
  const member = !!useStore().state.user;
  const t = useT();
  return (
    <header className="hdr">
      <Link to="/" className="brand" aria-label="JSTAR"><Icon name="spark" size={16} />JSTAR</Link>
      <nav className="site-links" aria-label={t('nav.site')}>
        {siteNav(member).map(([to, key, en]) => (
          <NavLink key={to} to={to} end={to === '/'}>{t(key)}{t.lang !== 'en' && <small aria-hidden="true">{en}</small>}</NavLink>
        ))}
      </nav>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {extra}
        <SoundToggle />
        <span className="site-links" style={{ margin: 0 }}><LangSelect /></span>
        <Link to={member ? '/me/home' : '/pick'} className={`btn btn-rose hdr-cta magnetic${cta ? '' : ' is-off'}`} aria-hidden={cta ? undefined : true} tabIndex={cta ? undefined : -1}>{t(member ? 'top.room' : 'top.talk')}</Link>
        <Link to="/menu" className="icon-btn" aria-label={t('common.menu')}><Icon name="menu" size={22} /></Link>
      </span>
    </header>
  );
}

/** Whether the device is online; follows the browser's online / offline events. */
export function useOnline(): boolean {
  const [on, setOn] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => { removeEventListener('online', up); removeEventListener('offline', down); };
  }, []);
  return on;
}

/** The shell's count of docked offline lines on screen (App's Shell provides it; none outside the app). */
export const OfflineDock = createContext<(() => () => void) | null>(null);

/**
 * M10 / B-N3 / A-N3: one quiet line while the device is offline; it goes when the connection is back. Docked (the
 * default), it sits in the page's flow right under its header band — the chat's and the trial's header, a member
 * page's — and sticks there while the page scrolls (`.offline-line`, global.css), so it never covers a header.
 * Her room docks it under its own top band the same way. `float` is the shell's line for a screen without a docked
 * one: fixed under the site header's band. While a docked line is mounted, the shell's floating one stays away.
 */
export function OfflineLine({ float, className, style }: { float?: boolean; className?: string; style?: CSSProperties }) {
  const t = useT();
  const on = useOnline();
  const dock = useContext(OfflineDock);
  useEffect(() => (float || !dock ? undefined : dock()), [float, dock]);
  if (on) return null;
  return <p className={`offline-line${float ? ' float' : ''}${className ? ` ${className}` : ''}`} style={style} role="status" data-testid="offline-bar">{t('off.banner')}</p>;
}

export function Header({ title, back, right }: { title?: string; back?: string | true; right?: ReactNode }) {
  const nav = useNavigate();
  const t = useT();
  return (
    <>
    <header className="hdr">
      {back === true ? (
        // A-M4: opened straight from a link there is nothing in this tab to go back to (it left the site): the top page.
        <button type="button" className="icon-btn" aria-label={t('common.back')} onClick={() => ((window.history.state as { idx?: number } | null)?.idx ? nav(-1) : nav('/'))}><Icon name="back" /></button>
      ) : back ? (
        <Link className="icon-btn" to={back} aria-label={t('common.back')}><Icon name="back" /></Link>
      ) : <span style={{ width: 44 }} />}
      {title ? <span className="hdr-title">{title}</span> : <span />}
      {right ?? <span style={{ width: 44 }} />}
    </header>
    <OfflineLine />
    </>
  );
}

/**
 * Placeholder for photo/video assets. When `src` is provided it renders the real asset;
 * until then it shows the slot spec so the asset team knows exactly what goes where.
 */
export function MediaSlot({ tint, label, spec, src, video, style, className, children }: {
  tint: string; label: string; spec: string; src?: string; video?: boolean; style?: CSSProperties; className?: string; children?: ReactNode;
}) {
  return (
    <div className={`media ${className ?? ''}`} style={{ background: tint, ...style }} data-slot={label}>
      {src ? (video
        ? <video src={src} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" />
        : <img src={src} alt="" loading="lazy" decoding="async" />)
        : <p className="media-tag" aria-hidden="true">{label}<br />{spec}</p>}
      {children}
    </div>
  );
}

export function TabBar() {
  const t = useT();
  const items: { to: string; key: 'tab.her' | 'tab.talk' | 'tab.gacha' | 'tab.cards' | 'tab.me'; icon: IconName }[] = [
    { to: '/me/home', key: 'tab.her', icon: 'spark' },
    { to: '/me/chat', key: 'tab.talk', icon: 'chat' },
    { to: '/gacha', key: 'tab.gacha', icon: 'gacha' },
    { to: '/me/cards', key: 'tab.cards', icon: 'cards' },
    { to: '/me/mypage', key: 'tab.me', icon: 'user' }
  ];
  return (
    <nav className="tabbar" aria-label={t('tab.label')}>
      <Link to="/" className="tb-brand" aria-label={t('nav.home')}><Icon name="spark" size={14} />JSTAR</Link>
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.to === '/me/home'}>
          {it.icon === 'spark'
            ? <svg width="22" height="22" viewBox="-12 -12 24 24" aria-hidden="true"><path d="M0 -10 C1 -2 2 -1 10 0 C2 1 1 2 0 10 C-1 2 -2 1 -10 0 C-2 -1 -1 -2 0 -10 Z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
            : <Icon name={it.icon} size={22} />}
          {t(it.key)}
        </NavLink>
      ))}
    </nav>
  );
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(id);
  }, [msg]);
  return [msg, setMsg];
}

export function Toast({ msg, style }: { msg: string | null; style?: CSSProperties }) {
  return msg ? <div className="toast" role="status" aria-live="polite" style={style}>{msg}</div> : <div role="status" aria-live="polite" className="sr-only" />;
}

export function Typing({ label }: { label: string }) {
  return <p className="typing" role="status" aria-label={label}><i /><i /><i /></p>;
}
