import { Fragment, Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CAST, getStar, isStarId } from '../data/cast';
import { CARDS, CARD_BY_ID, RARITY_ORDER, cardLine, cardTitle } from '../data/cards';
import { LANG_NAMES, SELECTABLE_LANGS, dotSep, fmtDate, fmtYen, quoted, starFirst, starName, type Key, type Lang } from '../i18n';
import { CONFIG } from '../lib/config';
import { BOND_RULES, STAGE_RULES, TRIGGER_RULES, WAKEUP_RULES, passActive } from '@jstar/shared/rules';
import { stageAtLeast } from '@jstar/shared/relationship';
import type { Msg } from '../lib/state';
import { uid, useStore, useT } from '../lib/store';
import { SEND_FAILED, useChatSend } from './chatSend';
import { answerCallName, bondOf, calendarToday, demoCalendarDay, demoConfessionDay, drawHistory, errorCode, history, inbox, logout, makePromise, promises, readInbox, relationshipOf, relationships, lastRelationships, serverMode, isDemo } from '../services/api';
import { API_BASE, getToken, http } from '../services/http';
import { readHerLines } from '../services/inboxRead';
import type { ChatSendResT, DrawHistoryResT, InboxItemT, PromiseItemT, PromiseProposalT, RelationshipViewT } from '@jstar/shared/contracts';
import { PROMISE_RULES } from '@jstar/shared/rules';
import { localStory, localText } from '@jstar/shared/domain';
import { confessionOf } from '@jstar/shared/confession';
import { jstDay } from '@jstar/shared/rules';
import { ConfessionMemories } from '../components/confessionMemories';
import { MemoryExportButton } from '../components/memoryExport';
import { DEMO_SCENE_ID } from '@jstar/shared/scenes/constants';
import { Header, Icon, OfflineLine, TabBar, Toast, Typing, useToast } from '../components/ui';
import '../styles/member.css';
import { CardTile, RarityBadge } from '../components/cardTile';
import { SceneVideo, media, mediaFor, preloadClips, stillOf, useSceneMediaState } from '../components/stage';
import { RoomLipsync } from '../components/roomLipsync';
import { useHerVoice, type LipsyncShot } from '../lib/herVoice';
import { itemText } from '../lib/lines';
import { RoomV2, answerReplies, clipLook, faceOnScreen, lastWords, listenClipFor, roomClock, roomText, talkClipFor, useFaces, useStagePortrait, wakeReplies, type Incoming, type IndexData, type Lead } from './roomV2';
import { gifts } from '../services/gifts';
import type { AlarmViewT, GiftsResT } from '@jstar/shared/contracts';
import { StarAvatar } from '../components/starAvatar';
import { THEME } from '../data/theme';
import { clockSlot, fetchGreeting, greetSlot, type GreetSlot } from '../lib/companion';
import { playVoice, setSound, stopVoice, useSound } from '../lib/sound';
import { drawSummary } from '../components/cardArt';
import { PushOptIn } from '../components/pushOptIn';
import { MyCity } from '../components/myCity';
import { reactionKeysFor } from '../data/reactions';
import { HandsFreeToggle, MicButton, useHandsFree, useVoice } from '../components/voice';
import { PromiseMade, PromiseOffer, PromisedScene, promiseAt, promiseState, promiseWhen } from '../components/promise';
import { timelessPromise } from '@jstar/shared/promises';
import { AlarmProposal } from '../components/alarmProposal';
import { ChargeModal } from '../components/chargeModal';
import { decorFor } from '../lib/decor';
import { OfferBubble, declineOffer, roomAnswer, roomOffer, sceneLink, type Offer } from '../scene/offer';
import { ringtoneOf, useRingtone } from '../lib/ringtone';
import { usePreloadOffer } from './roomV2';
import { timeScale } from '../scene/idle';
import { TOD_OF_PHASE, demoRoom, needsLayer, roomOf, useWorld } from '../lib/herWeather';
import { NowLine, PresenceTag, freshWeather, useRoutines } from '../components/whoIsHome';
import type { StarId } from '@jstar/shared/domain';

// Her window's weather (#63): its own chunk, fetched only when her room has weather to show.
const weatherRoom = () => import('../components/weatherRoom');
const WeatherLayer = lazy(() => weatherRoom().then((m) => ({ default: m.WeatherLayer })));
const WeatherChip = lazy(() => weatherRoom().then((m) => ({ default: m.WeatherChip })));
// #61: the day's decoration over her room (its own chunk; decorFor decides without it).
const SeasonDecor = lazy(() => import('../components/seasonDecor').then((m) => ({ default: m.SeasonDecor })));
import { HerMessagesSetting } from '../components/herMessages';
import { GiftButton, giftName } from '../components/gift';
import { LIVE_COVERS } from '../components/liveCover';
import { VoiceToday } from '../components/voiceMinutes';
import type { GiftSendResT } from '@jstar/shared/contracts';
import { CallNameSetting } from '../components/callName';
import { lookWeight, looksOf, pickLook } from '@jstar/shared/bond';
import type { BondResT, VariantStateT } from '@jstar/shared/contracts';
import type { MediaEntry } from '../data/media.gen';
import { loadSceneMedia, preloadSceneMedia } from '../data/media';
import { pickupCardOf } from '@jstar/shared/gacha';
import { isVariantCard, variantHomeWeight } from '@jstar/shared/variants';
import { VariantPanel } from '../components/variantPanel';
import type { CalendarEventViewT, CalendarResT, SceneInviteT } from '@jstar/shared/contracts';
import { routineNow } from '@jstar/shared/world';
import { EIMI_BONUS_CARD_ID, EIMI_BONUS_REACTIONS, eimiBonusIdle, eimiBonusReaction, hasEimiBonusCard } from '../data/eimiBonusMedia';
import { FEATURED_GIFT_IDS } from '@jstar/shared/gifts';

const ROOM_CLIP_DISSOLVE_MS = 420;

/** Time of day in the visitor's clock: before 11 morning, before 17 day, otherwise night. */
export function timeOfDay(h = new Date().getHours()): 'morning' | 'day' | 'night' {
  return h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'day' : 'night';
}

/**
 * Her clip for this moment: a dedicated time-of-day clip when one exists (`<star>-hero-<morning|day|evening>-*`),
 * otherwise her hero (HD first, `<star>-herohd-*`) / breathing clip, graded by CSS toward the hour. Never an empty room.
 * The time-of-day clips are in the lazy catalogue (data/media.ts): until it has loaded this answers her usual loop.
 */
export function homeSceneFor(id: string, slot: string, portrait: boolean) {
  // Eimi's new room set uses the same approved close idle master at every hour and on both layouts.
  if (id === 'eimi') return mediaFor('eimi-idle', portrait);
  const [a, b] = portrait ? ['9x16', '16x9'] : ['16x9', '9x16'];
  return media(`${id}-hero-${slot}-${a}`) ?? media(`${id}-hero-${slot}-${b}`) ?? media(`${id}-herohd-${a}`) ?? media(`${id}-hero-${a}`)
    ?? (portrait ? media(`${id}-breath-9x16`) : undefined) ?? media(`${id}-herohd-${b}`) ?? media(`${id}-hero-${b}`) ?? media(`${id}-breath-9x16`);
}

/**
 * Her look in her room this visit (#56 "she is changed by you"): her usual clip, her close-up once he has praised her
 * face (portrait screens: it is a vertical clip), her variant's home clip (catalog.ts `variantDef().homeVideo`) when he
 * owns the card and the clip exists — by weight, a look praised often counting double (shared/bond.ts), her variant
 * counting more as its own level rises (#76, variants.ts `variantHomeWeight`). At level 10 he may pin her variant look
 * (`variants[card].pinned`): then it is always that one, while its clip exists. Only clips that exist are candidates;
 * nothing is generated for this, and a missing clip falls back to her usual one. `r` in [0, 1) is the visit's roll.
 * Her variant home loops are in the lazy catalogue (data/media.ts): her room waits for it before it asks (`lazyLook`).
 */
export function homeLookFor(
  id: StarId, slot: string, portrait: boolean, praise: Record<string, number>, owned: string[], r: number,
  variants: Partial<Record<string, Pick<VariantStateT, 'level' | 'pinned'>>> = {}, selectedCard: string | null = null
): { look: string; entry: MediaEntry | undefined } {
  if (id === 'eimi' && selectedCard === EIMI_BONUS_CARD_ID && hasEimiBonusCard(owned)) return { look: EIMI_BONUS_CARD_ID, entry: eimiBonusIdle() };
  const base = homeSceneFor(id, slot, portrait);
  const clipOf = (look: string) => (look === 'outfit' ? base : look === 'face' ? (id === 'eimi' ? base : portrait ? media(`${id}-breath-9x16`) : undefined) : mediaFor(`${id}-variant-home`, portrait));
  const looks = looksOf(id, owned).filter((look) => clipOf(look));
  const pinned = looks.find((look) => variants[look]?.pinned);
  if (pinned) return { look: pinned, entry: clipOf(pinned) };
  const weightOf = (look: string) => lookWeight(look, praise[look] ?? 0) * (isVariantCard(look) ? variantHomeWeight(variants[look]?.level ?? 1) : 1);
  const look = pickLook(looks.map((l) => ({ id: l, weight: weightOf(l) })), r) ?? 'outfit';
  return { look, entry: clipOf(look) ?? base };
}

/**
 * Whether her room may show a clip from the lazy catalogue this visit — her morning loop, or the home loop of a variant
 * card of hers he owns: it then loads that catalogue at once and waits for it before choosing her look, so her clip does
 * not change under him when it arrives (otherwise it loads in idle time, for the scenes).
 */
export const lazyLook = (id: StarId, slot: string, owned: string[], selectedCard: string | null = null): boolean =>
  id === 'eimi' && selectedCard === EIMI_BONUS_CARD_ID && hasEimiBonusCard(owned) ? false : slot === 'morning' || looksOf(id, owned).some(isVariantCard);

/** Her line for an inbox item: the text her job wrote, or a line of her own for kinds that carry none. */
export function inboxLine(item: InboxItemT, t: ((k: Key) => string) & { lang?: string }): string {
  // U-29: her written invitations carry the line in every language (`texts`): his language now, even if he switched
  // after the tick wrote it.
  // C-room N5 / N9: else in his account's language (the server's `text`), and in zh-Hant with ，, never 、.
  const text = itemText(item.payload, t.lang ?? '');
  return text.trim() ? text.slice(0, 500) : t('inbox.fallback');
}

/** Per talent: her newest unread item and how many are unread (the list comes unread first, newest first). */
export function unreadByStar(items: InboxItemT[]): Partial<Record<string, { n: number; newest: InboxItemT }>> {
  const out: Partial<Record<string, { n: number; newest: InboxItemT }>> = {};
  for (const i of items) {
    if (i.readAt) continue;
    const cur = out[i.star];
    out[i.star] = cur ? { ...cur, n: cur.n + 1 } : { n: 1, newest: i };
  }
  return out;
}

/**
 * ② The photo with her message (QA #5): the one it carries (`payload.photo`, a path on this site), else one of her own
 * stills — which one turns with the message, the same every time it is shown.
 */
const STILL_FAMILIES = ['hero-16x9', 'night-16x9', 'day-9x16', 'breath-9x16', 'herohd-16x9', 'costume', 'enter-16x9'];
export function messageStill(m: InboxItemT): string | undefined {
  if (typeof m.payload.photo === 'string' && m.payload.photo.startsWith('/')) return m.payload.photo;
  const stills = [...new Set(STILL_FAMILIES.map((f) => stillOf(media(`${m.star}-${f}`))).filter((s): s is string => !!s))];
  if (!stills.length) return undefined;
  const h = [...m.id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 11);
  return stills[h % stills.length];
}

/** How often her open room reads his inbox again (the server's tick runs every 5 minutes). */
export const INBOX_REFRESH_MS = 60_000;

/** ② What her room plays as her messages while he was away: her messages and her words for the day (#61). */
const AWAY_KINDS = new Set<InboxItemT['kind']>(['message', 'event']);

/** Her yes stays on screen this long before the scene opens (#65). */
export const SCENE_START_DELAY_MS = 1800;

/** Her stage as he sees it: `confession_ready` stays "ambiguous" until she has said it (#55); lovers show their level. */
export function stageLabel(r: RelationshipViewT, t: (k: Key, v?: Record<string, string | number>) => string): string {
  if (r.stage === 'lover') return t('rel.lover', { n: r.loverLevel ?? 1 });
  return t(`rel.stage.${r.stage === 'confession_ready' ? 'ambiguous' : r.stage}` as Key);
}


/**
 * Today with her, as one short line on her home (#61): the most important thing today is (his birthday, hers, their
 * anniversary, the season, her birthday coming up). The API sends her birthday only once the agency confirmed it.
 */
