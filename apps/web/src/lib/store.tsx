import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StarId } from '../data/cast';
import { CONFIG } from './config';
import { ensureLang, loadFonts, translate, type Key, type Lang } from '../i18n';
import { RULES, jstDay, passActive } from '@jstar/shared/rules';
import type { CardAffectionResT, GiftSendResT, VoiceStateT } from '@jstar/shared/contracts';
import type { ChatSendResT, DeviceResT, DrawResT, ExchangeResT, InboxReadResT, InboxResT, MeResT, RelationshipResT, SerialRedeemResT } from '@jstar/shared/contracts';
import { confess, countDay, freshRelationship, rewardRankOf, settle } from '@jstar/shared/relationship';
import { afterAnswer, freshConfession, type ConfessionAnswer } from '@jstar/shared/confession';
import { isStarId } from '../data/cast';
import { isCardId, starOfCard } from '../data/cardIds';
import { serverMode } from '../services/http';
import { clearSaved, initialState, load, save, type AppState, type Msg, type User } from './state';

let seq = 0;
export const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

const memoryDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};

/** Converts "messages left today" from a response back into the counter the state keeps. */
function chatCounter(left: number | null, s: AppState): Pick<AppState, 'chatDay' | 'chatUsed'> {
  return left === null ? { chatDay: s.chatDay, chatUsed: s.chatUsed } : { chatDay: jstDay(), chatUsed: Math.max(0, CONFIG.dailyFreeMessages - left) };
}

/**
 * Prototype mode (#54): a message or a scene with her today is a day together, then the relationship moves on by the
 * shared rules; the free pulls it pays are returned for the caller to add. Server mode: the API did all of it.
 */
function localTogether(s: AppState, star: StarId, xp: number): { rel: AppState['rel']; pulls: number } {
  if (serverMode()) return { rel: s.rel, pulls: 0 };
  const now = new Date().toISOString();
  const { state, pulls } = settle(countDay(s.rel[star] ?? freshRelationship(now), jstDay()), xp, now);
  return { rel: { ...s.rel, [star]: state }, pulls };
}

/**
 * Prototype mode (#77): XP that is not a day together (a gift) moves the relationship on only if its days were met;
 * before their first day together there is nothing to move. Server mode: the API did it.
 */
function localAdvance(s: AppState, star: StarId, xp: number): { rel: AppState['rel']; pulls: number } {
  const cur = s.rel[star];
  if (serverMode() || !cur) return { rel: s.rel, pulls: 0 };
  const { state, pulls } = settle(cur, xp, new Date().toISOString());
  return { rel: { ...s.rel, [star]: state }, pulls };
}

/** Member fields that belong to an account, cleared on sign-out so the next account never sees them. */
const memberReset = (): Partial<AppState> => {
  const d = initialState();
  return { user: null, chats: d.chats, affinity: d.affinity, owned: {}, selectedCards: {}, memories: [], points: 0, freePulls: 0, pity: 0, shards: 0, checkIn: d.checkIn, passUntil: null, chatDay: '', chatUsed: 0, bonusDay: null, redeemedCount: 0, lastPull: [], inbox: [], rel: {}, relView: {}, confession: {}, voice: null, variants: {} };
};

