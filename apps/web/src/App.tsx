import { CONFIG } from './lib/config';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { bootstrap, syncLang } from './services/api';
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { isStarId } from './data/cast';
import { onNotificationOpen } from './lib/push';
import { StoreProvider, useStore, useT } from './lib/store';
import { OfflineDock, OfflineLine, Toast, useToast } from './components/ui';
import { AgeGate, Loading, Top } from './pages/site';
import type { AppState } from './lib/state';

// Flow and member screens are split into their own chunks and prefetched when the browser is idle (main.tsx).
const more = () => import('./pages/siteMore');
const flows = () => import('./pages/flows');
const me = () => import('./pages/me');
const live = () => import('./pages/live');
const publicGacha = () => import('./pages/publicGacha');
const Menu = lazy(() => more().then((m) => ({ default: m.Menu })));
const Stars = lazy(() => more().then((m) => ({ default: m.Stars })));
const Features = lazy(() => more().then((m) => ({ default: m.Features })));
const Gallery = lazy(() => more().then((m) => ({ default: m.Gallery })));
const Events = lazy(() => more().then((m) => ({ default: m.Events })));
const LiveLobby = lazy(() => live().then((m) => ({ default: m.LiveLobby })));
const LiveRoom = lazy(() => live().then((m) => ({ default: m.LiveRoom })));
const PublicGacha = lazy(() => publicGacha().then((m) => ({ default: m.PublicGacha })));
const NotFound = lazy(() => more().then((m) => ({ default: m.NotFound })));
const PickStar = lazy(() => flows().then((m) => ({ default: m.PickStar })));
const TrialChat = lazy(() => flows().then((m) => ({ default: m.TrialChat })));
const Signup = lazy(() => flows().then((m) => ({ default: m.Signup })));
const SerialInput = lazy(() => flows().then((m) => ({ default: m.SerialInput })));
const SerialResult = lazy(() => publicGacha().then((m) => ({ default: m.SerialGachaResult })));
const CompanionHome = lazy(() => me().then((m) => ({ default: m.CompanionHome })));
const Chat = lazy(() => me().then((m) => ({ default: m.Chat })));
const Cards = lazy(() => me().then((m) => ({ default: m.Cards })));
const CardDetail = lazy(() => me().then((m) => ({ default: m.CardDetail })));
const Shop = lazy(() => me().then((m) => ({ default: CONFIG.shopOpen ? m.Shop : m.Points })));
const GachaHistory = lazy(() => me().then((m) => ({ default: m.GachaHistory })));
const Legal = lazy(() => import('./pages/legal').then((m) => ({ default: m.Legal })));
const MyPage = lazy(() => me().then((m) => ({ default: m.MyPage })));
const account = () => import('./pages/account');
const BirthdayGate = lazy(() => account().then((m) => ({ default: m.BirthdayGate })));
const Redemptions = lazy(() => account().then((m) => ({ default: m.Redemptions })));
const DeleteAccount = lazy(() => account().then((m) => ({ default: m.DeleteAccount })));
// The scene player (#64) is its own chunk: the engine, the scripts and the stage load only when a scene opens.
const ScenePlayer = lazy(() => import('./scene/player'));
// Scene previews (scenes whose clips are pending, #80 / #81): the test site only; the page itself says so elsewhere.
const ScenePreviews = lazy(() => import('./scene/previews'));
// The wake-up alarm (#57): its settings and her morning moment, each loaded only when opened.
const AlarmPage = lazy(() => import('./pages/alarm'));
const WakeMoment = lazy(() => import('./scene/wake'));
/** The visual system's reference page (#162): test and demo sites and the prototype only (the page checks). */
const DesignPage = lazy(() => import('./pages/design'));
export const prefetchRoutes = () => { void more(); void flows(); void me(); void live(); void publicGacha(); };

/** The screens on the night (public/boot.js marks the same ones before the first paint): every member page (B-N2). */
const NIGHT = /^\/(|me(\/.*)?|age|loading|stars|menu|trial|signup|login|serial|serial\/result|pick|events|gallery|gacha(\/.*)?|live(\/.*)?|legal\/[a-z-]+)$/;

function Shell() {
  const { pathname, search } = useLocation();
  const nav = useNavigate();
  const { actions } = useStore();
  useEffect(() => {
    window.scrollTo(0, 0);
    // Marker for e2e timing and for analytics: the route that is actually painted.
    document.body.dataset.route = pathname;
  }, [pathname]);
  // A notification from her opens her room (/me/home?star=nana) or the chat with her, whoever was on screen before.
  useEffect(() => {
    const star = new URLSearchParams(search).get('star');
    if (pathname.startsWith('/me/') && isStarId(star)) actions.setStar(star);
  }, [pathname, search, actions]);
  // Tapped while the app is already open: the service worker hands the route over instead of reloading the page.
  // Her wake-up rings as her call in her room (⑥, #168): a wake-up link from before goes there too.
  useEffect(() => onNotificationOpen((route) => nav(route.replace(/^\/me\/wake\?(?=.*inbox=)/, '/me/home?'))), [nav]);
  // QA #9 / M11: while a night screen's code loads (her room, and the night screens boot.js names), the screen is
  // already the night, never a blank light page; a light page loads on its light ground.
  // B-N3 / A-N3: a page that docks the offline line under its header (components/ui.tsx OfflineLine) registers here;
  // the shell's floating line is for the screens that do not.
  const [docked, setDocked] = useState(0);
  const [dock] = useState(() => () => { setDocked((n) => n + 1); return () => setDocked((n) => n - 1); });
  return (
    <OfflineDock.Provider value={dock}>
      <div className="app"><Suspense fallback={<div className="page" style={{ minHeight: '100dvh', background: NIGHT.test(pathname) ? '#1b1e3d' : undefined }} />}><Outlet /></Suspense><Notice away={!pathname.startsWith('/me')} />{!docked && <OfflineLine float />}</div>
    </OfflineDock.Provider>
  );
}