export function calendarLabel(e: CalendarEventViewT, first: string, t: (k: Key, v?: Record<string, string | number>) => string): string {
  if (e.kind === 'season') return e.season ? t(`cal.season.${e.season}` as Key) : '';
  return t(`cal.${e.kind}` as Key, { first, n: e.count ?? 1 });
}

/** The calendar per talent from GET /v1/calendar. */
const byStar = (r: CalendarResT) => Object.fromEntries(r.talents.map((x) => [x.star, x.events])) as Partial<Record<string, CalendarEventViewT[]>>;
/** Test-site days already asked for in this page's life: `?day=` puts her messages in his inbox, once is enough. */
const demoDaysAsked = new Set<string>();

/** Her wake-up moment (#57) for an inbox item: where the push lands, and where her face's badge leads for one. */
export const wakeRoute = (item: InboxItemT) => `/me/wake?star=${item.star}&inbox=${encodeURIComponent(item.id)}`;

/** Wake-ups this page already opened by itself: a failed open must not send him back there on every visit. */
const autoOpened = new Set<string>();
/**
 * This morning's unopened wake-up, which opening her room plays before 11:00 (his clock): how she wakes a user who
 * never turned push on (#57). Null after that hour, for another day's, or once opened.
 */
export function morningWake(items: InboxItemT[], now = new Date(), star?: string): InboxItemT | null {
  const today = now.toDateString();
  const morning = now.getHours() < WAKEUP_RULES.sceneUntilHour;
  // N-63: only hers — opening まひろ's room never plays 奈々's wake-up; 奈々's face (its badge) and the alarm's own
  // notification lead to hers. Her alarm by day or in the evening (PR 5) rings while it is fresh (RING_FRESH_MS).
  return items.find((i) => i.kind === 'wakeup' && !i.readAt && !autoOpened.has(i.id) && new Date(i.deliveredAt).toDateString() === today && (!star || i.star === star)
    && (morning || now.getTime() - Date.parse(i.deliveredAt) < RING_FRESH_MS)) ?? null;
}
/** R12: a promise due this long ago or less when its plan reaches her room is still kept and offered there and then. */
const DUE_LATE_MS = 10 * 60_000;

/** How long her alarm still rings as her call after it was delivered, outside the morning (her push's lifetime). */
export const RING_FRESH_MS = 30 * 60_000;

/**
 * QA #7 / U-67: the address her room should have, or null to leave it. A `?star=` naming another of the five is where
 * he is going when the room has just opened (`moved` false: the store follows the address), and the room he left once
 * he has moved to another (a swipe, a name in 目錄): then the address follows him.
 */
export function followStar(param: string | null, current: string, moved: boolean): string | null {
  if (!param || param === current) return null;
  if (!moved && isStarId(param)) return null;
  return `/me/home?star=${current}`;
}

const GREET_KEY: Partial<Record<GreetSlot, Key>> = { welcome: 'home.greet.welcome', return: 'home.greet.return', morning: 'home.greet.morning', day: 'home.greet.day' };

/** The dark pills over her video on the member home (demo menu, confession, promises). */
const PILL: React.CSSProperties = { alignSelf: 'flex-start', minHeight: 44, gap: 8, fontSize: 14, background: 'rgba(27, 30, 61, 0.72)', color: 'var(--ivory)' };

