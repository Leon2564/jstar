import { localText } from '@jstar/shared/domain';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CAST, getStar } from '../data/cast';
import { loaderEntry } from '../data/heroMedia';
import { eventStatus, useEvents } from '../data/events';
import { starFirst, starName, verticalName, type Key, fmtDate } from '../i18n';
import { safeNext } from '../lib/safeNext';
import { isStandalone } from '../lib/push';
import { playVoice, sfx } from '../lib/sound';
import type { MediaEntry } from '../data/media.gen';
import { useStore, useT } from '../lib/store';
import { Icon, LangSelect, MediaSlot, SiteHeader } from '../components/ui';
import { SceneVideo, media, mediaFor, motionAllowed, sceneFor, sourcesFor, stillOf, useParallax } from '../components/stage';
import { faceBox, heroTarget, placeFace } from '../components/heroLayout';
import { reactionKeysFor } from '../data/reactions';
import { EIMI_BONUS_CARD_ID, EIMI_BONUS_REACTIONS, eimiBonusEnter, eimiBonusIdle, eimiBonusReaction, hasEimiBonusCard } from '../data/eimiBonusMedia';

export { sceneFor };

const StarField = lazy(() => import('../components/starfield'));
// Everything below the first screen is its own chunk: the hero paints from the entry bundle alone.
const HomeSections = lazy(() => import('../components/home'));
const PvLightbox = lazy(() => import('../components/pv'));
const InstallHint = lazy(() => import('../components/installHint'));

const ROTATE_MS = 12000;
const CLIP_DISSOLVE_MS = 480;
const TOUCH_HINT_DELAY_MS = 8000;

function useReducedMotion() {
  return useMemo(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
}

export function AgeGate() {
  const { actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  // Polish: a "No" holds for this visit (a reload does not offer the gate again as if nothing was said).
  const [declined, setDeclined] = useState(() => { try { return sessionStorage.getItem('jstar.ageNo') === '1'; } catch { return false; } });
  const next = safeNext(new URLSearchParams(loc.search).get('next'), '/');
  const night = media('loading-stars');
  return (
    <main className={`page${night ? ' night-host' : ''}`} style={{ background: 'var(--navy-deep)', alignItems: 'center', justifyContent: 'center', padding: 24, minHeight: '100dvh' }}>
      {night && <SceneVideo entry={night} active className="night-bg" />}
      <section aria-labelledby="age-title" className="panel stack" style={{ width: '100%', maxWidth: 380, alignItems: 'center', textAlign: 'center', gap: 18, padding: '36px 28px 28px' }}>
        <div className="brand" style={{ fontSize: 16, padding: 0 }}><Icon name="spark" size={14} />JSTAR</div>
        <h1 id="age-title" className="h1" style={{ fontSize: 22 }}>{t('age.title')}</h1>
        <p className="small muted" style={{ margin: 0, fontSize: 13 }}>{t('age.body')}</p>
        {declined ? (
          <p className="err" role="alert">{t('age.declined')}</p>
        ) : (
          <div className="stack" style={{ width: '100%' }}>
            <button type="button" className="btn btn-navy" onClick={() => { actions.confirmAge(); nav(`/loading?next=${encodeURIComponent(next)}`, { replace: true }); }}>{t('age.yes')}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setDeclined(true); try { sessionStorage.setItem('jstar.ageNo', '1'); } catch { /* storage blocked */ } }}>{t('age.no')}</button>
          </div>
        )}
        <p className="tiny muted" style={{ margin: 0 }}>{t('age.dob')}</p>
        <LangSelect />
      </section>
    </main>
  );
}

/** The brand ring: circular text turning around a real percentage (恋与深空-style loader). */
export function LoaderRing({ pct }: { pct: number }) {
  return (
    <span className="ring" aria-hidden="true">
      <svg viewBox="0 0 200 200">
        <defs><path id="ring-path" d="M100,100 m-82,0 a82,82 0 1,1 164,0 a82,82 0 1,1 -164,0" /></defs>
        <circle className="ring-track" cx="100" cy="100" r="66" />
        <circle className="ring-arc" cx="100" cy="100" r="66" style={{ strokeDashoffset: 415 * (1 - pct / 100) }} />
        <g className="ring-spin"><text><textPath href="#ring-path" textLength="510">JSTAR · STAR GENESIS · FIRST FIVE · JSTAR · STAR GENESIS · FIRST FIVE ·</textPath></text></g>
      </svg>
      <span className="ring-pct">{pct}<small>%</small></span>
    </span>
  );
}

type Reaction = { key: number; star: string; clip: MediaEntry };
type HeroTouchZone = 'eyes' | 'lips' | 'shoulder' | 'heart';
type TouchPoint = { id: HeroTouchZone; x: number; y: number };