/** M3: a word on the next screen — 「ログアウトしました」 on the top page he lands on after logging out. */
function Notice({ away }: { away: boolean }) {
  const { state, actions } = useStore();
  const t = useT();
  const [msg, setMsg] = useToast();
  // Said once he is off the member pages: until then the notice is what sends him to the top page (RequireAuth).
  useEffect(() => {
    if (state.notice !== 'loggedOut' || !away) return;
    setMsg(t('me.loggedOut'));
    actions.clearNotice();
  }, [state.notice, away]); // eslint-disable-line react-hooks/exhaustive-deps
  // B-N8: under the header band, never over the home's call-to-action buttons at the foot of the screen. B-P1: and
  // under the home's 「FIRST FIVE 01 / 05」 (its foot is at 86–118 px from a 320 px phone to a desktop), never over it.
  return <Toast msg={msg} style={{ top: 'calc(126px + env(safe-area-inset-top))', bottom: 'auto' }} />;
}

/**
 * On load the browser cache is replaced by what the API says (server mode): the account for a signed-in
 * user, the device allowance and unclaimed cards for a visitor. Prototype mode pays the pass bonus locally.
 */
function ServerSync() {
  const { state, actions } = useStore();
  const lang = useRef(state.lang);
  useEffect(() => { lang.current = state.lang; }, [state.lang]);
  useEffect(() => {
    let live = true;
    void bootstrap().then((b) => {
      if (!live) return;
      if (b.kind === 'member') {
        actions.hydrateMe(b.me);
        // #176: an account still in another language (made before it followed the app, or on another device) follows.
        if (b.me.user.lang !== lang.current) void syncLang(lang.current);
      } else if (b.kind === 'visitor') actions.hydrateDevice(b.device);
      else if (b.kind === 'signed-out') actions.logout();
      else actions.localDailyBonus();
    });
    return () => { live = false; };
  }, [actions]);
  return null;
}

/** #176: he switched the app's language: what the server writes for him (her wake-up, her messages) follows. */
function LangSync() {
  const { state } = useStore();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void syncLang(state.lang);
  }, [state.lang]);
  return null;
}

function RequireAge({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const { pathname, search } = useLocation();
  if (!state.ageOk) return <Navigate to={`/age?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <>{children}</>;
}

function RequireAuth() {
  const { state } = useStore();
  const { pathname } = useLocation();
  // M3: logged out on purpose, he goes to the top page (its toast says so) — never the sign-up page for where he was.
  if (!state.user) return <Navigate to={state.notice === 'loggedOut' ? '/' : `/signup?next=${encodeURIComponent(pathname)}`} replace />;
  return <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/age" element={<AgeGate />} />
        {/* Legal pages are readable before the age gate. */}
        <Route path="/legal/:doc" element={<Legal />} />
        <Route element={<RequireAge><Outlet /></RequireAge>}>
          <Route path="/loading" element={<Loading />} />
          <Route path="/" element={<Top />} />
          <Route path="/menu" element={<Menu />} />
          <Route path="/stars" element={<Stars />} />
          <Route path="/features" element={<Features />} />
          <Route path="/live" element={<LiveLobby />} />
          <Route path="/live/:star" element={<LiveRoom />} />
          <Route path="/gacha/redeem" element={<SerialResult />} />
          <Route element={<RequireAuth />}>
            <Route element={<BirthdayGate />}>
              <Route path="/gacha" element={<PublicGacha />} />
            </Route>
          </Route>
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/events" element={<Events />} />
          <Route path="/design" element={<DesignPage />} />
          <Route path="/pick" element={<PickStar />} />
          <Route path="/trial" element={<TrialChat />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/login" element={<Navigate to="/signup?mode=login" replace />} />
          <Route path="/serial" element={<SerialInput />} />
          <Route path="/serial/result" element={<Navigate to="/gacha/redeem" replace />} />
          <Route path="/me" element={<RequireAuth />}>
            <Route element={<BirthdayGate />}>
            <Route index element={<Navigate to="/me/home" replace />} />
            <Route path="home" element={<CompanionHome />} />
            <Route path="chat" element={<Chat />} />
            <Route path="gacha" element={<Navigate to="/gacha" replace />} />
            <Route path="gacha/result" element={<Navigate to="/gacha" replace />} />
            <Route path="gacha/history" element={<GachaHistory />} />
            <Route path="cards" element={<Cards />} />
            <Route path="cards/:id" element={<CardDetail />} />
            <Route path="shop" element={<Shop />} />
            <Route path="mypage" element={<MyPage />} />
            <Route path="redemptions" element={<Redemptions />} />
            <Route path="account/delete" element={<DeleteAccount />} />
            <Route path="scene/:id" element={<ScenePlayer />} />
            <Route path="preview" element={<ScenePreviews />} />
            <Route path="alarm" element={<AlarmPage />} />
            <Route path="wake" element={<WakeMoment />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App({ initial }: { initial?: AppState }) {
  return (
    <StoreProvider initial={initial}>
      <ServerSync />
      <LangSync />
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppRoutes />
      </HashRouter>
    </StoreProvider>
  );
}