export function CompanionHome() {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  // B「電影字幕」: her 9:16 clips below 17:20, her 16:9 clips from there (room.css draws the same line).
  const portrait = useStagePortrait();
  const c = getStar(state.star);
  const [slot] = useState<GreetSlot>(() => greetSlot());
  const clock = clockSlot(new Date().getHours());
  // #56: which of her looks the room shows is decided once per visit, when his praise for her looks is known.
  const [praise, setPraise] = useState<Partial<Record<string, Record<string, number>>>>({});
  const [roll] = useState(() => Math.random());
  // #15: her #56 question — may she call him differently now — is asked in her room too, not only on her chat page.
  const [callAsk, setCallAsk] = useState<Partial<Record<string, BondResT['ask']>>>({});
  useEffect(() => {
    let live = true;
    void bondOf(c.id, t.lang).then((b) => {
      if (!live || !b) return;
      setPraise((p) => (p[b.star] ? p : { ...p, [b.star]: b.praise }));
      // M7: never her question offering the name she already calls him by (an older server asks it in en / ko / zh-Hant).
      const same = !!b.ask && !!b.callName && [`「${b.callName}」`, `"${b.callName}"`, `“${b.callName}”`].some((q) => b.ask!.text.includes(q));
      setCallAsk((a) => ({ ...a, [b.star]: same ? null : b.ask ?? null }));
    });
    return () => { live = false; };
  }, [c.id, t.lang]);
  // M9: the page behind her room is her night while he is here (boot.js and index.html's boot shell start it).
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.boot = 'room';
    return () => { root.dataset.boot = 'site'; };
  }, []);
  const selectedCard = state.selectedCards[c.id] ?? null;
  const { look, entry: scene } = homeLookFor(c.id, clock, portrait, praise[c.id] ?? {}, Object.keys(state.owned), roll, state.variants, selectedCard);
  const waitLook = lazyLook(c.id, clock, Object.keys(state.owned), selectedCard);
  // N-48: failed after its tries, her room shows her usual look (core catalogue) — the morning or variant look swaps
  // in once the catalogue comes (tried again in the background).
  const lookReady = useSceneMediaState(waitLook).state !== 'loading' || !waitLook;
  // Room v2 (A2): her talking loop while she answers, her listening (idle) loop while he types or speaks, her home
  // loop otherwise — stacked and crossfaded (never a black frame), warmed as the room opens.
  const [talking, setTalking] = useState(false);
  const [listening, setListening] = useState(false);
  const [pure, setPure] = useState(false);
  const clipsReady = useSceneMediaState(true).state === 'ready';
  const talkClip = clipsReady ? talkClipFor(c.id, look, portrait) : undefined;
  const listenClip = clipsReady ? (look === EIMI_BONUS_CARD_ID ? eimiBonusIdle() : listenClipFor(c.id, portrait)) : undefined;
  useEffect(() => { preloadClips([talkClip, listenClip]); }, [talkClip?.id, listenClip?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // ⑤ a tap on her in pure view: her reaction clip (when she has one) and a line of hers.
  const [reaction, setReaction] = useState<{ key: number; clip: MediaEntry } | null>(null);
  const [reactionLeaving, setReactionLeaving] = useState(false);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
  }, []);
  const finishReaction = useCallback(() => {
    if (reactionLeaving || reactionTimer.current) return;
    setReactionLeaving(true);
    reactionTimer.current = setTimeout(() => {
      reactionTimer.current = null;
      setReactionLeaving(false);
      setReaction(null);
    }, ROOM_CLIP_DISSOLVE_MS);
  }, [reactionLeaving]);
  const responseClipIndex = useRef(0);
  const taps = useRef(0);
  // QA #5 (U-36): her line for being touched, in his language, by how close they are (@jstar/shared/touch) — never one
  // of her recorded greetings (「初次見面」 on day 6). Subtitle only: no recording says these words.
  const tapHer = async (): Promise<string | null> => {
    const clips = look === EIMI_BONUS_CARD_ID
      ? EIMI_BONUS_REACTIONS.map(eimiBonusReaction)
      : reactionKeysFor(c.id).map((k) => mediaFor(`${c.id}-react-${k}`, portrait)).filter((x): x is MediaEntry => !!x);
    if (clips.length) {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
      reactionTimer.current = null;
      setReactionLeaving(false);
      setReaction({ key: Date.now(), clip: clips[Math.floor(Math.random() * clips.length)] });
    }
    const [{ touchLine }, { touchLines }] = await Promise.all([import('@jstar/shared/touch'), import('../lib/touchLines')]);
    const lines = await touchLines();
    return lines ? touchLine(lines, c.id as StarId, relationshipOf(state, c.id)?.stage, taps.current++, t.lang) : null;
  };
  // Her city's weather and sun (#63); `?wx=rain` draws a room without data, in the prototype and on the test site only.
  const query = new URLSearchParams(useLocation().search);
  const wx = query.get('wx');
  // The test site can pretend another day (#61): `?day=2027-03-04` (demo mode only; production ignores it).
  const demoDay = query.get('day');
  const talents = useWorld();
  const live = roomOf(talents?.find((w) => w.star === c.id));
  const room = (isDemo() || !serverMode() ? demoRoom(wx) : null) ?? live;
  // Who's home now (#60): the five on their own clocks (world.ts routineNow, JST). Asleep, he wakes her.
  const routines = useRoutines();
  const asleep = routines[c.id as StarId].presence === 'asleep';
  // The light follows her real sunrise and sunset once they are known, the viewer's clock until then.
  const tod = room ? TOD_OF_PHASE[room.phase] : clock;
  const [served, setServed] = useState<Record<string, string>>({});
  // N-08: whether the API has answered for her greeting (with a line or without one); until then a quiet placeholder.
  const [greeted, setGreeted] = useState<Record<string, boolean>>({});
  // Promises (#59), per talent: the next one with her, and the scene of one her greeting just kept.
  const [plan, setPlan] = useState<Record<string, { next: PromiseItemT | null; scene: string | null }>>({});
  const [toast, setToast] = useToast();
  useEffect(() => {
    if (!state.bonusNotice) return;
    setToast(t('home.bonus', { n: state.bonusNotice }));
    actions.clearBonusNotice();
  }, [state.bonusNotice, actions, setToast, t]);
  /** After her greeting: the promises, and what a promise it just kept offers. True when it kept one. */
  async function keepDue(g: Awaited<ReturnType<typeof fetchGreeting>>, live: () => boolean): Promise<boolean> {
    // Asked after her greeting, which may just have kept the promise that was due.
    const r = await promises(c.id, t.lang);
    // A kept promise of a scene together leads back into it (#59) — her morning, when it named that (#67). Her
    // wake-up promise is kept by her wake-up, never by a scene (#57).
    const kept = g?.promise?.status === 'kept' && g.promise.kind === 'scene' ? g.promise.sceneId : null;
    // N-64: her greeting just kept a promise to be together (the room's first offer was asked before it was kept):
    // ask her room again, so the promised moment is offered now.
    if (g?.promise?.status === 'kept' && !kept) void roomOffer(c.id).then((o) => { if (live() && o) setOffer(o); });
    if (live() && (r || kept)) setPlan((p) => ({ ...p, [c.id]: { next: r?.promises.find((x) => x.star === c.id) ?? null, scene: kept } }));
    return g?.promise?.status === 'kept';
  }
  // Server greeting (by hour and relationship) when the API offers one; her voice line for the slot if recorded.
  // Her call as it rings now (C-room R4: no greeting over it), for the effects above its state.
  const ringingRef = useRef<InboxItemT | null>(null);
  useEffect(() => {
    let live = true;
    void fetchGreeting(c.id, t.lang).then(async (g) => {
      if (!live) return;
      if (g) setServed((s) => ({ ...s, [c.id]: g.text }));
      setGreeted((s) => ({ ...s, [c.id]: true }));
      await keepDue(g, () => live);
    });
    // Her recorded greeting is for when she is up; woken, her first words are the drowsy ones. Not while her call
    // rings (her alarm, or a push he tapped): her ringtone is her voice then (#12). C-room R4: nor when he comes to
    // her room from her 「來電 ›」 line in another's — her call is ringing here then.
    if (!asleep && !morningWake(state.inbox, new Date(), c.id) && !query.get('inbox') && ringingRef.current?.star !== c.id) void playVoice(`/voice/greet/${c.id}-${slot}.mp3`);
    return () => { live = false; stopVoice(); };
  }, [c.id, t.lang, slot, asleep]); // eslint-disable-line react-hooks/exhaustive-deps -- keepDue reads c.id and t.lang
  // R12: a promise that comes due while he stays in her room is kept then (her greeting keeps it, as on arrival) and
  // offered at once: her line with ✦, in place of her last line, even mid-conversation.
  const [dueTick, setDueTick] = useState(0);
  const dueAt = plan[c.id]?.next?.dueAt;
  useEffect(() => {
    if (!dueAt) return;
    const ms = Date.parse(dueAt) - Date.now() + 1000;
    // A promise that came due before its plan reached her room (a slow answer, a busy device) is asked about at once —
    // never skipped (it was: promiseDue.test failed whenever the room took more than ~2 s to load). Long past its
    // moment (DUE_LATE_MS), it is left to her greeting on his next visit.
    if (!Number.isFinite(ms) || ms < -DUE_LATE_MS || ms > 2 ** 31 - 1) return;
    let live = true;
    const id = setTimeout(() => {
      void fetchGreeting(c.id, t.lang).then(async (g) => {
        if (live && (await keepDue(g, () => live))) setDueTick(Date.now());
      });
    }, Math.max(0, ms));
    return () => { live = false; clearTimeout(id); };
  }, [dueAt, c.id, t.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // Her inbox and the five relationships are fetched on every visit to the home, so what moved since the page
  // loaded (the tick, a scene, another tab) shows up too.
  useEffect(() => {
    let live = true;
    void inbox().then((r) => { if (live && r) actions.setInbox(r); });
    // Round 13: the last read shows at once, and a rate-limited or failed read is retried — never an empty stage row.
    const last = Object.keys(state.relView).length ? null : lastRelationships();
    if (last) actions.setRelationships(last);
    void relationships().then((r) => { if (live && r) actions.setRelationships(r); });
    return () => { live = false; };
  }, [actions]); // eslint-disable-line react-hooks/exhaustive-deps
  // What today is with each of them (#61), fetched on every visit like the inbox: the day may have turned.
  const [today, setToday] = useState<Partial<Record<string, CalendarEventViewT[]>>>({});
  useEffect(() => {
    let live = true;
    const asked = isDemo() && demoDay && /^\d{4}-\d{2}-\d{2}$/.test(demoDay) && !demoDaysAsked.has(demoDay) ? demoDay : null;
    if (asked) demoDaysAsked.add(asked);
    void (asked ? demoCalendarDay(asked) : calendarToday()).then((r) => { if (live && r) setToday(byStar(r)); });
    return () => { live = false; };
  }, [demoDay]);
  const day = today[c.id]?.[0];
  // #61: New Year, fireworks, Halloween, Christmas, her birthday, his, their anniversary — the test site's `?day=` too.
  const decor = decorFor(today[c.id], isDemo() && demoDay && /^\d{4}-\d{2}-\d{2}$/.test(demoDay) ? demoDay : jstDay());
  // #65: her room is her idle scene. As he enters — and once more if he sits here quietly — she may offer a scene.
  // A scene may start from her room: its clips' catalogue (data/media.ts) loads while she greets him (at once: lazyLook).
  useEffect(() => preloadSceneMedia(), []);
  const [offer, setOffer] = useState<Offer | null>(null);
  const offerRef = useRef<Offer | null>(null);
  offerRef.current = offer;
  useEffect(() => {
    let live = true;
    setOffer(null);
    const ask = () => roomOffer(c.id).then((o) => { if (live && o && !offerRef.current) setOffer(o); });
    void ask();
    let asked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (!asked) timer = setTimeout(() => { asked = true; if (!offerRef.current) void ask(); }, TRIGGER_RULES.idleProposeMs * timeScale());
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchmove'] as const;
    arm();
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    return () => { live = false; clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, arm)); };
  }, [c.id]);
  const notNow = () => { if (offer) declineOffer(offer.id); setOffer(null); };
  // #77: her reaction to a gift takes the place of her greeting, and joins her chat.
  // F-26: her reaction to his gift is his doing, so it takes the floor at once — over an invitation, an offer, her
  // confession or a promise leading her room, and mid-conversation (her interjection, until he says something);
  // what led keeps its ✦ under her reaction.
  const [giftSaid, setGiftSaid] = useState<{ star: string; text: string; at: number } | null>(null);
  const onGift = (r: GiftSendResT) => {
    const keys = reactionKeysFor(r.star);
    const featuredIndex = FEATURED_GIFT_IDS.indexOf(r.giftId as typeof FEATURED_GIFT_IDS[number]);
    const key = keys[(featuredIndex < 0 ? 0 : featuredIndex) % keys.length];
    const clip = mediaFor(`${r.star}-react-${key}`, portrait);
    if (clip) {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
      reactionTimer.current = null;
      setReactionLeaving(false);
      setReaction({ key: Date.now(), clip });
    }
    setGiftSaid({ star: r.star, text: r.reaction, at: Date.now() });
    setServed((s) => ({ ...s, [r.star]: r.reaction }));
    actions.chatAppend(r.star, [{ id: uid(), from: 'system', text: t('gift.sent', { gift: giftName(r.giftId, t.lang) }) }, { id: uid(), from: 'her', text: r.reaction }]);
  };
  const unread = unreadByStar(state.inbox);
  const wake = morningWake(state.inbox, new Date(), c.id);
  // ⑥ (#168): this morning's wake-up rings as her call, and so does an invite he opened from a push (?inbox=).
  const [ringing, setRinging] = useState<InboxItemT | null>(null);
  ringingRef.current = ringing;
  // M2: her first words after he picked up (her wake-up line, her answer to his naming answer, the message she called
  // with) and his replies to them — never the opening set (「我回來了 / 有點累」) under her wake-up line.
  const [answered, setAnswered] = useState<{ text: string; replies: string[] } | null>(null);
  useEffect(() => {
    if (!wake) return;
    autoOpened.add(wake.id);
    setRinging(wake);
  }, [wake]);
  // C-room N2: another of the five calls (her alarm, fresh) while he is in this room: her 「奈奈來電 ›」 line here — never
  // her ringtone here, never her call over this face; a tap takes him to hers, where it rings (ringHere, below).
  const callElsewhere = useMemo(() => state.inbox.find((i) => i.kind === 'wakeup' && !i.readAt && !autoOpened.has(i.id) && i.star !== c.id
    && Date.now() - Date.parse(i.deliveredAt) < RING_FRESH_MS) ?? null, [state.inbox, c.id]);
  useEffect(() => { if (callElsewhere) setRinging((cur) => cur ?? callElsewhere); }, [callElsewhere?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pushed = query.get('inbox');
  // QA #7: the address follows the room he is in (a ?star= left from a link or a push names the room he left).
  // U-67: arriving with ?star=eimi (a link, a push, the menu) is the room to open — App's Shell makes her the star
  // right after this mounts; rewriting the address to the room before her here sent him back to that one.
  const starParam = query.get('star');
  const shownStar = useRef(c.id);
  useEffect(() => {
    const moved = shownStar.current !== c.id;
    shownStar.current = c.id;
    const to = followStar(starParam, c.id, moved);
    if (to) nav(to, { replace: true });
  }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // His inbox while he stays in her room (an open room is where a push lands, and where her alarm rings): read again
  // every minute, when the page comes back into view or focus, and for a pushed item it does not have yet.
  const refreshInbox = useCallback(() => { void inbox().then((r) => { if (r) actions.setInbox(r); }); }, [actions]);
  useEffect(() => {
    const id = setInterval(refreshInbox, INBOX_REFRESH_MS);
    const back = () => { if (document.visibilityState === 'visible') refreshInbox(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); };
  }, [refreshInbox]);
  useEffect(() => {
    if (pushed && !autoOpened.has(pushed) && !state.inbox.some((i) => i.id === pushed)) refreshInbox();
  }, [pushed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pushed || autoOpened.has(pushed)) return;
    const item = state.inbox.find((i) => i.id === pushed);
    if (!item) return;
    autoOpened.add(pushed);
    if (item.star !== c.id) startTransition(() => actions.setStar(item.star));
    setRinging(item);
  }, [pushed, state.inbox]); // eslint-disable-line react-hooks/exhaustive-deps
  const snoozeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (snoozeTimer.current) clearTimeout(snoozeTimer.current); }, []);
  const answering = useRef(false);
  // #14: her invitation he answered from her call leads her room (her line and ✦) — ahead of her ② messages, which
  // stay a tap away (「還有 N 則留言」).
  const [called, setCalled] = useState<{ item: string; offer?: string } | null>(null);
  useEffect(() => { setCalled(null); }, [c.id]);
  const answerCall = async () => {
    const item = ringing;
    if (!item || answering.current) return;
    if (item.kind === 'wakeup') {
      // 接聽: her room, her wake-up line as her first words. QA #22: her call stays until that line is here, so no other
      // line of hers shows for a moment in between. Opened, it is answered: the server calls off her 「あと5分」 still to
      // come and reads that morning's other calls (U-41), so the inbox is read again.
      answering.current = true;
      let line = inboxLine(item, t);
      if (serverMode()) { try { line = (await http.wakeOpen(item.id, t.lang)).line; } catch { /* her message's own words */ } }
      answering.current = false;
      setAnswered({ text: line, replies: wakeReplies(t.lang) });
      setRinging(null);
      if (serverMode()) refreshInbox();
      else void readInbox(item.id).then((r) => { if (r) actions.inboxRead(r); });
      return;
    }
    setRinging(null);
    // An invitation from a push: her scene offer for it, else her line with ✦ (the item, below); a message without a
    // scene is her line in the room.
    const scene = item.payload.sceneId ?? item.payload.scene;
    if (typeof scene === 'string' && confessionOf(scene)) { nav(`/me/scene/${scene}`); return; }
    if (typeof scene === 'string') {
      setCalled({ item: item.id });
      const o = await roomOffer(item.star, item.id);
      if (o) { setOffer(o); setCalled({ item: item.id, offer: o.id }); }
      return;
    }
    const said = inboxLine(item, t);
    setAnswered({ text: said, replies: answerReplies(lastWords(said), t.lang) });
    void readInbox(item.id).then((r) => { if (r) actions.inboxRead(r); });
  };
  /**
   * 下次吧 to her invitation: read, and (Low 10) the scene it names is declined like her offer's 下次吧 — so her room
   * does not offer that same scene again the moment he said not now (the decline cooldown, TRIGGER_RULES).
   */
  const letInviteGo = (item: InboxItemT) => {
    void readInbox(item.id).then((r) => { if (r) actions.inboxRead(r); });
    const scene = item.payload.sceneId ?? item.payload.scene;
    if (typeof scene !== 'string' || confessionOf(scene)) return;
    if (offer && offer.sceneId === scene) { declineOffer(offer.id); setOffer(null); return; }
    void roomOffer(item.star, item.id).then((o) => {
      if (!o || o.sceneId !== scene) return;
      declineOffer(o.id);
      setOffer((cur) => (cur?.sceneId === scene ? null : cur));
    });
  };
  const laterCall = async () => {
    const item = ringing;
    if (!item) return;
    setRinging(null);
    // 下次吧 to her invitation: she lets it go (read, so it does not ring or lead her room again).
    if (item.kind !== 'wakeup') { letInviteGo(item); return; }
    if (!serverMode()) {
      setToast(roomText('snoozed', t.lang));
      // Prototype mode: she calls again in five minutes if he is still here.
      snoozeTimer.current = setTimeout(() => setRinging(item), 5 * 60_000);
      return;
    }
    // 再睡5分鐘: the server calls again in five minutes (a wake-up row of its own, pushed to his phone and read here
    // when it comes) — never this call again from this page, and never a 409 loop (U-41).
    // L5: his 再睡5分鐘 is answered at once (her words), not after the server's answer; a refusal replaces them.
    setToast(roomText('snoozed', t.lang));
    try {
      const r = await http.wakeSnooze(item.id);
      refreshInbox();
      const next = r.next;
      if (next) {
        // F-04: she rings again at her time (about five minutes), from this room: it tells the server so, which
        // delivers that call now and never pushes it as well. Away from this room, the tick and his phone ring it.
        const ms = Math.max(0, Date.parse(r.dueAt) - Date.now());
        snoozeTimer.current = setTimeout(() => {
          if (autoOpened.has(next.id)) return;
          autoOpened.add(next.id);
          // C-room N2: she calls again from her room — he stays in the room he chose; another's room shows her
          // 「來電 ›」 line, which takes him to her call.
          setRinging(next);
          void http.wakeRing(next.id).catch(() => undefined);
        }, ms);
        return;
      }
      const ms = Date.parse(r.dueAt) - Date.now() + 15_000;
      if (ms > 0 && ms < 30 * 60_000) snoozeTimer.current = setTimeout(refreshInbox, ms);
    } catch (e) {
      const code = errorCode(e);
      setToast(code === 'snooze_used' || code === 'wake_over' ? t('wake.snoozeUsed', { n: WAKEUP_RULES.snoozeMinutes, first: starFirst(getStar(item.star), t.lang) }) : t('common.error'));
      // Her call is over either way: read, so it does not ring again.
      void readInbox(item.id).then((r) => { if (r) actions.inboxRead(r); });
    }
  };
  const rel = relationshipOf(state, c.id);
  const conf = rel?.confession ?? null;
  // Her confession day (#55). From 17:00 JST the first visit to her room opens on it (once: after that the chip below
  // leads there); by day she only hints — the API's greeting is her hint, prototype mode loads the line itself.
  useEffect(() => {
    if (!conf || conf.phase !== 'due' || !conf.tonight || conf.reachedToday) return;
    const key = `jstar.confession.${c.id}.${jstDay()}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* storage blocked: the API's reachedToday still stops a second opening */ }
    nav(`/me/scene/${conf.sceneId}`);
  }, [conf?.phase, conf?.tonight, conf?.reachedToday, conf?.sceneId, c.id, nav]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hint, setHint] = useState<Partial<Record<string, string>>>({});
  const hinting = !!conf && conf.phase === 'due' && !conf.tonight;
  useEffect(() => {
    if (serverMode() || !hinting) return;
    let live = true;
    void import('@jstar/shared/scenes/confession').then((m) => { if (live) setHint((h) => ({ ...h, [c.id]: m.confessionHint(c.id, t.lang) })); });
    return () => { live = false; };
  }, [hinting, c.id, t.lang]);
  const confessionDay = async () => {
    try {
      if (serverMode()) { await demoConfessionDay(c.id); const r = await relationships(); if (r) actions.setRelationships(r); } else actions.demoConfessionDay(c.id);
      setToast(t('confession.demoDone'));
    } catch { setToast(t('common.error')); }
  };
  const key = GREET_KEY[slot];
  const greeting = (hinting ? hint[c.id] : undefined) ?? served[c.id]
    ?? (asleep ? t('home.greet.asleep') : key ? t(key, { first: starFirst(c, t.lang) }) : t(`star.${c.id}.greet` as Key));
  // N-08: while her own greeting is on its way (server mode), no stock morning line: asleep she sleeps, else she types.
  const waiting = serverMode() && !greeted[c.id] && !served[c.id] && !(hinting && hint[c.id]);
  // ---- room v2 (A2): what the layer over her video says
  const first = starFirst(c, t.lang);
  const talent = talents?.find((w) => w.star === c.id);
  const sky = room?.condition ? t(SKY_KEY[room.condition] ?? 'wx.clear') : null;
  // C-room N10: her city and her sky apart, so the status line gives way in their order (sky first), never his clock.
  const place = talent ? localText(talent.city, t.lang) : null;
  const date = roomClock(new Date(), t.lang);
  // ② her messages, the day's notes, and a wake-up of hers that never rang here (a past morning's); never one that
  // rings or rang this visit (⑥: answered, her line is her first words) or names a scene (her line and ✦, below).
  // C-room N1: her invitation's scene, as it can be offered — ready now, or when (「今晚見」); null: no time can be promised
  // for it (then it is one of her messages, ②); absent while still asked.
  const [inviteAt, setInviteAt] = useState<Partial<Record<string, SceneInviteT | null>>>({});
  const herMessages = useMemo(() => state.inbox.filter((i) => i.star === c.id && !i.readAt && ((!i.payload.sceneId && !i.payload.scene) || inviteAt[i.id] === null)
    && (AWAY_KINDS.has(i.kind) || (i.kind === 'wakeup' && i.id !== wake?.id && i.id !== ringing?.id && !autoOpened.has(i.id)))), [state.inbox, c.id, wake?.id, ringing?.id, inviteAt]);
  // An item of hers naming a scene (an invitation, her confession day's message): her line with ✦ in her room.
  const invItem = useMemo(() => state.inbox.find((i) => i.star === c.id && !i.readAt && i.kind !== 'wakeup' && inviteAt[i.id] !== null && (typeof i.payload.scene === 'string' || typeof i.payload.sceneId === 'string')) ?? null, [state.inbox, c.id, inviteAt]);
  const invScene = invItem ? String(invItem.payload.scene ?? invItem.payload.sceneId) : null;
  useEffect(() => {
    // Her scene offer for it when the server has one ready (her line, ✦ and 下次吧); else whether its scene can start now,
    // or when (N1). Prototype mode works that out from the script itself, as the server does.
    if (!invItem || !invScene || confessionOf(invScene)) return;
    let live = true;
    const id = invItem.id;
    void (serverMode() ? roomAnswer(c.id, id) : localInvite(invScene).then((invite) => ({ offer: null, invite }))).then((r) => {
      if (!live) return;
      if (r.offer) setOffer((cur) => cur ?? r.offer);
      setInviteAt((m) => ({ ...m, [id]: r.offer ? { sceneId: invScene, title: r.offer.title, ready: true, dueAt: null, tonight: false } : r.invite }));
    });
    return () => { live = false; };
  }, [invItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /** N1, prototype mode: the script's own hour and routine against her clock (the server's inviteFor, without weather). */
  async function localInvite(sceneId: string): Promise<SceneInviteT | null> {
    const { sceneById, inviteTiming, jstSlot } = await import('@jstar/shared/scenes/invite');
    const script = sceneById(sceneId);
    if (!script || script.meta.star !== c.id) return null;
    const now = Date.now();
    const at = inviteTiming(script.meta, { slot: jstSlot(now), weather: null, stage: relationshipOf(state, c.id)?.stage ?? 'new', owns: (id) => !!state.owned[id], routine: routineNow(c.id as StarId, new Date(now)) }, now);
    return at && { sceneId, title: script.meta.title, ready: at.ready, dueAt: at.dueAt === null ? null : new Date(at.dueAt).toISOString(), tonight: at.tonight };
  }
  /** N1: 「今晚見」 — her invitation's scene promised for when it can start; her invitation is read. */
  const [keeping, setKeeping] = useState(false);
  async function promiseTonight(item: InboxItemT, invite: SceneInviteT) {
    if (keeping) return;
    setKeeping(true);
    try {
      const promise: PromiseItemT = serverMode()
        ? (await http.promiseTonight(item.star, invite.sceneId, item.id, t.lang)).promise
        : { id: uid(), star: item.star, text: localText(invite.title, t.lang), kind: 'scene', status: 'open', source: 'proposal', dueAt: invite.dueAt!, madeAt: new Date().toISOString(), keptAt: null, sceneId: invite.sceneId };
      setPlan((p) => ({ ...p, [item.star]: { next: promise, scene: p[item.star]?.scene ?? null } }));
      setCalled(null);
      setToast(t('promise.made', { when: promiseWhen(promise.dueAt, t.lang), text: timelessPromise(promise.text) }));
      // Her invitation is answered: read (the server read it; prototype mode reads it here).
      if (serverMode()) refreshInbox();
      else actions.inboxRead({ item: { ...item, readAt: promise.madeAt }, unread: state.inbox.filter((i) => !i.readAt && i.id !== item.id).length });
    } catch (e) {
      // Another promise with her is open, or the time passed: her invitation stays, with 下次吧.
      setToast(errorCode(e) === 'promise_open' && nextPromise ? t('promise.label', { first, text: timelessPromise(nextPromise.text), when: promiseWhen(nextPromise.dueAt, t.lang) }) : t('common.error'));
    } finally {
      setKeeping(false);
    }
  }
  const openInvite = (to: string) => {
    if (invItem) void readInbox(invItem.id).then((r) => { if (r) actions.inboxRead(r); });
    nav(to);
  };
  // ② Her newest five, oldest first. They are read only once all are seen (in one request), so the list holds still
  // while he reads them; the ones that arrive while he is here join it.
  const messages = useMemo(() => herMessages.slice(0, 5).reverse(), [herMessages]);
  const asked = callAsk[c.id] ?? null;
  const [naming, setNaming] = useState(false);
  const answerName = async (accept: boolean) => {
    if (!asked || naming) return;
    setNaming(true);
    try {
      const r = await answerCallName(c.id, asked.to, accept, t.lang);
      // Her question and her answer are in the conversation now (the server stored both); her answer is her line.
      actions.chatAppend(c.id, [{ id: uid(), from: 'her', text: asked.text }, { id: uid(), from: 'her', text: r.reply }]);
      setAnswered({ text: r.reply, replies: answerReplies(lastWords(r.reply), t.lang) });
      setCallAsk((a) => ({ ...a, [c.id]: null }));
    } catch (e) {
      // Answered in another tab: she is no longer asking.
      if (errorCode(e) === 'not_asking') setCallAsk((a) => ({ ...a, [c.id]: null }));
      else setToast(t('call.failed'));
    } finally {
      setNaming(false);
    }
  };
  const lead: Lead | { wait: true; asleep?: string } = (() => {
    // F-30: her line as she answers her call leads her room — ahead of her ② messages, which follow a tap away.
    if (answered) return { text: answered.text, testId: 'greeting', urgent: true, replies: answered.replies };
    if (conf && (conf.phase === 'open' || (conf.phase === 'due' && (conf.tonight || isDemo())))) {
      return { text: greeting, label: 'invitation', testId: 'greeting',
        invite: { title: t(conf.phase === 'open' ? 'confession.self' : 'confession.entry', { first }), to: `/me/scene/${conf.sceneId}`, testId: 'confession-entry' } };
    }
    if (plan[c.id]?.scene) return { text: t('promise.scene'), label: 'invitation', invite: { title: t('promise.scene'), to: sceneLink(plan[c.id].scene!), testId: 'promise-scene' } };
    if (offer) {
      return { text: t(`scene.offer.${offer.source}.${offer.star}` as Key, { title: localText(offer.title, t.lang) }), label: 'invitation', groupTestId: 'scene-offer', groupLabel: t('scene.offer.label', { first: starFirst(c, t.lang) }),
        urgent: called?.offer === offer.id, invite: { title: localText(offer.title, t.lang), to: sceneLink(offer.sceneId, offer.id), testId: 'scene-offer-yes', laterTestId: 'scene-offer-no', onLater: notNow } };
    }
    if (invItem && invScene) {
      const urgent = called?.item === invItem.id;
      const inviteNow = inviteAt[invItem.id];
      return confessionOf(invScene)
        ? { text: inboxLine(invItem, t), label: 'invitation', testId: 'inbox-line', urgent,
          invite: { title: t('confession.entry', { first }), onClick: () => openInvite(`/me/scene/${invScene}`), testId: 'confession-entry' } }
        // M6: her invitation's ✦ is the scene it names, in her room (its offer when the server has one, above) —
        // never her chat page. N1: only when it can start now; otherwise 「今晚見」, a promise for when it can (until
        // that is known, her line with 下次吧 alone).
        : { text: inboxLine(invItem, t), label: 'invitation', testId: 'inbox-line', urgent,
          invite: inviteNow?.ready
            ? { title: roomText('enterScene', t.lang), onClick: () => openInvite(sceneLink(invScene)), testId: 'inbox-invite', laterTestId: 'inbox-invite-no', onLater: () => { setCalled(null); letInviteGo(invItem); } }
            : inviteNow
              ? { title: roomText(inviteNow.tonight ? 'tonight' : 'seeYou', t.lang), onClick: () => void promiseTonight(invItem, inviteNow), testId: 'inbox-tonight', laterTestId: 'inbox-invite-no', onLater: () => { setCalled(null); letInviteGo(invItem); } }
              : { title: '', testId: 'inbox-invite-wait', laterTestId: 'inbox-invite-no', onLater: () => { setCalled(null); letInviteGo(invItem); } } };
    }
    if (waiting) return { wait: true, asleep: asleep ? t('home.greet.sleepy') : undefined };
    // #15 (#56): her question about what to call him, with his two answers, in place of her greeting.
    if (asked && !asleep) {
      return { text: asked.text, testId: 'call-ask', choices: [
        { label: t('call.yes'), onClick: () => void answerName(true), testId: 'call-yes', disabled: naming },
        { label: t('call.no'), onClick: () => void answerName(false), testId: 'call-no', disabled: naming }
      ] };
    }
    return { text: greeting, testId: 'greeting' };
  })();
  usePreloadOffer(offer);
  const [giftList, setGiftList] = useState<GiftsResT | null>(null);
  // C-room R3: undefined while his alarm is being read (目錄 shows 「…」, never 「未設定」 for a moment).
  const [alarm, setAlarm] = useState<AlarmViewT | null | undefined>(serverMode() ? undefined : null);
  // B-N10: what only 目錄 shows (her liked gift, his alarm) is asked for as 目錄 opens — not among her room's first requests.
  const indexAsked = useRef<string | null>(null);
  useEffect(() => { setGiftList(null); setAlarm(serverMode() ? undefined : null); indexAsked.current = null; }, [c.id]);
  const askIndex = () => {
    if (indexAsked.current === c.id) return;
    const star = indexAsked.current = c.id;
    void gifts(state, star).then((g) => { if (indexAsked.current === star) setGiftList(g); });
    if (serverMode()) void http.alarm().then((a) => { if (indexAsked.current === star) setAlarm(a.alarm); }).catch(() => { if (indexAsked.current === star) setAlarm(null); });
  };
  const liked = giftList?.gifts.find((g) => g.known);
  const nextPromise = plan[c.id]?.next ?? null;
  const [lineCount, setLineCount] = useState<Partial<Record<string, number>>>({});
  const [logs, setLogs] = useState<Partial<Record<string, Msg[]>>>({});
  const index: IndexData = {
    stars: CAST.map((m) => ({ id: m.id, label: starFirst(m, t.lang), badge: unread[m.id]?.n,
      aria: unread[m.id] ? t('inbox.unread', { name: starName(m, t.lang), n: unread[m.id]!.n }) : undefined,
      // #60: who's home now, under each name; asleep, her name dims but still opens her room (he may wake her).
      tag: <PresenceTag r={routines[m.id as StarId]} weather={freshWeather(talents, m.id)} />, dim: routines[m.id as StarId].presence === 'asleep' })),
    now: <NowLine r={routines[c.id as StarId]} credit={CAST.some((m) => freshWeather(talents, m.id)) && !room?.condition} />,
    // Her name in the switcher opens her room; with something unread that her room does not play as ② (her
    // messages), it leads there: a wake-up after the morning, her confession-day message, an item with a scene.
    // R18: picking her (a swipe, a name in 目錄) always opens her room. What she left for him presents there, as A2
    // has it: her messages and the day's notes as ②, an item with a scene as her line and ✦, her due alarm as ⑥.
    onPick: (id) => startTransition(() => actions.setStar(id as StarId)),
    stage: rel ? stageLabel(rel, t) : starName(c, t.lang),
    // M6: their first day together is day 1 (a new member read 第0天).
    days: Math.max(1, rel?.daysTogether ?? 1),
    progress: rel?.progress ?? 0,
    bond: rel && (
      <p className="room2-rel">
        <span className="serif" data-testid="rel-hint">{t(`rel.hint.${rel.hint}` as Key)}</span>
        {rel.anniversary && <span data-testid="rel-anniv">{t('rel.anniv', { date: fmtDate(`${rel.anniversary}T12:00:00+09:00`, t.lang) })}</span>}
      </p>
    ),
    // #54: never her XP or the thresholds; closeness reads as how far along this stage they are (0–100).
    closeness: Math.round((rel?.progress ?? 0) * 100),
    giftHint: liked ? t('gift.knownList', { first, list: giftName(liked.id, t.lang) }) : null,
    promise: nextPromise,
    // Round 12: on his own clock; the cell says when, its label says when and what (her words without a frozen 「明日」).
    // C-room L9: her wake-up promise is the morning she wakes him (his alarm's ring), never a script's "+12h".
    promiseWhen: nextPromise ? promiseAt(nextPromise, t.lang, alarm ?? null) : null,
    promiseState: nextPromise ? promiseState(nextPromise, alarm ?? null).state : null,
    promiseLabel: nextPromise ? t('promise.label', { first, text: timelessPromise(nextPromise.text), when: promiseAt(nextPromise, t.lang, alarm ?? null) }) : null,
    alarm: alarm === undefined ? undefined : alarm?.enabled ? `${alarm.time} ${starFirst(getStar(alarm.star), t.lang)}` : null,
    // L8: 記錄's count is the server's (asked as 目錄 opens), never 「共 0 句」 before her history has been read here.
    linesTonight: serverMode() ? lineCount[c.id] ?? null : state.chats[c.id].filter((m) => m.from !== 'system').length,
    // C-room L9: 記錄 opens her log in her room (the server's, read as 目錄 opens; prototype mode's own).
    log: serverMode() ? logs[c.id] ?? null : state.chats[c.id],
    onOpen: () => { askIndex(); void history(c.id as StarId).then((h) => { if (h) { setLineCount((n) => ({ ...n, [c.id]: h.filter((m) => m.from !== 'system').length })); setLogs((l) => ({ ...l, [c.id]: h })); } }).catch(() => undefined); },
    unread: state.inbox.filter((i) => !i.readAt).length,
    inboxTotal: state.inbox.length,
    freePulls: state.freePulls,
    extra: (
      <>
        {nextPromise?.kind === 'wakeup' && serverMode() && <AlarmProposal key={nextPromise.id} star={c.id} first={first} promise={nextPromise} />}
        {day && <p className="reward fresh serif" data-testid="calendar-day" aria-label={t('cal.title')} style={{ alignSelf: 'flex-start', margin: 0, fontSize: 12 }}>{calendarLabel(day, first, t)}</p>}
        <div className="rewards" data-testid="rewards">
          <Link to="/gacha" className="reward"><Icon name="check" size={12} />{t('pts.daily', { n: 100 })}</Link>
          {room?.condition && <Suspense fallback={null}><WeatherChip room={room} /></Suspense>}
        </div>
        {isDemo() && (
          <details className="demo-menu" data-testid="demo-menu">
            <summary className="reward serif" data-testid="demo-menu-open" style={PILL}><span className="badge r-SR">{t('home.demoTag')}</span>{t('home.demoMenu')}</summary>
            <div className="demo-menu-items">
              <Link to={`/me/scene/${DEMO_SCENE_ID}`} className="reward serif" data-testid="scene-entry" style={PILL}>{t('scene.demoEntry')}<Icon name="play" size={14} /></Link>
              {serverMode() && <Link to="/me/preview" className="reward serif" data-testid="scene-previews-entry" style={PILL}>{t('scene.previewList')}<Icon name="play" size={14} /></Link>}
              {conf?.phase !== 'due' && <button type="button" className="reward serif" data-testid="confession-demo" onClick={() => void confessionDay()} style={{ ...PILL, border: 0, fontSize: 13 }}>{t('confession.demo')}</button>}
            </div>
          </details>
        )}
      </>
    )
  };
  // #12: her call rings in her voice; refused autoplay (or his sound off) leaves a tap to hear her.
  // H1: her call belongs to her room. In another woman's room it is a small 「奈奈來電」 line that takes him to hers —
  // never her ring card, her line and her buttons over this one's face, and her ringtone only where she is.
  const ringHere = !!ringing && ringing.star === c.id;
  const ringtone = useRingtone(ringHere ? ringtoneOf(ringing!) : null);
  const calling = ringing && !ringHere ? { first: starFirst(getStar(ringing.star), t.lang), onOpen: () => startTransition(() => actions.setStar(ringing.star)) } : null;
  const incoming: Incoming | null = ringing && ringHere ? {
    star: ringing.star, idx: CAST.findIndex((m) => m.id === ringing.star), name: starName(getStar(ringing.star), t.lang), first: starFirst(getStar(ringing.star), t.lang),
    romaji: getStar(ringing.star).romaji, line: inboxLine(ringing, t), hour: new Date().getHours(),
    wakeup: ringing.kind === 'wakeup', onAnswer: () => void answerCall(), onSnooze: () => void laterCall(),
    // #14: her invitation is answered or put off (下次吧); her alarm is snoozed once a morning — her second call has no
    // 再睡5分鐘 (U-41: it would only be refused).
    later: ringing.kind !== 'wakeup' ? 'notNow' : ringing.payload.snooze === true ? null : 'snooze',
    ring: ringtone
  } : null;
  const onListen = useCallback((on: boolean) => setListening(on), []);
  const onTalk = useCallback((on: boolean) => {
    setTalking(on);
    if (!on || c.id !== 'eimi') return;
    const keys = look === EIMI_BONUS_CARD_ID ? EIMI_BONUS_REACTIONS : reactionKeysFor(c.id);
    const key = keys[responseClipIndex.current % keys.length];
    responseClipIndex.current += 1;
    const clip = look === EIMI_BONUS_CARD_ID ? eimiBonusReaction(key as typeof EIMI_BONUS_REACTIONS[number]) : mediaFor(`${c.id}-react-${key}`, portrait);
    if (!clip) return;
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    reactionTimer.current = null;
    setReactionLeaving(false);
    setReaction({ key: Date.now(), clip });
  }, [c.id, look, portrait]);
  const [lipsync, setLipsync] = useState<LipsyncShot | null>(null);
  // Each clip cropped around her face (data/faces.gen.json, a small file fetched with her room): her clip is shown once
  // it is here, so it never moves under him once it has painted (clipLook keeps it unseen until then).
  const faces = useFaces();
  const ready = lookReady;
  const look0 = clipLook(scene, faces), lookL = clipLook(listenClip, faces), lookT = clipLook(talkClip, faces);
  return (
    <div className={`page member home room-v2 has-scene tod-${tod}${pure ? ' room-pure' : ''}`} style={{ '--accent': THEME[c.id].accent } as React.CSSProperties}>
      <div className="home-stage" aria-hidden="true" data-look={look} data-talking={talking && !!talkClip ? '' : undefined} data-listening={listening && !talking && !!listenClip ? '' : undefined}>
        {scene && ready && <SceneVideo key={scene.id} entry={scene} active className={`top-media depth-enter${look0.className}`} style={look0.style} />}
        {scene && ready && listenClip && <SceneVideo key={listenClip.id} entry={listenClip} active={listening && !talking} className={`top-media room-talk-clip room-listen-clip${listening && !talking ? ' on' : ''}${lookL.className}`} style={lookL.style} />}
        {scene && ready && talkClip && <SceneVideo key={talkClip.id} entry={talkClip} active={talking} className={`top-media room-talk-clip${talking ? ' on' : ''}${lookT.className}`} style={lookT.style} />}
        {/* #73: her sentence lip-synced onto that talk loop, over it while her audio sounds (lib/lipsync.ts): rendered
            onto that very loop, so it takes the loop's own crop and box (clipLook) and lands on her mouth exactly. */}
        {scene && ready && talkClip && lipsync && (
          <RoomLipsync key={lipsync.key} src={lipsync.src} playing={lipsync.playing} className={`scene top-media room-talk-clip room-lipsync${talking ? ' on' : ''}${lookT.className}`} style={lookT.style} videoClassName="scene-video" />
        )}
        {reaction && <SceneVideo key={reaction.key} entry={reaction.clip} active loop={false} className={`top-media room-talk-clip room-react on${reactionLeaving ? ' is-dissolving' : ''}${clipLook(reaction.clip, faces).className}`} style={clipLook(reaction.clip, faces).style} onDone={finishReaction} />}
        <i className="tod-light" />
        {needsLayer(room) && <Suspense fallback={null}><WeatherLayer room={room} faceAt={faceOnScreen} /></Suspense>}
        {decor && <Suspense fallback={null}><SeasonDecor kind={decor} accent={THEME[c.id].accent} /></Suspense>}
      </div>
      <RoomV2 key={c.id} star={c.id as StarId} idx={CAST.findIndex((m) => m.id === c.id)} name={starName(c, t.lang)} first={first} romaji={c.romaji}
        date={date} place={place} sky={sky} days={rel ? Math.max(1, rel.daysTogether) : null} slot={clock === 'morning' ? 'morning' : clock === 'day' ? 'day' : 'night'} lead={lead}
        interject={giftSaid && giftSaid.star === c.id && giftSaid.at > dueTick
          ? { text: giftSaid.text, testId: 'greeting', id: `gift-${giftSaid.at}`, ...('wait' in lead ? {} : { label: lead.label, invite: lead.invite, groupTestId: lead.groupTestId, groupLabel: lead.groupLabel }) }
          : dueTick && !('wait' in lead) && lead.invite ? { ...lead, id: String(dueTick) } : null}
        messages={messages} messageStill={messageStill} onMessagesRead={(ids) => {
          // N-44: one request for the ones he saw (never an invitation he has not); prototype mode reads them one by one.
          if (serverMode()) void readHerLines(c.id, false, ids).then((r) => { if (r) actions.setInbox(r); });
          else for (const id of ids) void readInbox(id).then((r) => { if (r) actions.inboxRead(r); });
        }}
        incoming={incoming} calling={calling} index={index} onTalking={onTalk} onListening={onListen} talkClip={talkClip?.id} onLipsync={setLipsync} onToast={setToast} onGift={onGift}
        giftEffect={reaction ? { key: reaction.key, clip: reaction.clip, leaving: reactionLeaving, onDone: finishReaction } : null}
        onTapHer={tapHer} onPure={setPure} />
      <Toast msg={toast} />
      <TabBar />
    </div>
  );
}

const SKY_KEY: Record<string, Key> = { clear: 'wx.clear', cloudy: 'wx.cloudy', fog: 'wx.fog', rain: 'wx.rain', snow: 'wx.snow', thunder: 'wx.thunder' };

/**
 * The server's conversation, with what was said on this screen and is not in it yet (N-50): his message on its way
 * (sent as the chat opened, before the history came back) and the replies that followed stay where they were.
 */
export function mergeHistory(server: Msg[], local: Msg[], here: ReadonlySet<string>): Msg[] {
  // M10: his lines that did not go (on any screen, any visit) are never in the server's copy: they stay, still marked.
  const mine = local.filter((m) => here.has(m.id) || m.failed);
  if (!mine.length) return server;
  const tail = server.slice(-(mine.length * 2 + 2));
  const missing = mine.filter((m) => !tail.some((s) => s.from === m.from && s.text === m.text));
  return missing.length ? [...server, ...missing] : server;
}

export function Chat() {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const c = getStar(state.star);
  const her = useHerVoice(c.id, t.lang);
  const sound = useSound();
  const first = starFirst(c, t.lang);
  const msgs = state.chats[c.id];
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  // Talents whose conversation was empty when this screen opened: she opens with a line, and it stays for the visit.
  const [fresh] = useState<Set<string>>(() => new Set(Object.entries(state.chats).filter(([, m]) => m.length === 0).map(([id]) => id)));
  const query = new URLSearchParams(useLocation().search);
  // A reply picked on the home page (?say=) is sent on arrival, like the guest trial does (once, see below).
  const [picked] = useState(() => (query.get('say') ?? new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('say') ?? '').trim().slice(0, 500));
  const [draft, setDraft] = useState('');
  // An inbox item opened from the home (?inbox=<id>) is her opening line for this visit, and is marked read.
  const inboxId = query.get('inbox');
  // The cached copy shows at once (and stays if marking it read fails); the server's copy replaces it.
  const [opened, setOpened] = useState<InboxItemT | null>(() => state.inbox.find((i) => i.id === inboxId) ?? null);
  // Promises (#59): her proposal for the next time (from the API, only while none with her is open), whether she is
  // making it now, whether he already answered it this visit, and a promise made here (shown where it was made).
  const [proposal, setProposal] = useState<PromiseProposalT | null>(null);
  // M9: 目錄's 約定 opens this page: the next promise with her is the first thing on it.
  const [nextPromise, setNextPromise] = useState<PromiseItemT | null>(null);
  const [offer, setOffer] = useState<'idle' | 'leaving' | null>(null);
  const [answered, setAnswered] = useState(false);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<{ at: number; promise: PromiseItemT } | null>(null);
  const [keptScene, setKeptScene] = useState<string | null>(null);
  // #56: her question when the relationship reached a new way to call him; asked once, his answer is kept.
  const [callAsk, setCallAsk] = useState<BondResT['ask']>(null);
  const [answering, setAnswering] = useState(false);
  useEffect(() => {
    let live = true;
    setCallAsk(null);
    void bondOf(c.id, t.lang).then((b) => { if (live) setCallAsk(b?.ask ?? null); });
    return () => { live = false; };
  }, [c.id, t.lang]);
  async function answerCall(accept: boolean) {
    if (!callAsk) return;
    setAnswering(true);
    try {
      const r = await answerCallName(c.id, callAsk.to, accept, t.lang);
      // Her question and her answer are in the conversation now (the server stored both).
      actions.chatAppend(c.id, [{ id: uid(), from: 'her', text: callAsk.text }, { id: uid(), from: 'her', text: r.reply }]);
      setCallAsk(null);
    } catch (e) {
      // Answered in another tab: she is no longer asking.
      if (errorCode(e) === 'not_asking') setCallAsk(null);
      else setToast(t('call.failed'));
    } finally {
      setAnswering(false);
    }
  }
  // Messages sent on this screen: her opening line stays above them, where it was when he read it.
  const [sentHere] = useState(() => new Set<string>());
  const [toast, setToast] = useToast();
  // Sending and her streamed reply (N-58 failed send, the daily limit): shared with her room's live conversation.
  const talk = useChatSend(c.id, {
    sentHere, onToast: setToast,
    speak: her.speak,
    onStart: () => { setSceneAsk(null); setPickupAsk(null); },
    onResult: (r, add, before) => {
      // Both agreed on a time in this turn (#59): the note goes right after her reply.
      if (r.promise) { setMade({ at: before + 1 + add.length, promise: r.promise }); setProposal(null); }
      if (r.scene) setSceneAsk(r.scene);
      if (r.pickup && CARD_BY_ID[r.pickup.cardId]) setPickupAsk(r.pickup);
    }
  });
  const { busy, live, failed, left, deliver } = talk;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }); }, [msgs.length, busy, live]);
  // Server mode: the conversation lives in the API (including the trial messages claimed at sign-up).
  useEffect(() => {
    let live = true;
    // N-50: the server's copy never wipes what he just sent (a reply from the home goes out as the chat opens).
    history(c.id).then((h) => { if (live && h) actions.setChat(c.id, mergeHistory(h, msgsRef.current, sentHere)); }).catch(() => { /* keep the cached copy */ });
    return () => { live = false; };
  }, [c.id, actions, sentHere]);
  // N-44: opening her chat reads all her delivered lines in one request (not only the one he tapped, not one request
  // each), and so does leaving it — lines that came while he was here too: her badge on the home clears.
  useEffect(() => {
    if (!serverMode()) return;
    let live = true;
    void (async () => {
      const r = await readHerLines(c.id);
      if (!live || !r) return;
      actions.setInbox(r);
      const h = await history(c.id).catch(() => null);
      if (live && h) actions.setChat(c.id, mergeHistory(h, msgsRef.current, sentHere));
    })();
    return () => { live = false; void readHerLines(c.id, true); };
  }, [c.id, actions, sentHere]);
  useEffect(() => {
    if (!inboxId) return;
    let live = true;
    void readInbox(inboxId).then((r) => {
      if (!live || !r) return;
      actions.inboxRead(r);
      actions.setStar(r.item.star);
      setOpened(r.item);
      // Her promise line opened in time is her keeping it; a promised scene can be played again from here.
      if (r.promise?.status === 'kept' && r.promise.kind === 'scene' && r.promise.sceneId) setKeptScene(r.promise.sceneId);
    });
    return () => { live = false; };
  }, [inboxId, actions]);
  useEffect(() => {
    let live = true;
    setProposal(null);
    setNextPromise(null);
    void promises(c.id, t.lang).then((r) => { if (live) { setProposal(r?.proposal ?? null); setNextPromise(r?.promises.find((x) => x.star === c.id) ?? null); } });
    return () => { live = false; };
  }, [c.id, t.lang]);
  // After he talked with her this visit, ten quiet minutes are her cue to bring up the next time.
  const canOffer = !!proposal && !answered && !offer && sentHere.size > 0;
  useEffect(() => {
    if (!canOffer || busy) return;
    const timer = setTimeout(() => setOffer('idle'), PROMISE_RULES.idleProposeMs);
    return () => clearTimeout(timer);
  }, [canOffer, busy, msgs.length]);
  /** His answer to her proposal; when she asked as he was leaving, he then leaves. */
  async function answer(yes: boolean) {
    const leaving = offer === 'leaving';
    if (yes && proposal) {
      setMaking(true);
      try {
        setMade({ at: msgs.length, promise: await makePromise(c.id, proposal.lineId, t.lang) });
      } catch {
        setToast(t('promise.failed'));
      } finally {
        setMaking(false);
      }
    }
    setAnswered(true);
    setOffer(null);
    setProposal(null);
    if (leaving) nav('/me/home');
  }
  // Her message (#58) opened once is also her line in the conversation: when the history already has it, it shows there.
  const inHistory = !!opened?.payload.herMessage && msgs.some((m) => m.from === 'her' && m.text === inboxLine(opened, t));
  const opener = opened && opened.star === c.id && !inHistory ? opened : null;
  // #65: an inbox item that names a scene (wake-up, goodnight, a promise due, first snow…) offers it right here.
  const [inboxOffer, setInboxOffer] = useState<Offer | null>(null);
  useEffect(() => {
    if (!opener || typeof opener.payload.sceneId !== 'string') return;
    let live = true;
    void roomOffer(opener.star, opener.id).then((o) => { if (live) setInboxOffer(o); });
    return () => { live = false; };
  }, [opener?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // #65: he asked for a scene and she said yes (it opens after her line), or offered another (a button, never forced).
  const [sceneAsk, setSceneAsk] = useState<NonNullable<ChatSendResT['scene']> | null>(null);
  // #78: she mentioned her variant he does not have and its Pickup is live — a small link under her line, nothing more.
  const [pickupAsk, setPickupAsk] = useState<NonNullable<ChatSendResT['pickup']> | null>(null);
  useEffect(() => {
    if (sceneAsk?.action !== 'start') return;
    const id = setTimeout(() => nav(sceneLink(sceneAsk.sceneId)), SCENE_START_DELAY_MS);
    return () => clearTimeout(id);
  }, [sceneAsk, nav]);
  const openerAt = opener ? (() => { const i = msgs.findIndex((m) => sentHere.has(m.id)); return i < 0 ? msgs.length : i; })() : -1;

  // Batched memory: when he leaves her chat (another page, or the tab closing), her memory takes in what it has not yet
  // instead of at his next message (nothing pending costs the API one read, no model call); the tick catches the rest.
  useEffect(() => {
    const leave = () => { if (serverMode() && getToken()) void leaveChat(c.id).catch(() => 0); };
    addEventListener('pagehide', leave);
    return () => { removeEventListener('pagehide', leave); leave(); };
  }, [c.id]);

  const field = useRef<HTMLInputElement>(null);
  const sendRef = useRef<(text: string) => boolean>(() => false);
  // Voice (#72): what he says goes the same way as what he types; if it cannot go yet, it waits in the box.
  const auto = useRef(false);
  const voice = useVoice({ onStart: stopVoice, onFinal: (said) => { if (!sendRef.current(said)) setDraft(said); }, onNotice: setToast, field, auto });
  // #72: hands-free listens only while nothing of hers is on its way and the box is empty.
  const [handsFree, setHandsFreeOn, canHandsFree] = useHandsFree(voice, !busy && left !== 0 && !draft.trim(), auto, setToast);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (voice.listening) { voice.ctl.toggle(); return; }
    if (send(draft)) setDraft('');
  }
  const send = talk.send;
  sendRef.current = send;
  // The home page's reply goes out once; the ?say= is dropped from the address so a reload does not repeat it.
  const sentPicked = useRef(false);
  useEffect(() => {
    if (!picked || sentPicked.current) return;
    sentPicked.current = true;
    nav('/me/chat', { replace: true });
    if (!send(picked)) setDraft(picked);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page member chat chat-night chat-editorial" data-star={c.id}>
      <div className="chat-main">
        <aside className="chat-stage" aria-label={starName(c, t.lang)}>
          <picture><source media="(max-width: 1023px)" srcSet={LIVE_COVERS[c.id].desktop} /><img src={LIVE_COVERS[c.id].mobile} alt="" loading="eager" decoding="async" /></picture>
          <div className="chat-stage-copy">
            <span className="chat-stage-kicker">✦ JSTAR · 1:1</span>
            <strong>{starName(c, t.lang)}</strong>
            <p>{t(`star.${c.id}.line` as Key)}</p>
            <span className="chat-stage-ai">{t('common.aiBadge')}</span>
          </div>
        </aside>
        <div className="chat-conversation">
      <header className="chat-hdr">
        <Link to="/me/home" className="icon-btn" aria-label={t('chat.backHome')} onClick={(e) => {
          // Before he leaves her room, she brings up the next time once (#59).
          if (proposal && !answered && !offer && sentHere.size > 0) { e.preventDefault(); setOffer('leaving'); }
        }}><Icon name="back" /></Link>
        <StarAvatar id={c.id} />
        <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <span className="serif" style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{starName(c, t.lang)}</span>
          {/* Two pieces that wrap as wholes (N-28): at 375 px the closeness goes to a second line instead of being cut. */}
          <span className="tiny muted" data-testid="chat-sub" style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, lineHeight: 1.35 }}>
            <span>{t('common.aiBadge')}</span>
            {/* C-room L10: one 親密度 — how far along this stage they are (0–100), as 目錄 reads it; never her XP level. */}
            <span style={{ whiteSpace: 'nowrap' }} data-testid="chat-closeness">{roomText('closeness', t.lang, { n: Math.round((relationshipOf(state, c.id)?.progress ?? 0) * 100) })}</span>
          </span>
        </span>
        {her.available && (
          <button type="button" className={`icon-btn sound-btn${her.on && sound ? ' on' : ''}`}
            aria-label={her.on && sound ? t('top.soundOff') : t('top.soundOn')} aria-pressed={her.on && sound}
            onClick={() => {
              const next = !(her.on && sound);
              her.setOn(next);
              setSound(next);
            }}>
            <Icon name={her.on && sound ? 'speaker' : 'mute'} size={20} />
          </button>
        )}
        <GiftButton className="icon-btn" style={{ fontSize: 20 }} onSent={(r) => {
          const add: Msg[] = [{ id: uid(), from: 'system', text: t('gift.sent', { gift: giftName(r.giftId, t.lang) }) }, { id: uid(), from: 'her', text: r.reaction }];
          for (const m of add) sentHere.add(m.id);
          actions.chatAppend(r.star, add);
        }} />
        <span className="tiny" data-testid="chat-left" style={{ padding: '4px 10px', border: '1px solid', borderRadius: 12, whiteSpace: 'nowrap' }}>{left === null ? t('chat.unlimited') : t('chat.left', { n: left })}</span>
      </header>
      <OfflineLine />
      <div className="chat-body" role="log" aria-live="polite" aria-label={t('trial.log', { name: starName(c, t.lang) })}>
        {nextPromise && !made && (
          <p className="tiny" data-testid="chat-promise" style={{ margin: 0, alignSelf: 'center', textAlign: 'center', color: 'var(--rose-glow)' }}>
            ✦ {t('promise.label', { first, text: timelessPromise(nextPromise.text), when: promiseAt(nextPromise, t.lang) })}
          </p>
        )}
        {/* Opening line only for a conversation that was new when the screen opened; it never claims a shared past. */}
        {!opener && !inHistory && (fresh.has(c.id) || msgs.length === 0) && <p className="msg her" data-testid="chat-opener">{t(`star.${c.id}.greet` as Key)}</p>}
        {msgs.map((m, i) => (
          <Fragment key={m.id}>
            {/* What she sent on her own follows what was said before: it was the newest thing between you. */}
            {i === openerAt && opener && <p className="msg her fade-in" data-testid="chat-inbox">{inboxLine(opener, t)}</p>}
            {i === openerAt && opener && keptScene && !inboxOffer && <PromisedScene sceneId={keptScene} />}
            {i === made?.at && <PromiseMade promise={made.promise} />}
            {m.kind === 'memory'
              ? <Link to="/me/cards?tab=memory" className="panel small fade-in" style={{ padding: 12 }}><span style={{ color: 'var(--rose-text)' }}>{t('chat.memory', { title: m.text })}</span><br /><span className="tiny muted">{t('chat.viewCard')}</span></Link>
              : <p className={`msg ${m.from}${failed.has(m.id) ? ' failed' : ''}`}>{m.text}</p>}
            {failed.has(m.id) && (
              // B-R1: on her chat's night, the room's rose-glow (AA), never rose-text (2.3:1 on navy).
              <p className="tiny" role="alert" data-testid="chat-failed" style={{ alignSelf: 'flex-end', margin: '-6px 0 0', display: 'flex', gap: 8, alignItems: 'center', color: 'var(--rose-glow)' }}>
                {SEND_FAILED[t.lang].msg}
                <button type="button" className="btn-text" style={{ minHeight: 32, fontSize: 12, color: 'inherit' }} disabled={busy} onClick={() => void deliver(m.text, m.id)}>{SEND_FAILED[t.lang].resend}</button>
              </p>
            )}
          </Fragment>
        ))}
        {openerAt === msgs.length && opener && <p className="msg her fade-in" data-testid="chat-inbox">{inboxLine(opener, t)}</p>}
        {openerAt === msgs.length && opener && keptScene && !inboxOffer && <PromisedScene sceneId={keptScene} />}
        {made && made.at >= msgs.length && <PromiseMade promise={made.promise} />}
        {callAsk && !busy && (
          <div className="fade-in" data-testid="call-ask" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <p className="msg her" style={{ margin: 0 }}>{callAsk.text}</p>
            <div role="group" aria-label={t('call.title')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-navy" style={{ minHeight: 44, fontSize: 14 }} disabled={answering} onClick={() => void answerCall(true)} data-testid="call-yes">{t('call.yes')}</button>
              <button type="button" className="btn btn-ghost" style={{ minHeight: 44, fontSize: 14 }} disabled={answering} onClick={() => void answerCall(false)} data-testid="call-no">{t('call.no')}</button>
            </div>
          </div>
        )}
        {offer && proposal && <PromiseOffer proposal={proposal} busy={making} onMake={() => void answer(true)} onLater={() => void answer(false)} />}
        {inboxOffer && <OfferBubble offer={inboxOffer} first={first} onDecline={() => { declineOffer(inboxOffer.id); setInboxOffer(null); }} />}
        {sceneAsk && !busy && (
          <Link to={sceneLink(sceneAsk.sceneId)} className="chip fade-in" data-testid="chat-scene"
            style={{ alignSelf: 'flex-start', minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="play" size={14} />{t('scene.chatStart', { title: localText(sceneAsk.title, t.lang) })}
          </Link>
        )}
        {pickupAsk && !busy && (
          <Link to="/gacha" className="small fade-in" data-testid="chat-pickup" onClick={() => actions.setGachaPool(pickupAsk.poolId)}
            style={{ alignSelf: 'flex-start', minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'underline', color: 'var(--rose-text)' }}>
            {t('chat.pickup', { title: cardTitle(CARD_BY_ID[pickupAsk.cardId], t.lang) })}
          </Link>
        )}
        {busy && (live ? <p className="msg her" data-testid="chat-live" aria-hidden="true">{live}</p> : <Typing label={t('common.typing', { first })} />)}
        {left === 0 && !busy && (
          // H2: nothing is sold in v1.1 — the limit says when it comes back and what a lucky-card code gives.
          <Link to="/me/shop" className="panel fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="chat-limit">
            <span className="serif" style={{ fontSize: 15, fontWeight: 600 }}>{t('chat.limitTitle')}</span>
            <span className="small muted">{t('chat.limitBody', { first })}</span>
            <span className="small" style={{ textDecoration: 'underline' }}>{t('chat.limitCta')}</span>
          </Link>
        )}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={onSubmit}>
        {/* B-L7: out of messages for today, no mic (the limit panel says why), as in her room. */}
        {left !== 0 && <MicButton voice={voice} className="round btn-ghost" />}
        {/* #72 hands-free: in her room, the mic listens by itself while she waits for him. */}
        <HandsFreeToggle on={handsFree} set={setHandsFreeOn} possible={canHandsFree && left !== 0} className="round btn-ghost" />
        <label htmlFor="chat-input" className="sr-only">{t('common.message')}</label>
        <input ref={field} id="chat-input" value={voice.listening ? voice.text : draft} maxLength={500} placeholder={voice.listening ? t('voice.listening') : left === 0 ? t('chat.limitTitle') : t('trial.ph')} autoComplete="off" enterKeyHint="send" disabled={left === 0}
          onChange={(e) => { if (voice.listening) voice.ctl.cancel(); setDraft(e.target.value); }} />
        <button type="submit" className="round" style={{ background: 'var(--rose)', color: 'var(--navy-deep)' }} aria-label={t('common.send')} disabled={left === 0 || (!voice.listening && (busy || !draft.trim()))}><Icon name="send" size={18} /></button>
      </form>
        </div>
      </div>
      <Toast msg={toast} />
      <TabBar />
    </div>
  );
}

/**
 * He left her chat (batched memory): POST /v1/chat/memory/flush, fire and forget, `keepalive` so it still goes out while
 * the page closes. Here rather than in services/http.ts so it stays out of the entry bundle (tests/e2e/perf.spec.ts).
 */
const leaveChat = (star: string) => fetch(`${API_BASE}/v1/chat/memory/flush`, {
  method: 'POST', keepalive: true, body: JSON.stringify({ star }), headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` }
});