/** Art-directed desktop points, stored as fractions of the homepage stage for each supplied master. */
const DESKTOP_TOUCH_LAYOUT: Record<string, TouchPoint[]> = {
  mahiro: [
    { id: 'eyes', x: 0.647, y: 0.233 }, { id: 'lips', x: 0.656, y: 0.575 },
    { id: 'shoulder', x: 0.492, y: 0.632 }, { id: 'heart', x: 0.622, y: 0.852 }
  ],
  nana: [
    { id: 'eyes', x: 0.536, y: 0.174 }, { id: 'lips', x: 0.534, y: 0.47 },
    { id: 'shoulder', x: 0.416, y: 0.734 }, { id: 'heart', x: 0.696, y: 0.697 }
  ],
  unpai: [
    { id: 'eyes', x: 0.678, y: 0.293 }, { id: 'lips', x: 0.834, y: 0.51 },
    { id: 'shoulder', x: 0.616, y: 0.706 }, { id: 'heart', x: 0.75, y: 0.773 }
  ],
  alice: [
    { id: 'eyes', x: 0.615, y: 0.19 }, { id: 'lips', x: 0.56, y: 0.44 },
    { id: 'shoulder', x: 0.4, y: 0.6 }, { id: 'heart', x: 0.63, y: 0.75 }
  ],
  eimi: [
    { id: 'eyes', x: 0.66, y: 0.16 }, { id: 'lips', x: 0.697, y: 0.47 },
    { id: 'shoulder', x: 0.55, y: 0.605 }, { id: 'heart', x: 0.822, y: 0.72 }
  ]
};

/**
 * Her on the stage. With an entrance clip for her (`<star>-enter-*`) it plays once and hands over to the hero loop
 * on its last frame (the entrance ends on the hero keyframe); a reaction clip crossfades over the loop and back.
 * Required entrances prime the loop underneath and hold its decoded first frame until the entrance releases it.
 */
const entranceFor = (id: string, portrait: boolean) =>
  id === 'eimi' || id === 'nana' || id === 'unpai' ? media(`${id}-enter-16x9`) : mediaFor(`${id}-enter`, portrait);

function HeroClip({ id, portrait, crop, enterCrop, phase, active, reaction, bonus, onReactionEnd, onSettled }: {
  id: string; portrait: boolean; crop: { ox: number; oy: number }; enterCrop: { ox: number; oy: number }; phase: 'enter' | 'leave'; active: boolean; reaction: Reaction | null; bonus: boolean; onReactionEnd: () => void; onSettled: (id: string | null) => void;
}) {
  const hero = bonus ? eimiBonusIdle() : sceneFor(id, portrait);
  const enter = bonus ? eimiBonusEnter() : entranceFor(id, portrait);
  // Her supplied entrance is the first chapter of the homepage presentation, not decorative motion: it must play
  // before the idle loop even when the browser asks ordinary ambient animation to stand still.
  const requiredEntrance = id === 'eimi' || id === 'alice' || id === 'mahiro' || id === 'nana' || id === 'unpai';
  // Mahiro's entrance and idle share an entrance-frame poster. Start the primed idle under the entrance, suppress
  // that poster, and release the entrance only after the idle has produced a real playback frame.
  const seamlessEntrance = bonus || id === 'mahiro';
  const [entering, setEntering] = useState(() => phase === 'enter' && !!enter && (requiredEntrance || motionAllowed()));
  const [entranceEnded, setEntranceEnded] = useState(false);
  const [idleReady, setIdleReady] = useState(false);
  const [idlePlaybackReady, setIdlePlaybackReady] = useState(false);
  const [idleCycle, setIdleCycle] = useState(0);
  const [enterLeaving, setEnterLeaving] = useState(false);
  const [reactionLeaving, setReactionLeaving] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
  }, []);
  useEffect(() => {
    setReactionLeaving(false);
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    reactionTimer.current = null;
  }, [reaction?.key]);
  const finishEntrance = useCallback(() => setEntranceEnded(true), []);
  const finishEntranceHandoff = useCallback(() => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = null;
    setEntering(false);
    setEntranceEnded(false);
    setEnterLeaving(false);
  }, []);
  // Keep the entrance's last clean frame in place until the idle clip has a decoded first frame. A short fallback
  // still lets the poster take over if a browser cannot decode the loop at all.
  useEffect(() => {
    if (!entranceEnded || enterTimer.current || (enterLeaving && !seamlessEntrance)) return;
    if (!idleReady) {
      const fallback = setTimeout(() => setIdleReady(true), 1_200);
      return () => clearTimeout(fallback);
    }
    // Standard heroine entrances use a primed dissolve. Matched suites keep the entrance fully opaque while the
    // primed idle starts underneath, then cut only after the browser confirms its first playback frame.
    if (seamlessEntrance && !enterLeaving) {
      setEnterLeaving(true);
      return;
    }
    if (seamlessEntrance && !idlePlaybackReady) return;
    if (seamlessEntrance) {
      finishEntranceHandoff();
      return;
    }
    setEnterLeaving(true);
    enterTimer.current = setTimeout(() => {
      finishEntranceHandoff();
    }, CLIP_DISSOLVE_MS);
  }, [entranceEnded, enterLeaving, finishEntranceHandoff, idlePlaybackReady, idleReady, seamlessEntrance]);
  const finishReaction = useCallback(() => {
    if (reactionLeaving || reactionTimer.current) return;
    setReactionLeaving(true);
    reactionTimer.current = setTimeout(() => {
      reactionTimer.current = null;
      setReactionLeaving(false);
      setIdleCycle((cycle) => cycle + 1);
      onReactionEnd();
    }, CLIP_DISSOLVE_MS);
  }, [onReactionEnd, reactionLeaving]);
  // A-H2: she is settled once her entrance has ended (at once without one); while it plays (her moving toward the
  // camera, after a switch or the rotation) nothing is, so 「點點她」 waits for her face to stop in its box.
  useEffect(() => { if (phase === 'enter') onSettled(entering ? null : id); }, [entering, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hero) return <div className={`scene scene-tint depth-${phase}`} style={{ background: getStar(id).tint }} />;
  const cropStyle = { '--ox': `${(crop.ox * 100).toFixed(1)}%`, '--oy': `${(crop.oy * 100).toFixed(1)}%` } as React.CSSProperties;
  const enterStyle = { '--ox': `${(enterCrop.ox * 100).toFixed(1)}%`, '--oy': `${(enterCrop.oy * 100).toFixed(1)}%` } as React.CSSProperties;
  // Mahiro's phone presentation must use the idle composition for every layer: the interaction map is measured from
  // that frame, and applying the entrance measurement to her close idle master shifts both her and the hit areas apart.
  // The other landscape phone masters retain their entrance composition across the hand-off.
  const mahiroPhoneStyle = id === 'mahiro' && portrait ? cropStyle : null;
  const presentationStyle = mahiroPhoneStyle
    ?? ((id === 'alice' || id === 'nana' || id === 'unpai') && portrait && enter ? enterStyle : cropStyle);
  const entranceStyle = mahiroPhoneStyle ?? enterStyle;
  const primeIdle = requiredEntrance && entering && !!enter;
  return (
    <div className={`hero-clip depth-${phase}${entering ? ' is-entering' : ''}`} style={presentationStyle}>
      {(!entering || !enter || primeIdle) && (
        <SceneVideo key={`h-${hero.id}`} entry={hero} active={active} hold={primeIdle && !enterLeaving} restartAt={idleCycle}
          className={primeIdle && seamlessEntrance ? 'seamless-idle' : undefined}
          onReady={primeIdle ? () => setIdleReady(true) : undefined}
          onPlaybackFrame={primeIdle && seamlessEntrance ? () => setIdlePlaybackReady(true) : undefined}
          hidePoster={id === 'mahiro' && primeIdle}
          waitPoster={!primeIdle} cover />
      )}
      {entering && enter && (
        <SceneVideo key="enter" entry={enter} active={active} loop={false} onDone={finishEntrance} requiredPlayback={requiredEntrance}
          className={`enter-clip${enterLeaving && !seamlessEntrance ? ' is-dissolving' : ''}`} style={entranceStyle} waitPoster cover />
      )}
      {reaction && phase === 'enter' && !entering && (
        <SceneVideo key={reaction.key} entry={reaction.clip} active={active} loop={false} onDone={finishReaction}
          className={`react-clip${reactionLeaving ? ' is-dissolving' : ''}`} />
      )}
    </div>
  );
}