function makeActions(set: (fn: (s: AppState) => AppState) => void) {
  return {
    confirmAge: () => set((s) => ({ ...s, ageOk: true })),
    setStar: (star: StarId) => set((s) => ({ ...s, star })),
    setSelectedCard: (star: StarId, cardId: string | null) => set((s) => {
      const selectedCards = { ...s.selectedCards };
      if (cardId && s.owned[cardId] && cardId.startsWith(`s1-${star}-`)) selectedCards[star] = cardId;
      else delete selectedCards[star];
      return { ...s, selectedCards };
    }),
    setTrialStar: (trialStar: StarId) => set((s) => (s.trialStar === trialStar ? s : { ...s, trialStar, trialLog: [] })),
    trialAppend: (msgs: Msg[]) => set((s) => ({ ...s, trialLog: [...s.trialLog, ...msgs].slice(-20) })),
    setTrialLeft: (n: number) => set((s) => ({ ...s, trialLeft: Math.max(0, Math.min(CONFIG.trialMessages, n)) })),
    login: (user: User) =>
      set((s) => {
        // The trial conversation is carried into the account so she "remembers" it (server mode reloads it from the API).
        const chats = { ...s.chats, [s.trialStar]: [...s.chats[s.trialStar], ...s.trialLog] };
        return { ...s, user, chats, star: s.trialLog.length ? s.trialStar : s.star, trialLog: [] };
      }),
    /** `notice` (M3): he logged out himself — the top page says so once (an expired session says nothing). */
    logout: (notice = false) => set((s) => ({ ...s, ...memberReset(), lastRedeem: null, notice: notice ? 'loggedOut' : null })),
    /** M4: the nickname he chose (prototype mode; server mode hydrates the account the API returns). */
    rename: (nickname: string) => set((s) => (s.user ? { ...s, user: { ...s.user, nickname, named: true } } : s)),
    clearNotice: () => set((s) => (s.notice ? { ...s, notice: null } : s)),
    /** L10: the last code's reveal was played out; coming back to its result shows the cards face up. */
    redeemSeen: () => set((s) => (s.lastRedeem && !s.lastRedeem.seen ? { ...s, lastRedeem: { ...s.lastRedeem, seen: true } } : s)),
    /** M10: his line did not go — kept marked in the conversation (her room and her chat) until he sends it again. */
    chatFailed: (star: StarId, id: string) => set((s) => ({ ...s, chats: { ...s.chats, [star]: s.chats[star].map((m) => (m.id === id ? { ...m, failed: true as const } : m)) } })),
    /** Replaces the browser cache with the account as the API sees it. */
    hydrateMe: (me: MeResT) =>
      set((s) => {
        const affinity = { ...initialState().affinity };
        for (const [star, xp] of Object.entries(me.affinity)) if (isStarId(star)) affinity[star] = xp ?? 0;
        const owned = Object.fromEntries(me.owned.filter((o) => isCardId(o.cardId)).map((o) => [o.cardId, o.copies]));
        const selectedCards = Object.fromEntries(Object.entries(s.selectedCards).filter(([, cardId]) => !!cardId && !!owned[cardId]));
        return {
          ...s,
          user: { ...(s.user ?? { via: me.user.via }), nickname: me.user.nickname, ...(me.user.named === undefined ? {} : { named: me.user.named }) },
          points: me.wallet.points, freePulls: me.wallet.freePulls, pity: me.wallet.pity, shards: me.wallet.shards, checkIn: me.checkIn,
          owned, selectedCards,
          variants: Object.fromEntries(me.owned.flatMap((o) => (o.variant && isCardId(o.cardId) ? [[o.cardId, o.variant]] : []))),
          memories: me.memories.map((m) => ({ id: m.id, star: m.star, title: m.title, date: memoryDate(m.createdAt), ...(m.still ? { still: m.still } : {}), ...(m.sceneId ? { sceneId: m.sceneId } : {}), ...(m.kind ? { kind: m.kind } : {}) })),
          affinity, passUntil: me.chat.passUntil, ...chatCounter(me.chat.left, s),
          redeemedCount: me.serialsRedeemed, bonusNotice: me.dailyBonus, birthdayOk: me.birthdayConfirmed,
          voice: me.voice ?? null
        };
      }),
    /** His voice time as the API reports it after a change (#74: an extension, a charged line); `points` after an extension. */
    setVoice: (voice: VoiceStateT, points?: number) => set((s) => ({ ...s, voice, ...(points === undefined ? {} : { points }) })),
    /** Seconds left after one of her runtime lines (#73), without another round trip. */
    voiceLeftNow: (leftSeconds: number) => set((s) => (s.voice ? { ...s, voice: { ...s.voice, leftSeconds, usedSeconds: Math.max(s.voice.usedSeconds, s.voice.allowanceSeconds - leftSeconds) } } : s)),
    /** A visitor's allowance and not-yet-claimed cards, as the API sees them. */
    hydrateDevice: (d: DeviceResT) =>
      set((s) => ({
        ...s, ...memberReset(), trialLeft: d.trialLeft,
        owned: Object.fromEntries(d.cards.filter((c) => isCardId(c.cardId)).map((c) => [c.cardId, Math.max(1, Math.min(999, c.copies))]))
      })),
    /** Prototype mode stands in for the API's pass bonus. */
    localDailyBonus: () =>
      set((s) => {
        const today = jstDay();
        if (!s.user || !passActive(s.passUntil) || s.bonusDay === today) return s;
        return { ...s, bonusDay: today, points: s.points + CONFIG.passDailyPoints, bonusNotice: CONFIG.passDailyPoints };
      }),
    setInbox: (r: InboxResT) => set((s) => ({ ...s, inbox: r.items })),
    /** A variant card's state as the API answered it (#76: after pinning her home look). */
    setVariant: (r: CardAffectionResT) => set((s) => ({ ...s, variants: { ...s.variants, [r.cardId]: r.variant } })),
    /** An item was opened: the server's copy, with its read time, replaces ours, so her badge goes down at once. */
    inboxRead: (r: InboxReadResT) =>
      set((s) => ({ ...s, inbox: s.inbox.some((i) => i.id === r.item.id) ? s.inbox.map((i) => (i.id === r.item.id ? r.item : i)) : [r.item, ...s.inbox] })),
    clearBonusNotice: () => set((s) => (s.bonusNotice ? { ...s, bonusNotice: 0 } : s)),
    chatAppend: (star: StarId, msgs: Msg[]) => set((s) => ({ ...s, chats: { ...s.chats, [star]: [...s.chats[star], ...msgs].slice(-200) } })),
    setChat: (star: StarId, msgs: Msg[]) => set((s) => ({ ...s, chats: { ...s.chats, [star]: msgs.slice(-200) } })),
    applyChat: (star: StarId, r: ChatSendResT) =>
      set((s) => {
        const { rel, pulls } = localTogether(s, star, r.affinityXp);
        return {
          ...s,
          affinity: { ...s.affinity, [star]: r.affinityXp },
          freePulls: r.freePulls + pulls,
          memories: r.memoryCard ? [...s.memories, { id: r.memoryCard.id, star, title: r.memoryCard.title, date: memoryDate(r.memoryCard.createdAt) }].slice(-100) : s.memories,
          // A chat turn's view carries no confession status (#55): the one from GET /v1/relationship stays until the next.
          rel, relView: r.relationship ? { ...s.relView, [star]: { confession: s.relView[star]?.confession, ...r.relationship } } : s.relView,
          ...chatCounter(r.chatLeft, s)
        };
      }),
    /** A gift she received (#77): the wallet and her XP after it, and where the relationship stands. */
    applyGift: (star: StarId, r: GiftSendResT) =>
      set((s) => {
        const { rel, pulls } = localAdvance(s, star, r.affinityXp);
        return {
          ...s, points: r.points, freePulls: r.freePulls + pulls, affinity: { ...s.affinity, [star]: r.affinityXp }, rel,
          relView: serverMode() ? { ...s.relView, [star]: r.relationship } : s.relView
        };
      }),
    /** The API's view of all five relationships (GET /v1/relationship). */
    setRelationships: (r: RelationshipResT) => set((s) => ({ ...s, relView: Object.fromEntries(r.talents.map((v) => [v.star, v])) })),
    /**
     * What a scene granted (#64). Server mode: her affinity as the API reports it. Prototype mode: the gain is added
     * here, and the scene is a day together that can move the relationship on (#54), paying a free pull per stage
     * like chat. Memory cards are merged by id, so replaying a view is harmless.
     */
    applyScene: (star: StarId, affinityXp: number | null, gained: number, memories: { id: string; title: string; createdAt: string; still?: string }[], sceneId?: string) =>
      set((s) => {
        const before = s.affinity[star];
        const xp = affinityXp ?? before + Math.max(0, gained);
        const { rel, pulls } = localTogether(s, star, xp);
        const have = new Set(s.memories.map((m) => m.id));
        const add = memories.filter((m) => !have.has(m.id)).map((m) => ({ id: m.id, star, title: m.title.slice(0, 40), date: memoryDate(m.createdAt), ...(m.still ? { still: m.still } : {}), ...(sceneId ? { sceneId } : {}) }));
        if (xp === before && rel === s.rel && !add.length) return s;
        return { ...s, affinity: { ...s.affinity, [star]: xp }, freePulls: s.freePulls + pulls, rel, memories: [...s.memories, ...add].slice(-100) };
      }),
    /**
     * Prototype mode (#55): she reached her confession (once per round) — the home then no longer opens on it today.
     * Server mode: the API recorded it when the scene started.
     */
    reachConfession: (star: StarId) =>
      set((s) => {
        if (serverMode()) return s;
        const c = s.confession[star] ?? freshConfession();
        if (c.reachedRound >= c.tries) return s;
        return { ...s, confession: { ...s.confession, [star]: { ...c, reachedRound: c.tries, reachedOn: jstDay() } } };
      }),
    /**
     * Prototype mode (#55): his answer, as the API applies it — yes makes them lovers today (the anniversary) and
     * pays the lover stage's free pull; not yet / no makes her wait CONFESSION_RULES.retryDays days together.
     */
    applyConfession: (star: StarId, answer: ConfessionAnswer) =>
      set((s) => {
        if (serverMode()) return s;
        const now = new Date();
        const cur = s.rel[star] ?? freshRelationship(now.toISOString());
        const c = afterAnswer(s.confession[star] ?? freshConfession(), answer, cur.daysTogether, now);
        if (answer !== 'accept') return { ...s, confession: { ...s.confession, [star]: c } };
        const lovers = confess(cur, s.affinity[star], now);
        if (!lovers) return s;
        const { state, pulls } = settle(lovers, s.affinity[star], now.toISOString());
        return { ...s, rel: { ...s.rel, [star]: state }, freePulls: s.freePulls + pulls, confession: { ...s.confession, [star]: c } };
      }),
    /** Demo / prototype mode: today is her confession day (the API's POST /v1/relationship/demo does the same). */
    demoConfessionDay: (star: StarId) =>
      set((s) => {
        const now = new Date().toISOString();
        const cur = countDay(s.rel[star] ?? freshRelationship(now), jstDay());
        const rel = { ...cur, stage: 'confession_ready' as const, stageSince: now, stageDay: cur.daysTogether, confessedAt: null, anniversary: null, loverXp: null, rewardRank: Math.max(cur.rewardRank, rewardRankOf('confession_ready', null)) };
        const { [star]: _gone, ...confession } = s.confession;
        return { ...s, rel: { ...s.rel, [star]: rel }, confession };
      }),
    /** The API said the allowance is gone; the counter follows it. */
    /** B-R2: today's count as the server has it now (his chat or her room opened, or he came back to the tab). */
    chatCount: (c: { left: number | null; passUntil: string | null }) => set((s) => ({ ...s, passUntil: c.passUntil, ...chatCounter(c.left, s) })),
    chatExhausted: () => set((s) => ({ ...s, chatDay: jstDay(), chatUsed: CONFIG.dailyFreeMessages, passUntil: passActive(s.passUntil) ? null : s.passUntil })),
    applyDraw: (r: DrawResT) =>
      set((s) => {
        const owned = { ...s.owned };
        for (const c of r.cards) if (isCardId(c.id)) owned[c.id] = Math.min(999, (owned[c.id] ?? 0) + 1);
        return { ...s, owned, points: r.wallet.points, freePulls: r.wallet.freePulls, pity: r.wallet.pity, shards: r.wallet.shards, lastPull: r.cards.map((c) => c.id).filter(isCardId).slice(0, 10) };
      }),
    applyExchange: (r: ExchangeResT) =>
      set((s) => {
        const owned = { ...s.owned };
        if (isCardId(r.card.id)) owned[r.card.id] = Math.min(999, (owned[r.card.id] ?? 0) + 1);
        return { ...s, owned, points: r.wallet.points, freePulls: r.wallet.freePulls, pity: r.wallet.pity, shards: r.wallet.shards };
      }),
    /**
     * Every card of a printed code adds a copy. A duplicate also raises that talent's bond: the API does it for
     * members (and at the sign-up claim); prototype mode mirrors it for a signed-in user.
     */
    applyRedeem: (code: string, r: SerialRedeemResT) =>
      set((s) => {
        const owned = { ...s.owned };
        const affinity = { ...s.affinity };
        const cards = r.cards.filter((c) => isCardId(c.id));
        let shards = s.shards;
        for (const c of cards) {
          owned[c.id] = Math.min(999, (owned[c.id] ?? 0) + 1);
          if (!c.isNew) {
            shards += RULES.duplicateShards[c.rarity];
            if (s.user && !serverMode()) affinity[starOfCard(c.id)] += RULES.lucky.duplicateBondXp;
          }
        }
        return {
          ...s, serialFails: 0, redeemed: [...s.redeemed, code].slice(-200), redeemedCount: s.redeemedCount + 1,
          owned, affinity, shards, passUntil: r.passUntil ?? s.passUntil,
          lastRedeem: { cards: cards.slice(0, 10).map((c) => ({ id: c.id, isNew: c.isNew })), days: r.trialDays }
        };
      }),
    serialFail: (now: number) =>
      set((s) => {
        const fails = s.serialFails + 1;
        return fails >= CONFIG.serialMaxFailures
          ? { ...s, serialFails: 0, serialLockUntil: now + CONFIG.serialLockMs }
          : { ...s, serialFails: fails };
      }),
    serialLock: (until: number) => set((s) => ({ ...s, serialFails: 0, serialLockUntil: until })),
    setPoints: (points: number) => set((s) => ({ ...s, points })),
    setGachaPool: (gachaPool: string) => set((s) => ({ ...s, gachaPool })),
    setPass: (passUntil: string) => set((s) => ({ ...s, passUntil })),
    toggleSound: () => set((s) => ({ ...s, sound: !s.sound })),
    setLang: (lang: Lang) => { void ensureLang(lang).then(() => set((s) => ({ ...s, lang }))); },
    resetAll: () => { clearSaved(); set((s) => ({ ...initialState(), lang: s.lang })); }
  };
}