/** The last 180 days of draws (server mode). */
export function GachaHistory() {
  const t = useT();
  const [rows, setRows] = useState<DrawHistoryResT['draws'] | null | undefined>(undefined);
  useEffect(() => { void drawHistory().then((r) => setRows(r ? r.draws : null)).catch(() => setRows(null)); }, []);
  return (
    <div className="page member js-nightpage">
      <Header back="/gacha" title={t('gacha.history')} />
      <div className="col pad" style={{ paddingBottom: 24 }}>
        <p className="tiny muted">{t('gacha.historyNote')}</p>
        {rows === undefined ? <p className="small muted">{t('common.loading')}</p>
          : !rows || !rows.length ? <p className="small muted" data-testid="history-empty">{t('gacha.historyEmpty')}</p>
            : (
              <ol style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="history">
                {rows.map((d) => (
                  <li key={d.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--hair)' }}>
                    <div className="tiny muted">{fmtDate(d.createdAt, t.lang)}{dotSep(t.lang)}{d.pool === 'code' ? t('gacha.fromCode') : d.pool === 'exchange' ? t('gacha.exchange') : d.pool.startsWith('star:') ? starName(getStar(d.pool.slice(5) as never), t.lang) : CARD_BY_ID[pickupCardOf(d.pool) ?? ''] ? t('gacha.pickupHead', { title: cardTitle(CARD_BY_ID[pickupCardOf(d.pool)!], t.lang) }) : t('gacha.poolAll')}{d.cost ? `${dotSep(t.lang)}${t('common.pt', { n: d.cost })}` : ''}</div>
                    <div className="small" data-testid="history-summary" style={{ marginTop: 4 }}>{drawSummary(d.cards.map((c) => c.rarity), t, t.lang)}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {d.cards.map((c, k) => { const card = CARD_BY_ID[c.id]; return <span key={k} className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><RarityBadge r={c.rarity} />{card ? cardTitle(card, t.lang) : c.id}</span>; })}
                    </div>
                  </li>
                ))}
              </ol>
            )}
      </div>
    </div>
  );
}