/**
 * Brand loading screen: the starry night, one of the five saying hello, a hairline progress.
 * It fades out into a stage that is already playing (the first hero poster is preloaded in index.html).
 */
export function Loading() {
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  const next = safeNext(new URLSearchParams(loc.search).get('next'), '/');
  const star = useMemo(() => CAST[Math.floor(Math.random() * CAST.length)], []);
  const night = media('loading-stars');
  const [pct, setPct] = useState(0);
  // The percentage is real: the home's first poster (45), her first clip able to play (40) and the fonts (15),
  // fetched here with the URLs the stage will use, so the stage opens already playing. Never longer than 4.5 s.
  useEffect(() => {
    const t0 = performance.now();
    let fonts = !document.fonts;
    void document.fonts?.ready.then(() => { fonts = true; });
    const e = next === '/' ? loaderEntry(window.matchMedia?.('(orientation: portrait)').matches ?? true) : undefined;
    let poster = !e;
    let video = !e || !motionAllowed();
    if (e) {
      const img = new Image();
      if (e.posters) { img.sizes = '100vw'; img.srcset = e.posters.map((q) => q.src + ' ' + q.width + 'w').join(', '); }
      img.onload = img.onerror = () => { poster = true; };
      img.src = e.poster;
      const src = video ? undefined : sourcesFor(e)[0]?.src;
      if (src) {
        const v = document.createElement('video');
        v.muted = true; v.preload = 'auto';
        v.oncanplay = v.onerror = () => { video = true; };
        v.src = src; v.load();
      } else video = true;
    }
    let shown = 0;
    const id = setInterval(() => {
      const el = performance.now() - t0;
      const target = el > 4500 ? 100 : (poster ? 45 : 0) + (video || el > 2600 ? 40 : 0) + (fonts ? 15 : 0);
      const to = Math.min(target, Math.round(el / 9), shown + Math.max(1, Math.round((target - shown) / 3)));
      if (to !== shown) { shown = to; setPct(to); }
    }, 60);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pct >= 100) nav(next, { replace: true }); }, [pct, nav, next]);
  return (
    <main className={`page loading${night ? ' night-host is-night' : ''}`} style={{ alignItems: 'center', justifyContent: 'center', gap: 26, minHeight: '100dvh', position: 'relative' }}>
      {night && <SceneVideo entry={night} active className="night-bg" />}
      <Icon name="spark" size={22} />
      <p className="serif" style={{ margin: 0, fontSize: 26, letterSpacing: '0.12em', opacity: Math.min(1, pct / 25), transition: 'opacity .2s' }}>{t(`star.${star.id}.loading` as Key)}</p>
      <p className="tiny muted" style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="speaker" size={16} />{t('loading.voice', { name: starName(star, t.lang) })}</p>
      <div role="progressbar" aria-label={t('loading.label')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <LoaderRing pct={pct} />
      </div>
      <Link to={next} replace className="btn-text" style={{ position: 'absolute', right: 16, bottom: 20, display: 'flex', alignItems: 'center', padding: '0 12px', textDecoration: 'none' }}>{t('loading.skip')}</Link>
    </main>
  );
}

