/**
 * Secondary site pages. A separate chunk so the first visit only downloads the age gate,
 * the loading screen and the home stage (bundle budget: tests/e2e/perf.spec.ts).
 */
import { localText } from '@jstar/shared/domain';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CAST, getStar } from '../data/cast';
import { CARDS, type CardDef } from '../data/cards';
import { EVENT_BADGE, eventStatus } from '../data/events';
import { upcomingEvents } from '../data/eventsCalendar';
import { SIGNATURE, THEME } from '../data/theme';
import { monthDayLabel, profileOf } from '../data/profile';
import { starFirst, starName, type Key, fmtDate } from '../i18n';
import { audioExists, playVoice, stopVoice } from '../lib/sound';
import { useStore, useT } from '../lib/store';
import { isDemo } from '../services/api';
import { Icon, LangSelect, MediaSlot, SiteHeader, siteNav } from '../components/ui';
import { SceneVideo, media, sceneFor, stillOf, usePortrait } from '../components/stage';
import { CardArt, rankOf } from '../components/cardArt';
import { CardShowcase } from '../components/cardShowcase';
import { Footer, LEGAL, SNS } from '../components/footer';
import { LiveFeaturePreview } from './live';
import '../components/gift.css';
import '../styles/site.css';
// The gallery, the legal pages and the 404 are on the A2 night too (the member pages' night scope).
import '../system/system.css';