export function Cards() {
  const { state } = useStore();
  const t = useT();
  const [toast, setToast] = useToast();
  const loc = useLocation();
  const [tab, setTab] = useState(new URLSearchParams(loc.search).get('tab') === 'memory' ? 1 : 0);
  const [who, setWho] = useState<string>('all');
  // N-20: the scenes' titles load with the memories tab only (the scripts stay out of this page's chunk), with the
  // scene catalogue (data/media.ts) their stills are on; until both are here the cards show their stored title.
  const [titles, setTitles] = useState<typeof import('../scene/memoryTitle') | null>(null);
  // N-45: fetched as the page opens (not when the tab is picked), so the tab rarely waits for them.
  useEffect(() => {
    if (titles || !state.memories.length) return;
    let live = true;
    void Promise.all([import('../scene/memoryTitle'), loadSceneMedia()]).then(([m]) => { if (live) setTitles(m); });
    return () => { live = false; };
  }, [titles, state.memories.length]);
  const owned = CARDS.filter((c) => state.owned[c.id]);
  // Owned first (highest tier first), then the rest as silhouettes, so the collection reads as progress.
  const shown = CARDS.filter((c) => who === 'all' || c.star === who)
    .sort((a, b) => (state.owned[b.id] ? 1 : 0) - (state.owned[a.id] ? 1 : 0) || RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity]);
  return (
    <div className="page member js-nightpage">
      <div className="col col-wide">
        <header className="hdr" style={{ padding: '0 24px' }}>
          <h1 className="serif" style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '0.2em' }}>{t('cards.title')}</h1>
          <span className="small muted" data-testid="owned-count">{tab === 0 ? t('cards.owned', { n: owned.length, total: CARDS.length }) : t('cards.memCount', { n: state.memories.length })}</span>
        </header>
        <OfflineLine />
        <div role="tablist" aria-label={t('cards.kinds')} className="tabs" style={{ margin: '0 24px' }}>
          {(['cards.official', 'cards.memories'] as const).map((l, k) => <button key={l} type="button" role="tab" aria-selected={tab === k} onClick={() => startTransition(() => setTab(k))}>{t(l)}</button>)}
        </div>
        {tab === 0 && (
          <nav className="chips pad" aria-label={t('gacha.pools')} style={{ marginTop: 12, paddingBottom: 0 }}>
            {['all', ...CAST.map((c) => c.id)].map((id) => (
              <button key={id} type="button" className="chip" aria-pressed={who === id} onClick={() => startTransition(() => setWho(id))}>
                {id === 'all' ? t('gacha.poolAll') : starName(getStar(id as never), t.lang)}
              </button>
            ))}
          </nav>
        )}
        <p className="small muted pad" style={{ margin: '12px 0 0' }}>{tab === 0 ? t('cards.hintOfficial') : t('cards.hintMemory')}</p>
        {tab === 1 && <ConfessionMemories onNotice={setToast} />}
        {tab === 1 && <MemoryExportButton onNotice={setToast} />}
        <div key={`${tab}-${who}`} className="cards-grid pad" style={{ marginTop: 14, paddingBottom: 24 }}>
          {tab === 0 && shown.map((c, k) => state.owned[c.id]
            ? <CardTile key={c.id} card={c} to={`/me/cards/${c.id}`} className="deal" style={{ animationDelay: `${Math.min(k, 12) * 25}ms` }} />
            : <CardTile key={c.id} card={c} locked small />)}
          {tab === 1 && [...state.memories].reverse().map((m) => {
            const s = getStar(m.star);
            // N-20: a scene's card in the language of the moment (its scene knows the title in every language).
            // N-45: until the titles are here, a quiet placeholder — never the stored (often Japanese) title for a moment.
            const title = titles ? titles.memoryTitleIn(m, t.lang) : null;
            // #51: a scene's card shows the shot it was made on (her clip's poster).
            // N-34: every card has a picture — its own shot when this build has it, else its scene's opening shot, else her home poster.
            const has = (id: string) => !!(media(id) ?? mediaFor(id, true));
            const stillId = titles ? titles.memoryStillFor(m, has) : m.still && has(m.still) ? m.still : `${m.star}-hero`;
            const pic = stillOf(media(stillId) ?? mediaFor(stillId, true));
            return (
              <div key={m.id} className={`card deal${pic ? ' has-art' : ''}`} style={{ background: s.tint }} role="img" aria-label={`${t('cards.memories')} ${starName(s, t.lang)}${title ? `「${title}」` : ''}`} data-still={stillId}>
                {pic && <img className="art" src={pic} alt="" loading="lazy" decoding="async" draggable={false} />}
                <span className="r"><RarityBadge r="MEM" /></span>
                <span className="cap"><b>{starName(s, t.lang)}　{m.date}</b>{title === null ? <span className="cap-wait" data-testid="memory-title-wait" /> : <span>{title}</span>}</span>
              </div>
            );
          })}
        </div>
        {tab === 0 && owned.length === 0 && <p className="small pad" style={{ textAlign: 'center' }}>{t('cards.emptyA')}<Link to="/gacha" style={{ textDecoration: 'underline' }}>{t('cards.emptyGacha')}</Link>{t('cards.emptyOr')}<Link to="/serial" style={{ textDecoration: 'underline' }}>{t('cards.emptySerial')}</Link>{t('cards.emptyB')}</p>}
        {tab === 1 && state.memories.length === 0 && <p className="small pad" style={{ textAlign: 'center' }}>{t('cards.emptyMem')} <Link to="/me/home" style={{ textDecoration: 'underline' }}>{t('cards.goTalk')}</Link></p>}
      </div>
      <Toast msg={toast} />
      <TabBar />
    </div>
  );
}