const SWITCH_LOCK_MS = 900;
const PAGE_LOCK_MS = 950;

/** The home page's full-screen sections, in order; `#/?s=<id>` deep-links to one. */
export const SECTIONS = ['hero', 'stars', 'how', 'cards', 'news'] as const;
const SECTION_NAV: Key[] = ['nav.home', 'nav.stars', 'nav.features', 'nav.cards', 'nav.events'];
/** Dark CG sections and light "system UI" sections alternate, as in the reference; the header follows. */
const LIGHT = new Set<string>(['how', 'news']);

export function Top() {
  const { state, actions } = useStore();
  const t = useT();
  const events = useEvents();
  const reduced = useReducedMotion();
  const nav = useNavigate();
  const loc = useLocation();
  const stageRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  // The first screen's own size (it is one screen tall): her clip's ratio and where her face goes follow it.
  const [size, setSize] = useState(() => ({ w: typeof window !== 'undefined' ? window.innerWidth : 1280, h: typeof window !== 'undefined' ? window.innerHeight : 800 }));
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const w = el.clientWidth, h = el.clientHeight; if (w && h) setSize((o) => (o.w === w && o.h === h ? o : { w, h })); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The clip that shows most of the frame: 9:16 on a screen taller than wide, 16:9 otherwise.
  const portrait = size.h >= size.w;
  // Pointer / device tilt drives every layer of the page (stage and section backdrops), so it reads as one space.
  const tilt = useParallax(rootRef, !reduced);
  const [i, setI] = useState(0);
  // A-L (slow 4G LCP): her first name and line are there on first paint — no fade that holds the page's largest text
  // back; the next star's fade in as before.
  const [firstStar] = useState(() => i);
  const [rotated, setRotated] = useState(false);
  if (!rotated && i !== firstStar) setRotated(true);
  const firstFade = rotated ? ' fade-in' : '';
  const [settled, setSettled] = useState<string | null>(null);
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [bubble, setBubble] = useState<{ key: number; text: string } | null>(null);
  const [pulse, setPulse] = useState<{ key: number; x: number; y: number } | null>(null);
  const [touchHintsVisible, setTouchHintsVisible] = useState(false);
  const [touchHintCycle, setTouchHintCycle] = useState(0);
  const zoneTaps = useRef<Record<HeroTouchZone, number>>({ eyes: 0, lips: 0, shoulder: 0, heart: 0 });
  const cool = useRef(0);
  const kick = useRef<HTMLDivElement>(null);
  const [wait, setWait] = useState(0);
  const [held, setHeld] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [pv, setPv] = useState(false);
  const [serialPeek, setSerialPeek] = useState(true);
  const [showBackTop, setShowBackTop] = useState(false);
  const initial = useMemo(() => Math.max(0, SECTIONS.indexOf(new URLSearchParams(loc.search).get('s') as typeof SECTIONS[number])), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sec, setSec] = useState(initial);
  const [ready, setReady] = useState(false);
  const secRef = useRef(sec);
  secRef.current = sec;
  const lock = useRef(0);
  const pageLock = useRef(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = (step: number) => {
    const now = Date.now();
    if (now < lock.current) return;
    lock.current = now + SWITCH_LOCK_MS;
    setAutoRotate(false);
    setI((x) => (x + step + CAST.length) % CAST.length);
  };
  const sections = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-fp]') ?? [])];
  const pageTo = useCallback((to: number, smooth = true) => {
    const list = sections();
    const el = list[to];
    if (!el) return false;
    pageLock.current = Date.now() + PAGE_LOCK_MS;
    el.scrollIntoView({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
    return true;
  }, [reduced]);

  // One timer drives the rotation; progress and fades are pure CSS (no per-frame re-render).
  // It holds while the visitor is reading or choosing, while the PV plays, and once the hero is scrolled away.
  // The next talent's poster is fetched during this slot (same srcset, so the stage's <img> reuses it), and the
  // switch waits for it: on a slow phone network she never arrives as an empty navy screen.
  useEffect(() => {
    if (!autoRotate || reduced || held || pv || sec !== 0 || bubble || settled !== CAST[i].id) return;
    const next = sceneFor(CAST[(i + 1) % CAST.length].id, portrait);
    const img = new Image();
    if (next) {
      img.sizes = next.posters ? '100vw' : '';
      if (next.posters) img.srcset = next.posters.map((p) => `${p.src} ${p.width}w`).join(', ');
      img.src = next.poster;
    }
    let done = false;
    const advance = () => { if (!done) { done = true; setI((x) => (x + 1) % CAST.length); } };
    const id = setTimeout(() => {
      if (document.hidden) setWait((w) => w + 1);
      else if (!next || img.complete) advance();
      else { img.onload = advance; img.onerror = advance; }
    }, ROTATE_MS);
    return () => { done = true; clearTimeout(id); img.onload = null; img.onerror = null; };
  }, [i, wait, autoRotate, reduced, held, pv, sec, portrait, bubble, settled]);

  // Keyboard: ←/→ switch the talent on the first screen; ↓/↑, PageDown/PageUp, Space, Home/End page the sections.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (pv || el?.closest?.('input, textarea, select, [contenteditable], [role="slider"]') || e.altKey || e.metaKey || e.ctrlKey) return;
      const s = secRef.current;
      if (e.key === 'ArrowRight' && s === 0) { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' && s === 0) { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === ' ' && !el?.closest?.('button, a'))) { if (pageTo(s + 1)) e.preventDefault(); }
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') { if (pageTo(s - 1)) e.preventDefault(); }
      else if (e.key === 'Home') { if (pageTo(0)) e.preventDefault(); }
      else if (e.key === 'End') { if (pageTo(SECTIONS.length - 1)) e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pv, pageTo]);

  // Wheel: one notch = one screen (desktop). A section taller than the screen scrolls normally to its edge,
  // and past the last section the footer scrolls natively. Touch keeps native scrolling with CSS snap.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (pv || e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      const list = sections();
      const cur = list[secRef.current];
      const target = secRef.current + dir;
      if (!cur || !list[target]) return;
      const r = cur.getBoundingClientRect();
      if ((dir > 0 && r.bottom > window.innerHeight + 2) || (dir < 0 && r.top < -2)) return;
      e.preventDefault();
      if (Math.abs(e.deltaY) < 6 || Date.now() < pageLock.current) return;
      pageTo(target);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [pv, pageTo]);

  // Which section is on screen: drives the entrance animations (.in), the header tone, the dots and the URL.
  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return;
    const list = sections();
    let live = true;
    const ratios = new Map<Element, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        ratios.set(e.target, e.intersectionRatio);
        e.target.classList.toggle('in', e.intersectionRatio > 0.28);
      }
      let best = 0; let bestR = -1;
      list.forEach((el, k) => { const r = ratios.get(el) ?? 0; if (r > bestR) { best = k; bestR = r; } });
      if (bestR > 0 && best !== secRef.current) {
        sfx('whoosh');
        setSec(best);
        // Only while the home page is still the route: a late callback must never pull the visitor back from a link.
        if (live && /^#\/?(\?|$)/.test(window.location.hash || '#/')) nav(best ? `/?s=${SECTIONS[best]}` : '/', { replace: true });
      }
    }, { threshold: [0, 0.3, 0.55, 0.8, 1] });
    list.forEach((el) => io.observe(el));
    if (initial > 0) pageTo(initial, false);
    return () => { live = false; io.disconnect(); };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // On a short phone the first screen is taller than the viewport: once it is scrolled at all, the header gets its
  // backing so her name never slides under the logo. Written straight to the DOM (no re-render per scroll).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sync = () => root.toggleAttribute('data-scrolled', window.scrollY > 8);
    sync();
    window.addEventListener('scroll', sync, { passive: true });
    return () => window.removeEventListener('scroll', sync);
  }, []);

  // Snap to screens while the home page is open (the rest of the site scrolls freely).
  useEffect(() => {
    document.documentElement.classList.add('fp-snap');
    return () => document.documentElement.classList.remove('fp-snap');
  }, []);

  // The footer closes the home journey. When it enters view, offer a calm one-tap return to the hero.
  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return;
    const footer = rootRef.current?.querySelector<HTMLElement>('.site-foot');
    if (!footer) return;
    const io = new IntersectionObserver(([entry]) => setShowBackTop(entry.isIntersecting), { threshold: 0.2 });
    io.observe(footer);
    return () => io.disconnect();
  }, [ready]);

  // The home page is the brand's front door for everyone; members enter her room from here (never redirected away).
  const member = !!state.user;
  const c = CAST[i];
  const eimiBonus = c.id === 'eimi' && state.selectedCards.eimi === EIMI_BONUS_CARD_ID && hasEimiBonusCard(state.owned);
  useEffect(() => {
    setReaction(null);
    setBubble(null);
    setPulse(null);
  }, [c.id]);
  const vertical = verticalName(t.lang);
  const talent = media(`${c.id}-breath-9x16`);
  const stageScene = eimiBonus ? eimiBonusIdle() : sceneFor(c.id, portrait);
  const anyScene = !!stageScene;
  // When she is already in the scene, the separate talent frame would show her twice.
  const inScene = stageScene?.category === 'character';
  // Running or coming up (from the dates, N-11): an ended event leaves the top's news.
  const live = events.filter((e) => eventStatus(e) !== 'ended').slice(0, 2);
  const tone = LIGHT.has(SECTIONS[sec]) ? 'light' : 'dark';
  const first = starFirst(c, t.lang);
  // Her face on this screen (H1): the clip's crop comes from her measured face box, so her face sits in the band the
  // copy leaves free (right of the copy on a desktop, right of her name on a phone), never under the 序號 tab.
  const { w: vw, h: vh } = size;
  const SCALE = 1.06; // .l-scene's zoom (parallax headroom)
  const placeEntry = (e: ReturnType<typeof sceneFor>) => {
    const ratio = e?.ratio ?? '9:16';
    const fb = faceBox(e?.id, ratio);
    const dispW = Math.max(vw, vh * (ratio === '16:9' ? 16 / 9 : 9 / 16)) * SCALE;
    const aim = heroTarget(vw, vh, (fb[2] - fb[0]) * dispW);
    return placeFace(fb, ratio, vw, vh, aim.tx, aim.ty, SCALE);
  };
  const placeOf = (id: string) => placeEntry(id === 'eimi' && eimiBonus ? eimiBonusIdle() : sceneFor(id, portrait));
  const enterPlaceOf = (id: string) => placeEntry(id === 'eimi' && eimiBonus ? eimiBonusEnter() : entranceFor(id, portrait));
  const place = placeOf(c.id);
  const [fl, ft, fr, fbot] = place.box;
  const fcx = (fl + fr) / 2, fcy = (ft + fbot) / 2;
  const faceW = fr - fl, faceH = fbot - ft;
  const desk = vw >= 1024;
  // Desktop compositions share one art-directed interaction map: eye, lips, exposed shoulder and necklace/chest.
  // This is intentionally viewport-based rather than face-detection-based because the close-up masters contain hair,
  // hands and soft focus that make their generated face boxes drift. Compact layouts still follow the measured face
  // because their crop changes substantially between portrait phones and short landscape screens.
  const touchSize = Math.min(112, Math.max(72, Math.min(vw, vh) * 0.095));
  const rawTouchZones: TouchPoint[] = desk
    ? (DESKTOP_TOUCH_LAYOUT[c.id] ?? DESKTOP_TOUCH_LAYOUT.alice).map((point) => ({ ...point, x: point.x * vw, y: point.y * vh }))
    : [
        { id: 'eyes', x: fl + faceW * 0.66, y: ft + faceH * 0.22 },
        { id: 'lips', x: fl + faceW * 0.42, y: ft + faceH * 0.72 },
        { id: 'shoulder', x: fl - faceW * 0.32, y: ft + faceH * 1.08 },
        { id: 'heart', x: fl + faceW * 0.68, y: ft + faceH * 1.38 }
      ];
  const touchEdge = touchSize / 2 + 8;
  const touchZones = rawTouchZones.map((point) => ({
    ...point,
    x: Math.min(vw - touchEdge, Math.max(touchEdge, point.x)),
    y: Math.min(vh - touchEdge, Math.max(touchEdge, point.y))
  }));
  useEffect(() => {
    if (desk || !serialPeek) return;
    const id = window.setTimeout(() => setSerialPeek(false), 4_000);
    return () => window.clearTimeout(id);
  }, [desk, serialPeek]);
  // On a desktop her words occupy the quiet band between the name and the portrait. On compact screens they stay
  // below her face, where the responsive copy layout already reserves room.
  const sayStyle: React.CSSProperties = desk
    ? { left: 'clamp(250px, 24.5vw, 500px)', top: 'clamp(230px, 29.5vh, 315px)', width: 'min(310px, 18vw)', maxWidth: 310, transform: 'none' }
    : { left: Math.min(Math.max(16, fcx - 140), vw - 296), top: fbot + 10, maxWidth: Math.min(280, vw - 32), transform: 'none' };
  const world = mediaFor(`${c.id}-night`, portrait);

  // The interaction map stays invisible while she is being used. After a quiet pause, all four points fade in as
  // soft circles; any touch hides them and starts a fresh inactivity window.
  useEffect(() => {
    setTouchHintsVisible(false);
    if (!inScene || sec !== 0 || pv || settled !== c.id) return;
    const id = window.setTimeout(() => setTouchHintsVisible(true), TOUCH_HINT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [c.id, inScene, pv, sec, settled, touchHintCycle]);

  // L15: a guest on a phone, a while into the home, is offered the home screen once (components/installHint.tsx).
  const [askInstall, setAskInstall] = useState(false);
  useEffect(() => {
    const w = window as unknown as { __E2E__?: boolean; __E2E_INSTALL__?: number };
    let seen = true;
    try { seen = !!localStorage.getItem('jstar.installHint'); } catch { /* storage blocked: never nag */ }
    if (member || seen || isStandalone() || !window.matchMedia?.('(pointer: coarse)').matches || (w.__E2E__ && !w.__E2E_INSTALL__)) return;
    const id = setTimeout(() => setAskInstall(true), w.__E2E_INSTALL__ ?? 20_000);
    return () => clearTimeout(id);
  }, [member]);

  // Her lines are a small lazy chunk: fetch it once the stage has settled, so the first tap shows her words at once
  // (waiting for it on the tap left a seconds-long gap on a slow connection).
  useEffect(() => { const id = setTimeout(() => { void import('../components/voiceLines'); }, 1500); return () => clearTimeout(id); }, []);

  /** Tap her: a reaction clip when there is one (else a small push-in and a light), her voice, and her words beside her. */
  async function tapHer(zone: HeroTouchZone, x: number, y: number) {
    const now = Date.now();
    if (now < cool.current) return;
    cool.current = now + 3200;
    setTouchHintsVisible(false);
    setTouchHintCycle((cycle) => cycle + 1);
    const clips = eimiBonus
      ? EIMI_BONUS_REACTIONS.map(eimiBonusReaction)
      : reactionKeysFor(c.id).map((k) => mediaFor(`${c.id}-react-${k}`, portrait)).filter((x): x is MediaEntry => !!x);
    const zoneOffset = ({ eyes: 0, lips: 1, shoulder: 2, heart: 3 } as const)[zone];
    const zoneN = zoneTaps.current[zone]++;
    if (clips.length && motionAllowed()) setReaction({ key: now, star: c.id, clip: clips[(zoneN * 4 + zoneOffset) % clips.length] });
    else if (motionAllowed()) kick.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.045)' }, { transform: 'scale(1)' }], { duration: 900, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    setPulse({ key: now, x, y });
    const star = c.id;
    const v = await import('../components/voiceLines');
    const slot = v.slotForZone(zone, zoneN);
    setBubble({ key: now, text: v.lineFor(star, slot, t.lang) });
    void playVoice(v.voiceUrl(star, slot));
    setTimeout(() => setBubble((b) => (b?.key === now ? null : b)), 5200);
  }

  return (
    <main ref={rootRef} className="home-fp" data-tone={tone} data-sec={SECTIONS[sec]}>
      <SiteHeader cta={sec > 0} />
      <section ref={stageRef} id="fp-hero" data-fp="0" aria-label={t('nav.home')}
        className={`top stage in${anyScene ? ' has-scene' : ''}${inScene ? ' in-scene' : ''}`} data-star={c.id}
        onPointerDown={() => setAutoRotate(false)}
        onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={(e) => {
          const s = touch.current; touch.current = null;
          if (!s || (e.target as HTMLElement).closest('a, input, nav, button:not(.tap-her)')) return;
          const dx = e.changedTouches[0].clientX - s.x; const dy = e.changedTouches[0].clientY - s.y;
          // Sideways swipes change the talent; vertical swipes scroll to the next screen natively.
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.2) go(dx < 0 ? 1 : -1);
        }}>
        {/* Camera rig: tilt (parallax) → push (section change) → drift (idle) → layers at different depths. */}
        <div className="stage-cam" aria-hidden="true">
          <div className="stage-push">
            <div className="stage-drift">
              <div className="stage-layer l-world">
                {world && <img key={world.id} className="world-img" src={stillOf(world)} alt="" decoding="async" draggable={false} />}
              </div>
              <div className="stage-layer l-scene">
                <div ref={kick} className="hero-kick">
                  <HeroClip key={`${c.id}-${eimiBonus ? EIMI_BONUS_CARD_ID : 'base'}`} id={c.id} portrait={portrait} crop={placeOf(c.id)} enterCrop={enterPlaceOf(c.id)} phase="enter" active={sec === 0 && !pv} bonus={eimiBonus}
                    reaction={reaction?.star === c.id ? reaction : null} onReactionEnd={() => setReaction(null)} onSettled={setSettled} />
                </div>
              </div>
              <div className="stage-layer l-front">
                <i className="rays" />
                <i key={`f${i}`} className="push-flash" style={{ left: fcx, top: fcy }} />
                {pulse && <i key={`p${pulse.key}`} className="tap-pulse" style={{ left: pulse.x, top: pulse.y }} />}
              </div>
            </div>
          </div>
        </div>
        {anyScene && <Suspense fallback={null}><StarField tilt={tilt} bokeh className="stage-layer l-stars" /></Suspense>}
        {!inScene && <div className="stage-layer l-talent">
          <div key={c.id} className="talent-frame depth-enter">
            {talent
              ? <SceneVideo entry={talent} active className="talent-video" />
              : <MediaSlot className="talent-slot" tint="transparent" label={t('top.slot', { name: starName(c, t.lang) })} spec={t('top.slotSpec')} />}
            <Icon name="spark" size={14} />
          </div>
        </div>}
        <div className="scrim" />
        <i className="hud-lines" aria-hidden="true" />
        {inScene && touchZones.map((zone, zoneIndex) => (
          <button key={zone.id} type="button" className={`tap-her${touchHintsVisible ? ' is-hinting' : ''}`} data-zone={zone.id}
            style={{ left: zone.x - touchSize / 2, top: zone.y - touchSize / 2, width: touchSize, height: touchSize }}
            aria-label={`${t('home.tapHer', { first })} ${zoneIndex + 1}`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => void tapHer(zone.id, zone.x, zone.y)} />
        ))}
        {bubble?.text && <p key={bubble.key} className="say" style={sayStyle} role="status" data-testid="say">{bubble.text}</p>}
        <div key={`n${i}`} className={`top-name${firstFade}`}>
          <span className="eyebrow" aria-hidden="true">FIRST FIVE　{String(i + 1).padStart(2, '0')} / {String(CAST.length).padStart(2, '0')}</span>
          <div className="name-row">
            <h1 className={`vname${vertical ? '' : ' h'}`}>{starName(c, t.lang)}</h1>
            {vertical && <span className="vromaji">{c.romaji}</span>}
            <button type="button" className="pv-btn magnetic" onClick={() => setPv(true)}>
              <span className="pv-pulse" aria-hidden="true" />
              <span className="pv-ring" aria-hidden="true"><Icon name="play" size={14} /></span>{t('home.pv')}
            </button>
          </div>
        </div>
        {desk
          ? <Link to="/serial" className="side-tab" style={{ top: Math.min(Math.max(96, fcy - 56), vh * 0.62 - 56) }} aria-label={t('top.serial')}><span aria-hidden="true">{t('top.serialTab')}</span></Link>
          : (
            <div className={`side-tab serial-dock ${serialPeek ? 'is-open' : 'is-collapsed'}`}
              style={{ top: Math.min(Math.max(72, fcy - (serialPeek ? 42 : 24)), vh * 0.6 - (serialPeek ? 42 : 24)) }}>
              {serialPeek
                ? <>
                    <Link to="/serial" className="serial-dock-link" aria-label={t('top.serial')}><span aria-hidden="true">{t('top.serialTab')}</span></Link>
                    <button type="button" className="serial-dock-toggle" aria-label={t('common.close')} onClick={() => setSerialPeek(false)}><span aria-hidden="true">›</span></button>
                  </>
                : <button type="button" className="serial-dock-toggle" aria-label={t('top.serial')} onClick={() => setSerialPeek(true)}><span aria-hidden="true">‹</span></button>}
            </div>
          )}
        <div className="top-panel" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHeld(false); }}>
          <p key={`l${i}`} className={`top-line${firstFade}`}>
            {t(`star.${c.id}.line` as Key).split('\n').map((line, lineIndex) => <span key={`${lineIndex}-${line}`}>{line}</span>)}
          </p>
          <div className="roster" role="radiogroup" aria-label={t('top.pick')} style={{ marginBottom: 18 }}>
            {CAST.map((m, k) => (
              <button key={m.id} type="button" role="radio" aria-checked={k === i} aria-label={starName(m, t.lang)} onClick={() => { lock.current = 0; setAutoRotate(false); setI(k); }}>
                <span className="track"><i key={k === i ? `a${i}-${wait}` : 'x'} className={k === i && autoRotate && !reduced && !held && sec === 0 ? 'grow' : ''} style={{ width: k < i || (k === i && (!autoRotate || reduced || held || sec !== 0)) ? '100%' : k === i ? undefined : '0%', animationDuration: `${ROTATE_MS}ms` }} /></span>
                {/* A-N5: a Korean full name (타다이 마히로) is cut at a phone's fifth of the row: her given name there. */}
                <span className="roster-name">{t.lang === 'ko' ? starFirst(m, t.lang) : starName(m, t.lang)}</span>
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            {member
              ? <Link to="/me/home" className="btn btn-rose magnetic" onClick={(event) => {
                  event.preventDefault();
                  actions.setStar(c.id);
                  document.documentElement.classList.add('private-live-route-leave');
                  window.setTimeout(() => nav('/me/home'), reduced ? 0 : 320);
                }}>{t('top.talk')}</Link>
              : <><Link to="/pick" className="btn btn-rose magnetic">{t('top.talk')}</Link><span className="flag">{t('top.flag')}</span></>}
          </div>
          <Link to="/serial" className="btn btn-line">{t('top.serial')}</Link>
          <p className="tiny top-note" style={{ margin: '14px 0 0' }}>{t('top.aiNote')}</p>
        </div>
        <aside className="top-news" aria-label={t('nav.events')}>
          <span className="eyebrow">NEWS</span>
          {live.map((e) => (
            <Link key={e.id} to="/events" className="top-news-item">
              <span className="tiny">{fmtDate(e.startsAt, t.lang)}</span>
              <span className="small">{localText(e.title, t.lang)}</span>
            </Link>
          ))}
        </aside>
        <span className="scroll-cue" aria-hidden="true">SCROLL</span>
        <p className="sr-only" aria-live="polite">{starName(c, t.lang)}</p>
      </section>
      <Suspense fallback={null}>
        <HomeSections active={sec} star={c.id} onReady={() => setReady(true)} onPv={() => setPv(true)} />
      </Suspense>
      <nav className="fp-dots" aria-label={t('home.pages')}>
        {SECTIONS.map((id, k) => (
          <button key={id} type="button" aria-label={t(SECTION_NAV[k])} aria-current={k === sec ? 'true' : undefined} onClick={() => pageTo(k)}>
            <span aria-hidden="true">{String(k + 1).padStart(2, '0')}</span>
          </button>
        ))}
      </nav>
      <button type="button" className={`home-back-top${showBackTop ? ' is-visible' : ''}`}
        aria-label={t('home.backTop')} tabIndex={showBackTop ? 0 : -1} onClick={() => pageTo(0)}>
        <Icon name="back" size={18} />
        <span aria-hidden="true">TOP</span>
      </button>
      {pv && <Suspense fallback={null}><PvLightbox start={i} onClose={() => setPv(false)} /></Suspense>}
      {askInstall && !pv && <Suspense fallback={null}><InstallHint /></Suspense>}
    </main>
  );
}