export function Menu() {
  const { state } = useStore();
  const t = useT();
  return (
    <div className="page dark" style={{ background: 'var(--navy)', color: 'var(--ivory)', padding: '0 24px', minHeight: '100dvh' }}>
      <div className="menu-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <header className="hdr" style={{ padding: 0, marginRight: -12 }}>
          <span className="brand" style={{ padding: 0 }}>JSTAR</span>
          <Link to={state.user ? '/me/home' : '/'} className="icon-btn" aria-label={t('common.close')}><Icon name="close" /></Link>
        </header>
        <nav aria-label={t('nav.site')} className="menu-nav" style={{ marginTop: 16 }}>
          {siteNav(!!state.user).map(([to, key, en]) => (
            <Link key={to} to={to}>
              <span className="serif" style={{ fontSize: 23 }}>{t(key)}</span>
              {t.lang !== 'en' && <span className="serif" aria-hidden="true" style={{ fontSize: 12, letterSpacing: '0.3em', color: '#E3A8B2' }}>{en}</span>}
            </Link>
          ))}
        </nav>
        <div className="grid2" style={{ marginTop: 26, maxWidth: 520 }}>
          {state.user
            ? <Link to="/me/mypage" className="btn btn-ivory" style={{ minHeight: 48 }}>{t('menu.mypage')}</Link>
            : <Link to="/signup?mode=login" className="btn btn-ivory" style={{ minHeight: 48 }}>{t('menu.login')}</Link>}
          <Link to="/serial" className="btn btn-ghost" style={{ minHeight: 48 }}>{t('menu.serial')}</Link>
        </div>
        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="small">{t('menu.lang')}</span>
          <LangSelect />
        </div>
        <div className="menu-foot" style={{ marginTop: 'auto', padding: '24px 0 22px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {SNS.length > 0 && <div style={{ display: 'flex', gap: 18, fontSize: 12 }}>{SNS.map((x) => <a key={x.name} href={x.href} target="_blank" rel="noopener noreferrer">{x.name}</a>)}</div>}
          <nav aria-label={t('foot.legal')} style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', fontSize: 12, color: 'rgba(239,232,237,0.82)' }}>
            {LEGAL.map(([to, k]) => <Link key={to} to={to} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>{t(k)}</Link>)}
          </nav>
          <p className="tiny" style={{ margin: 0, color: 'rgba(239,232,237,0.72)' }}>{t('foot.adult')}　© 2026 JSTAR</p>
        </div>
      </div>
    </div>
  );
}

/**
 * JSTARS: one talent at a time, in her own colour. Her clip enters like a curtain opening; the name, line and
 * profile sit beside her on desktop and below her face on phones, never over it. Only confirmed data is shown.
 */
export function Stars() {
  const t = useT();
  const { actions } = useStore();
  const loc = useLocation();
  const nav = useNavigate();
  const [i, setI] = useState(() => Math.max(0, CAST.findIndex((c) => c.id === new URLSearchParams(loc.search).get('star'))));
  // A `?star=` link followed while this page is open (menu, back/forward) switches to her too.
  useEffect(() => {
    const n = CAST.findIndex((c) => c.id === new URLSearchParams(loc.search).get('star'));
    if (n >= 0) setI((cur) => (cur === n ? cur : n));
  }, [loc.search]);
  const [voice, setVoice] = useState(false);
  const portrait = usePortrait();
  const c = CAST[i];
  const theme = THEME[c.id];
  const name = starName(c, t.lang);
  const first = starFirst(c, t.lang);
  const scene = sceneFor(c.id, portrait);
  const profile = profileOf(c.id);
  // Korean where written (her city), else English.
  const pick = (v?: Partial<Record<string, string>>) => v && (v[t.lang] || (t.lang === 'ko' ? v.en : undefined));
  const rows = ([
    ['stars.birthday', profile.birthday && monthDayLabel(profile.birthday, t.lang)], ['stars.height', profile.height],
    ['stars.from', pick(profile.from)], ['stars.likes', pick(profile.likes)]
  ] as [Key, string | undefined][]).filter((r): r is [Key, string] => !!r[1]);
  const top = CARDS.filter((x) => x.star === c.id).sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 3);
  const voiceUrl = `/voice/greet/${c.id}-welcome.mp3`;
  const go = (k: number) => {
    const n = (k + CAST.length) % CAST.length;
    stopVoice();
    setI(n);
    nav(`/stars?star=${CAST[n].id}`, { replace: true });
  };
  useEffect(() => {
    let live = true;
    setVoice(false);
    void audioExists(voiceUrl).then((ok) => { if (live) setVoice(ok); });
    return () => { live = false; };
  }, [voiceUrl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [role="slider"]') || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <main className={`page stars${scene ? ' has-scene' : ''}`} data-star={c.id}
      style={{ '--accent': theme.accent, '--face': `${Math.round((portrait ? theme.face9 : theme.face16) * 100)}%` } as React.CSSProperties}>
      <SiteHeader />
      <div key={`v${c.id}`} className="stars-media stars-enter" aria-hidden="true">
        {scene ? <SceneVideo entry={scene} active className="stars-scene" /> : <div className="scene" style={{ background: c.tint }} />}
        <span className="stars-outline">{c.romajiFirst}</span>
      </div>
      <div className="scrim" />
      <section key={c.id} className="stars-info" aria-live="polite">
        <div className="stars-name rise-seq" style={{ '--d': 0 } as React.CSSProperties}>
          <span className="stars-romaji">{String(i + 1).padStart(2, '0')} — {c.romaji}</span>
          <h1 className="stars-h1">{name}</h1>
        </div>
        <p className="serif pre stars-line rise-seq" style={{ '--d': 1 } as React.CSSProperties}>{t(`star.${c.id}.line` as Key)}</p>
        <p className="stars-intro rise-seq" style={{ '--d': 2 } as React.CSSProperties}>{t(`star.${c.id}.intro` as Key)}</p>
        <div className="stars-actions rise-seq" style={{ '--d': 3 } as React.CSSProperties}>
          {voice && (
            <button type="button" className="btn btn-ghost voice-btn" aria-label={t('stars.voice', { name })} onClick={() => void playVoice(voiceUrl, true)}>
              <Icon name="speaker" size={18} />
            </button>
          )}
          <Link to="/trial" className="btn btn-rose magnetic" onClick={() => actions.setTrialStar(c.id)}>{t('stars.talk', { first })}</Link>
        </div>
        {rows.length > 0 && (
          <dl className="stars-profile rise-seq" style={{ '--d': 4 } as React.CSSProperties} aria-label={t('stars.profile')}>
            {rows.map(([k, v]) => <div key={k}><dt>{t(k)}</dt><dd>{v}</dd></div>)}
          </dl>
        )}
        {SIGNATURE[c.id] && <img className="stars-autograph" src={SIGNATURE[c.id]} alt={t('stars.sign')} />}
        {top.length > 0 && (
          <div className="stars-cards rise-seq" style={{ '--d': 5 } as React.CSSProperties}>
            <span className="eyebrow">{t('stars.cards', { first }).toUpperCase()}</span>
            <div className="stars-cards-row">{top.map((card) => <CardArt key={card.id} card={card} small tilt />)}</div>
          </div>
        )}
        <div className="stars-pager">
          <button type="button" className="icon-btn" aria-label={t('stars.prev')} onClick={() => go(i - 1)}><Icon name="back" /></button>
          <div className="stars-dots">
            {CAST.map((m, k) => (
              <button key={m.id} type="button" className={`stars-dot${k === i ? ' on' : ''}`} aria-label={starName(m, t.lang)} aria-current={k === i ? 'true' : undefined}
                style={{ '--accent': THEME[m.id].accent } as React.CSSProperties} onClick={() => go(k)} />
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label={t('stars.next')} onClick={() => go(i + 1)}><Icon name="chev" /></button>
        </div>
      </section>
    </main>
  );
}

// f5 / f6: v1.1 (Nest), life together and the scenes. Their lines are reviewed (#84), but the scenes play in
// production only once their clips exist (the publish rule), so production shows these two once the clips land.
const FEATURES_V10 = ['f7', 'f1', 'f2', 'f3', 'f4'] as const;
const FEATURES_V11 = [...FEATURES_V10, 'f5', 'f6'] as const;

export function Features() {
  const t = useT();
  const [i, setI] = useState(0);
  const FEATURES: readonly (typeof FEATURES_V11)[number][] = isDemo() ? FEATURES_V11 : FEATURES_V10;
  const f = FEATURES[i];
  const featureStar = CAST[i % CAST.length];
  // Until screen recordings of the app exist, each feature is shown with one of the five in her scene.
  const clip = f === 'f7' ? undefined : media(`${featureStar.id}-breath-9x16`) ?? media(`${featureStar.id}-hero-9x16`);
  return (
    <main className="page features-page">
      <SiteHeader />
      <div className="features">
        <div role="tablist" aria-label={t('nav.features')} className="underline-tabs" style={{ gridTemplateColumns: `repeat(${FEATURES.length}, minmax(0,1fr))` }}>
          {FEATURES.map((x, k) => (
            <button key={x} type="button" role="tab" id={`ft-${k}`} aria-controls="ft-panel" aria-selected={k === i} onClick={() => setI(k)}>{t(`${x}.short` as Key)}</button>
          ))}
        </div>
        {f === 'f7'
          ? <LiveFeaturePreview />
          : clip
          ? <div key={`m${f}`} className="features-media media on-dark fade-in" style={{ '--feature-face-x': featureStar.id === 'eimi' ? '82%' : '50%' } as React.CSSProperties}><SceneVideo entry={clip} active /></div>
          : <MediaSlot key={`m${f}`} className="features-media fade-in" tint="var(--mist-deep)" label={t('features.video', { v: t(`${f}.video` as Key) })} spec={t('features.slotSpec')} />}
        <section key={`s${f}`} id="ft-panel" role="tabpanel" aria-labelledby={`ft-${i}`} className="features-text stack fade-in">
          <h1 className="h1 features-title">
            {t(`${f}.title` as Key).split('\n').map((line, lineIndex) => <span key={`${lineIndex}-${line}`}>{line}</span>)}
          </h1>
          <p className="features-subtitle">
            {t(`${f}.subtitle` as Key).split('\n').map((line, lineIndex) => <span key={`${lineIndex}-${line}`}>{line}</span>)}
          </p>
          <p className="muted features-body">{t(`${f}.body` as Key)}</p>
        </section>
      </div>
      <div className="bottom features-cta"><Link to={f === 'f7' ? '/live' : '/pick'} className="btn btn-navy magnetic">{t(f === 'f7' ? 'features.liveCta' : 'features.cta')}</Link></div>
      <Footer />
    </main>
  );
}

/**
 * M9: the 150 cards, each a blurred glimpse of her art with its tier. A locked card opens a preview with the way to
 * collect it (a guest: sign up, free; a member: the draw). The heading is the page's name in his language.
 */
export function Gallery() {
  const { state } = useStore();
  const t = useT();
  const [f, setF] = useState<string>('all');
  const [peek, setPeek] = useState<CardDef | null>(null);
  const [showcase, setShowcase] = useState<CardDef | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const list = f === 'all' ? CARDS : CARDS.filter((c) => c.star === f);
  const ownedCount = Object.keys(state.owned).length;
  const close = () => { setPeek(null); opener.current?.focus(); };
  return (
    <main className="page night-page js-nightpage">
      <SiteHeader />
      <div className="gallery-wrap" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div className="pad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <div><span className="eyebrow" aria-hidden="true">FIRST FIVE</span><h1 className="h1" style={{ fontSize: 22 }}>{t('nav.cards')}</h1></div>
          <span className="small muted">{t('gallery.count', { owned: ownedCount, total: CARDS.length })}</span>
        </div>
        <div role="group" aria-label={t('gallery.filter')} style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '14px 24px 2px', scrollbarWidth: 'none' }}>
          {[{ id: 'all', label: t('gallery.all') }, ...CAST.map((c) => ({ id: c.id, label: starName(c, t.lang) }))].map((o) => (
            <button key={o.id} type="button" className="chip" aria-pressed={f === o.id} onClick={() => setF(o.id)}>{o.label}</button>
          ))}
        </div>
        <div className="cards-grid wide pad gallery-grid" style={{ marginTop: 16 }}>
          {list.map((c, k) => {
            const own = !!state.owned[c.id];
            const art = <CardArt key={`${f}-${c.id}`} card={c} locked={!own} tilt={own} className="deal" style={{ animationDelay: `${Math.min(k, 12) * 25}ms` }} />;
            return own ? (
              <button key={`${f}-${c.id}`} type="button" className="gallery-tile is-owned" aria-haspopup="dialog"
                aria-label={`${starName(getStar(c.star), t.lang)} ${c.rarity}「${t('gallery.showcase')}」`}
                onClick={() => setShowcase(c)}>{art}</button>
            ) : (
              <button key={`${f}-${c.id}`} type="button" className="gallery-tile" aria-haspopup="dialog"
                aria-label={`${starName(getStar(c.star), t.lang)} ${c.rarity}「${t('common.locked')}」`}
                onClick={(e) => { opener.current = e.currentTarget; setPeek(c); }}>{art}</button>
            );
          })}
        </div>
        <div className="bottom stack" style={{ gap: 8, maxWidth: 420, width: '100%', alignSelf: 'center' }}>
          <Link to="/gacha" className="btn btn-rose">{t('gallery.cta')}</Link>
          <p className="tiny muted" style={{ textAlign: 'center', margin: 0 }}>{t('gallery.note')}</p>
        </div>
        <div className="gallery-back-top-row">
          <button
            type="button"
            className="gallery-back-top"
            aria-label={t('home.backTop')}
            onClick={() => window.scrollTo({
              top: 0,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            })}
          >
            <Icon name="back" size={17} />
            <span aria-hidden="true">TOP</span>
          </button>
        </div>
      </div>
      <Footer />
      {peek && <CardPeek card={peek} member={!!state.user} onClose={close} />}
      {showcase && <CardShowcase card={showcase} onClose={() => setShowcase(null)} />}
    </main>
  );
}

function CardPeek({ card, member, onClose }: { card: CardDef; member: boolean; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The A2 night sheet of her notification offer and gifts (gift.css), with the card beside the way to it; A-N4: a modal
  // centred over the dimmed gallery at every size (site.css .peek-wrap), never pinned over the heading.
  return (
    <div className="gift-backdrop peek-wrap" role="presentation" onClick={onClose}>
      <div ref={ref} className="panel gift-sheet peek-sheet" role="dialog" aria-modal="true" aria-labelledby="peek-h" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="gift-head">
          <h2 id="peek-h"><span className={`badge r-${card.rarity}`}>{card.rarity}</span> {starName(getStar(card.star), t.lang)}</h2>
          <button type="button" className="round" onClick={onClose} aria-label={t('common.close')}><Icon name="close" size={18} /></button>
        </div>
        <div className="peek">
          <div className="peek-card"><CardArt card={card} locked /></div>
          <div className="stack">
            <p className="small" style={{ margin: 0, color: 'var(--iv-meta)' }}>{t(member ? 'gallery.note' : 'gallery.preview')}</p>
            <Link to={member ? '/gacha' : '/signup?next=/gacha'} className="btn btn-rose">{t(member ? 'gallery.cta' : 'gallery.join')}</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Events() {
  const t = useT();
  const { state } = useStore();
  // #61: from the shared calendar — her birthdays, the seasons, and their anniversaries he has — never fixed dates.
  const events = upcomingEvents(new Date(), { anniversaries: Object.fromEntries(Object.entries(state.relView).map(([id, v]) => [id, v?.anniversary ?? null])) });
  return (
    <main className="page night-page events-page">
      <SiteHeader />
      <ul className="events-list">
        {events.map((e, k) => {
          const st = eventStatus(e);
          const previewStar = e.star ?? CAST[k % CAST.length].id;
          const preview = sceneFor(previewStar, false) ?? media(`${previewStar}-hero-16x9`);
          return (
            <li key={e.id}>
              <article style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <MediaSlot tint={e.tint} label={t('events.banner')} spec="1029×390" src={stillOf(preview, true)} style={{ aspectRatio: '1029 / 390', borderRadius: 2 }}>
                  <span className={`badge ${EVENT_BADGE[st].cls}`} data-testid={`event-status-${e.id}`} data-status={st} style={{ position: 'absolute', left: 0, top: 10, fontSize: 11, padding: '3px 10px' }}>{t(EVENT_BADGE[st].key)}</span>
                </MediaSlot>
                <h2 className="serif" style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.5 }}>{localText(e.title, t.lang)}</h2>
                <span className="small muted">{st === 'soon' ? t('ev.soonDate', { date: fmtDate(e.startsAt, t.lang) }) : t('gacha.period', { from: fmtDate(e.startsAt, t.lang), to: fmtDate(e.endsAt, t.lang) })}</span>
              </article>
            </li>
          );
        })}
      </ul>
      <Footer />
    </main>
  );
}

export function NotFound() {
  const t = useT();
  return (
    <main className="page night-page js-nightpage" style={{ minHeight: '100dvh' }}>
      <SiteHeader />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center' }}>
        <span className="eyebrow" aria-hidden="true">404</span>
        <h1 className="h1">{t('nf.title')}</h1>
        <p className="small muted" style={{ margin: 0 }}>{t('nf.body')}</p>
        <Link to="/" className="btn btn-rose" style={{ width: '100%', maxWidth: 360 }}>{t('nf.cta')}</Link>
      </div>
      <Footer />
    </main>
  );
}