export function CardDetail() {
  const { id } = useParams();
  const { state, actions } = useStore();
  const t = useT();
  const card = id ? CARD_BY_ID[id] : undefined;
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [voiceOk, setVoiceOk] = useState(true);
  const [openEp, setOpenEp] = useState<number | null>(null);
  // Opened straight from a link, the API's relationships may not be loaded yet: the story lock needs them.
  const needRel = serverMode() && !!card && !state.relView[card.star];
  useEffect(() => {
    if (!needRel) return;
    let live = true;
    void relationships().then((r) => { if (live && r) actions.setRelationships(r); });
    return () => { live = false; };
  }, [needRel, actions]);
  if (!card || !state.owned[card.id]) return <Navigate to="/me/cards" replace />;
  const s = getStar(card.star);
  const copies = state.owned[card.id];
  const rel = relationshipOf(state, card.star);
  const storyTwo = !!rel && stageAtLeast(rel.stage, STAGE_RULES.storyTwoStage);
  const line = cardLine(card, t.lang);
  const voiceSrc = card.voice ?? `/voice/${card.id}.mp3`;
  const story = card.story ? localStory(card.story, t.lang) : null;
  function toggleVoice() {
    const a = audio.current;
    if (!a) return;
    if (playing) { a.pause(); a.currentTime = 0; setPlaying(false); return; }
    void a.play().then(() => setPlaying(true)).catch(() => setVoiceOk(false));
  }
  return (
    <main className="page js-nightpage">
      <Header back="/me/cards" />
      <div className="col">
        <div className="deal" style={{ width: 'min(260px, 66vw)', margin: '4px auto 0' }}><CardTile card={card} glow={RARITY_ORDER[card.rarity] >= RARITY_ORDER.SSR} /></div>
        <section className="pad" style={{ marginTop: 22 }}>
          <span className="small muted">{starName(s, t.lang)} · Star Genesis · First Five · {card.rarity}</span>
          <h1 className="h1">{cardTitle(card, t.lang)}</h1>
          {line && <p className="serif" style={{ margin: '8px 0 0', fontSize: 15 }}>{quoted(line, t.lang)}</p>}
        </section>
        <ul className="rowlist" style={{ margin: '14px 24px 0' }}>
          {voiceOk && (
            <li><button type="button" aria-pressed={playing} onClick={toggleVoice}><span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Icon name="play" size={18} />{playing ? t('cd.playing') : t('cd.voice')}</span></button>
              <audio ref={audio} src={voiceSrc} preload="none" onEnded={() => setPlaying(false)} onError={() => setVoiceOk(false)} /></li>
          )}
          {story && story.map((ep, k) => {
            const open = k === 0 || storyTwo;
            return (
              <li key={k}>
                <button type="button" disabled={!open} aria-expanded={openEp === k} onClick={() => setOpenEp(openEp === k ? null : k)}>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{!open && <Icon name="lock" size={18} />}{t(k === 0 ? 'cd.story1' : 'cd.story2')}</span>
                  <span className="small muted">{open ? t('cd.unlocked') : t('cd.unlockAt')}</span>
                </button>
                {open && openEp === k && <p className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.9, margin: '4px 0 12px' }}>{ep}</p>}
              </li>
            );
          })}
        </ul>
        <div className="panel stack" style={{ margin: '18px 24px 0', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{t('cd.awaken')}</span><span>{Math.min(copies, CONFIG.awakenCopies)} / {CONFIG.awakenCopies}</span></div>
          <span className="track" aria-hidden="true"><i style={{ width: `${(Math.min(copies, CONFIG.awakenCopies) / CONFIG.awakenCopies) * 100}%` }} /></span>
          <p className="tiny muted" style={{ margin: 0 }}>{t('cd.awakenBody')}</p>
        </div>
        {/* #76: her variant card — its own closeness, her four scenes, and her home look from level 10. */}
        {isVariantCard(card.id) && <VariantPanel cardId={card.id} star={card.star} />}
        {/* H3: talking with her about a card is in her room. */}
        <div className="bottom"><Link
          to={`/me/home${card.rarity === 'SSR' || card.rarity === 'UR' ? `?star=${card.star}&card=${card.id}` : ''}`}
          className="btn btn-navy"
          onClick={() => {
            actions.setStar(card.star);
            if (card.rarity === 'SSR' || card.rarity === 'UR') actions.setSelectedCard(card.star, card.id);
          }}
        >{t('cd.talk')}</Link></div>
      </div>
    </main>
  );
}