export type Actions = ReturnType<typeof makeActions>;
const Ctx = createContext<{ state: AppState; actions: Actions } | null>(null);

export function StoreProvider({ children, initial }: { children: ReactNode; initial?: AppState }) {
  const [state, setState] = useState<AppState>(() => initial ?? load());
  const set = useCallback((fn: (s: AppState) => AppState) => setState(fn), []);
  const actions = useMemo(() => makeActions(set), [set]);
  // Persistence is debounced and runs off the interaction path (keeps taps fast, see TEST_REPORT: INP);
  // it is flushed when the page is hidden so nothing is lost.
  const first = useRef(true);
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const id = setTimeout(() => save(latest.current), 300);
    return () => clearTimeout(id);
  }, [state]);
  useEffect(() => {
    const flush = () => save(latest.current);
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  useEffect(() => {
    document.documentElement.lang = state.lang;
    loadFonts(state.lang);
    // index.html ships the Japanese title; tabs, bookmarks and shares should read in the visitor's language (#11).
    let live = true;
    ensureLang(state.lang).then(() => { if (live) document.title = `JSTAR — ${translate(state.lang, 'top.talk')}`; }, () => {});
    return () => { live = false; };
  }, [state.lang]);
  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}

/** Translation hook: `t('top.talk')`, `t('trial.left', { n: 2 })`. */
export function useT() {
  const { state } = useStore();
  const lang = state.lang;
  return useMemo(() => {
    const t = (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars);
    return Object.assign(t, { lang });
  }, [lang]);
}