export function Shop() {
  const nav = useNavigate();
  return (
    <main className="page js-nightpage charge-route">
      <ChargeModal open onClose={() => nav(-1)} />
    </main>
  );
}

/** Credits come from codes or the free test top-up; the pass from printed codes stays visible. */
export function Points() {
  const { state } = useStore();
  const t = useT();
  const passOn = passActive(state.passUntil);
  return (
    <main className="page js-nightpage">
      <Header back={true} title={t('pts.title')} />
      <div className="col">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderBottom: '1px solid var(--hair)', margin: '8px 24px 0', padding: '0 0 14px' }}>
          <span style={{ fontSize: 13 }}>{t('shop.balance')}</span>
          <span className="serif" style={{ fontSize: 26, fontWeight: 600 }} data-testid="shop-points">{t('common.pt', { n: fmtYen(state.points) })}</span>
        </div>
        <section className="panel stack" style={{ margin: '18px 24px 0', gap: 10 }}>
          <h2 className="serif" style={{ margin: 0, fontSize: 17 }}>{t('pts.earn')}</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>{t('pts.daily', { n: 100 })}</li>
            <li>{t('shop.demo')}</li>
          </ul>
        </section>
        <Link to="/me/shop" className="btn btn-rose" style={{ margin: '14px 24px 0' }}>{t('shop.testFree', { n: 1000 })}</Link>
        <section className="panel stack" style={{ margin: '14px 24px 0', background: 'var(--navy)', color: 'var(--ivory)', boxShadow: 'none', gap: 8 }}>
          <span className="serif" style={{ fontSize: 17, fontWeight: 600 }}>{t('shop.monthly')}</span>
          <span className="small" data-testid="pass-status" style={{ color: passOn ? '#E3A8B2' : 'rgba(239,232,237,0.75)' }}>{passOn ? t('shop.passUntil', { date: fmtDate(state.passUntil!, t.lang) }) : t('pts.passHow')}</span>
          <Link to="/serial" className="btn btn-rose" style={{ minHeight: 40 }}>{t('me.serial')}</Link>
        </section>
        <p className="tiny muted pad" style={{ margin: '14px 0 24px' }}>{t('pts.soon')}</p>
      </div>
    </main>
  );
}

export function MyPage() {
  const { state, actions } = useStore();
  const t = useT();
  const nav = useNavigate();
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useToast();
  // M4: his nickname, edited here (the step after his birthday asks it once).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameErr, setNameErr] = useState('');
  const [saving, setSaving] = useState(false);
  const u = state.user;
  if (!u) return <Navigate to="/signup" replace />;
  const rows: [string, string, string][] = [
    [t('me.serial'), '', '/serial'],
    [t('me.history'), t('me.historyN', { n: state.redeemedCount }), '/me/redemptions'],
    [t('me.pass'), passActive(state.passUntil) ? t('shop.passUntil', { date: fmtDate(state.passUntil!, t.lang) }) : t('me.passNone'), '/me/shop'],
    [t('me.points'), t('common.pt', { n: fmtYen(state.points) }), '/me/shop'],
    ...(serverMode() ? [[t('alarm.title'), '', '/me/alarm'] as [string, string, string]] : []),
    [t('me.guide'), '', '/menu']
  ];
  // M3: logged out, he lands on the top page and it says so (App's Notice), never on the sign-up page.
  const signOut = () => { logout(); actions.logout(true); nav('/', { replace: true }); };
  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setNameErr('');
    try {
      const { saveNickname } = await import('./account');
      await saveNickname(draft, { hydrate: actions.hydrateMe, rename: actions.rename });
      setEditing(false);
      setToast(t('call.saved'));
    } catch (x) {
      setNameErr((x as Error).message === 'invalid_name' || errorCode(x) === 'invalid_name' ? t('call.invalid', { n: BOND_RULES.nameMax }) : t('call.failed'));
    } finally { setSaving(false); }
  };
  const edit = () => { setDraft(u.named ? u.nickname : ''); setNameErr(''); setEditing(true); };
  return (
    <div className="page member js-nightpage">
      <div className="col">
        <header className="hdr" style={{ padding: '0 24px' }}><h1 className="serif" style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '0.2em' }}>{t('me.title')}</h1></header>
        <OfflineLine />
        <div className="pad" style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
          {/* M4: the star he is with (her initial if her picture cannot load), never an empty circle. */}
          <StarAvatar id={state.star} size={56} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {editing ? (
              <form onSubmit={(e) => void saveName(e)} style={{ display: 'flex', gap: 8 }} noValidate>
                <input className="input" aria-label={t('me.name')} autoComplete="nickname" maxLength={BOND_RULES.nameMax} value={draft} onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('call.placeholder')} autoFocus data-testid="nickname-input" aria-invalid={!!nameErr} style={{ minHeight: 44 }} />
                <button type="submit" className="btn btn-navy" style={{ flex: 'none', minHeight: 44 }} disabled={saving || !draft.trim()} data-testid="nickname-save">{t('call.save')}</button>
              </form>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* M4: never the stand-in made from his e-mail address — his own name, or a way to choose one. */}
                {u.named
                  ? <span style={{ fontSize: 17 }} data-testid="nickname">{u.nickname}</span>
                  : <button type="button" className="btn-text" style={{ fontSize: 15 }} onClick={edit} data-testid="nickname-set">{t('me.nameSet')}</button>}
                {u.named && <button type="button" className="btn-text" style={{ fontSize: 13, minWidth: 44 }} onClick={edit} data-testid="nickname-edit">{t('me.nameEdit')}</button>}
              </div>
            )}
            {nameErr && <p className="err small" role="alert" style={{ margin: '4px 0 0' }}>{nameErr}</p>}
            <div className="small muted">{t('me.oshi', { name: starName(getStar(state.star), t.lang) })}{dotSep(t.lang)}{u.via === 'line' ? t('me.viaLine') : t('me.viaEmail')}</div>
          </div>
        </div>
        <ul className="rowlist" style={{ margin: '24px 24px 0' }}>
          {rows.map(([l, v, to]) => <li key={l}><Link to={to}><span>{l}</span><span className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{v}<Icon name="chev" size={14} /></span></Link></li>)}
          {/* M4: the language row — the app and what the server writes for him (her wake-up, her messages) follow it. */}
          <li data-testid="lang-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, gap: 12 }}>
            <label htmlFor="me-lang">{t('me.lang')}</label>
            <select id="me-lang" className="lang-select" value={state.lang} onChange={(e) => actions.setLang(e.target.value as Lang)} style={{ minHeight: 44 }}>
              {SELECTABLE_LANGS.map((l) => <option key={l} value={l} lang={l}>{LANG_NAMES[l]}</option>)}
            </select>
          </li>
        </ul>
        <VoiceToday style={{ margin: '18px 24px 0' }} onNotice={setToast} />
        <PushOptIn star={state.star} style={{ margin: '18px 24px 0' }} />
        <CallNameSetting style={{ margin: '18px 24px 0' }} />
        <HerMessagesSetting style={{ margin: '18px 24px 0' }} />
        <MyCity style={{ margin: '18px 24px 0' }} />
        <div className="pad stack" style={{ marginTop: 18, gap: 4, paddingBottom: 24 }}>
          <button type="button" className="btn-text" style={{ textAlign: 'left' }} onClick={signOut} data-testid="logout">{t('me.logout')}</button>
          {serverMode() && <Link to="/me/account/delete" className="btn-text" style={{ textAlign: 'left', color: 'var(--err)', display: 'inline-flex', alignItems: 'center' }} data-testid="delete-account">{t('acct.delete')}</Link>}
          {!confirmReset
            ? <button type="button" className="btn-text" style={{ textAlign: 'left', color: 'var(--err)' }} onClick={() => setConfirmReset(true)}>{t('me.reset')}</button>
            : <div className="panel stack fade-in"><p className="small" style={{ margin: 0 }}>{t('me.resetBody')}</p><div className="grid2"><button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(false)}>{t('common.cancel')}</button><button type="button" className="btn btn-navy" onClick={() => { logout(); actions.resetAll(); nav('/age', { replace: true }); }}>{t('me.erase')}</button></div></div>}
        </div>
      </div>
      <Toast msg={toast} />
      <TabBar />
    </div>
  );
}
