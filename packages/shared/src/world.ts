import { STAR_IDS, type LocalText, type StarId } from './domain';

/**
 * Talent world config: who she is, where she lives, what she is doing at each hour, which days matter.
 * The single source for web, API, admin and (through apps/agent/app/world.json) the persona service,
 * so the weather (#62), routines (#60) and yearly events (#61) never keep their own copy.
 *
 * Birthday and hometown are facts about a real person: they carry `confirmed`, and nothing unconfirmed may
 * leave this file — readers go through `confirmedWorld()` / `weatherPoint()`, never through `WORLD` directly
 * (admin excepted, it shows the review state). All five birthdays and hometowns were confirmed by the owner on
 * 2026-09-28; a value added later starts unconfirmed and is flipped in a PR once signed off.
 * Routine, signature scene and call names are the app's character design (plan v2, 五人作息 / 招牌场景),
 * not biographical claims; they are signed off with the persona bible, like apps/agent/app/personas/*.yaml.
 * Where she is in her day is read through `routineNow()` (#60) by every app, on JST.
 */

/** Month and day, "MM-DD". Never a year: her age is not the app's to state. */
export type MonthDay = string;

export interface Gated<T> {
  value: T;
  /** True only once the value is confirmed for use in the app (#84; the owner confirmed the five on 2026-09-28). */
  confirmed: boolean;
  /** Why it is not confirmed yet, for the admin review page. Never shown to users. */
  note?: string;
}

/** Weather and season lookups key on the city, so a hometown change moves both together. */
export const CITY_IDS = ['tokyo', 'nagano', 'sendai', 'saitama', 'tochigi'] as const;
export type CityId = (typeof CITY_IDS)[number];

export interface Hometown {
  cityId: CityId;
  /** City-level only (plan v2: 只到城市级别); never a ward, station or address. */
  city: LocalText;
  prefecture: LocalText;
  /** The weather point: the city's (or prefectural capital's) centre, not anywhere she might live. */
  lat: number;
  lon: number;
}

/** JST hours: morning 05–11, daytime 11–17, evening 17–23, late night 23–05 (matches the web's clock slots). */
export const ROUTINE_SLOTS = ['morning', 'daytime', 'evening', 'lateNight'] as const;
export type RoutineSlot = (typeof ROUTINE_SLOTS)[number];
/** Whether she can be found at home; #60 needs at least one talent at home in every slot. */
export type Presence = 'home' | 'out' | 'asleep';
export const PRESENCES = ['home', 'out', 'asleep'] as const satisfies readonly Presence[];
/**
 * What she is doing, when it is something of her own rather than just being at home, out or asleep: the word a scene's
 * `trigger.routine` can wait for (#60 / #65, e.g. うんぱい's walk stream is only proposed while she is streaming).
 */
export const ROUTINE_ACTIVITIES = ['wake-me', 'tea', 'reading', 'walk-stream', 'chat', 'daydream', 'greenhouse', 'workout', 'work', 'ogiri'] as const;
export type RoutineActivity = (typeof ROUTINE_ACTIVITIES)[number];
export interface RoutineEntry { presence: Presence; status: LocalText; activity?: RoutineActivity }

/**
 * How she addresses him per relationship stage (#54 stage names; ambiguous / confession_ready keep `familiar`).
 * `{name}` is his name or the nickname he chose. Drafts until the persona bible is final (#56).
 */
export const CALL_STAGES = ['new', 'familiar', 'lover'] as const;
export type CallStage = (typeof CALL_STAGES)[number];

export interface TalentWorld {
  id: StarId;
  birthday: Gated<MonthDay>;
  hometown: Gated<Hometown>;
  routine: Record<RoutineSlot, RoutineEntry>;
  signatureScene: { id: string; title: LocalText };
  callNames: Record<CallStage, string>;
}

const t = (ja: string, zhHant: string, en: string, ko?: string): LocalText => ({ ja, 'zh-Hant': zhHant, en, ...(ko ? { ko } : {}) });

export const CITIES: Record<CityId, Hometown> = {
  tokyo: { cityId: 'tokyo', city: t('東京', '東京', 'Tokyo', '도쿄'), prefecture: t('東京都', '東京都', 'Tokyo', '도쿄도'), lat: 35.6895, lon: 139.6917 },
  nagano: { cityId: 'nagano', city: t('長野', '長野', 'Nagano', '나가노'), prefecture: t('長野県', '長野縣', 'Nagano', '나가노현'), lat: 36.6486, lon: 138.1948 },
  sendai: { cityId: 'sendai', city: t('仙台', '仙台', 'Sendai', '센다이'), prefecture: t('宮城県', '宮城縣', 'Miyagi', '미야기현'), lat: 38.2682, lon: 140.8694 },
  saitama: { cityId: 'saitama', city: t('埼玉', '埼玉', 'Saitama', '사이타마'), prefecture: t('埼玉県', '埼玉縣', 'Saitama', '사이타마현'), lat: 35.8617, lon: 139.6455 },
  // Prefecture-level in the plan ("栃木"); the weather point is the prefectural capital, Utsunomiya.
  tochigi: { cityId: 'tochigi', city: t('栃木', '櫪木', 'Tochigi', '도치기'), prefecture: t('栃木県', '櫪木縣', 'Tochigi', '도치기현'), lat: 36.5551, lon: 139.8828 }
};

/** Where the weather comes from while her hometown is unconfirmed (issue #48: 天气退回东京). */
export const FALLBACK_CITY: CityId = 'tokyo';

const home = t('おうちにいる', '在家', 'At home', '집에 있음');
const out = t('おでかけ中', '外出中', 'Out and about', '외출 중');
const asleep = t('ぐっすり寝てる', '睡覺中', 'Fast asleep', '푹 자는 중');

// Values from plan v2 (五人作息, 全年节点, 五人对应城市). Birthdays and hometowns confirmed by the owner (2026-09-28).
export const WORLD: Record<StarId, TalentWorld> = {
  mahiro: {
    id: 'mahiro',
    birthday: { value: '03-04', confirmed: true },
    hometown: { value: CITIES.tokyo, confirmed: true },
    routine: {
      morning: { presence: 'home', status: t('ベッドでごろごろ、起こされ待ち', '賴床中，等你叫她起床', 'Lazing in bed, waiting for you to wake her', '침대에서 뒹굴뒹굴, 깨워주길 기다리는 중'), activity: 'wake-me' },
      daytime: { presence: 'out', status: out },
      evening: { presence: 'home', status: home },
      lateNight: { presence: 'home', status: home }
    },
    signatureScene: { id: 'welcome-home', title: t('おかえりと、罰ゲーム', '歡迎回家，和懲罰遊戲', 'Welcome home — and a penalty game', '어서 와, 그리고 벌칙 게임') },
    callNames: { new: '{name}さん', familiar: '{name}くん', lover: '{name}' }
  },
  nana: {
    id: 'nana',
    birthday: { value: '09-03', confirmed: true },
    hometown: { value: CITIES.nagano, confirmed: true },
    routine: {
      morning: { presence: 'home', status: t('お茶を淹れて読書中', '泡茶、看書中', 'Brewing tea over a book', '차를 우려 독서 중'), activity: 'tea' },
      daytime: { presence: 'out', status: out },
      evening: { presence: 'home', status: t('雨の夜の読書タイム', '雨夜讀書時間', 'Reading on a rainy night', '비 오는 밤의 독서 타임'), activity: 'reading' },
      lateNight: { presence: 'asleep', status: t('もう寝てる', '已經睡了', 'Already asleep', '이미 자고 있음') }
    },
    signatureScene: { id: 'read-aloud', title: t('あなたへの朗読と、ほんとうのほめ言葉', '為你朗讀，和真正的誇獎', 'Reading aloud for you — and praise that means it', '당신을 위한 낭독, 그리고 진심 어린 칭찬') },
    callNames: { new: '{name}さん', familiar: '{name}くん', lover: '{name}' }
  },
  unpai: {
    id: 'unpai',
    birthday: { value: '07-17', confirmed: true },
    hometown: { value: CITIES.sendai, confirmed: true },
    routine: {
      morning: { presence: 'asleep', status: asleep },
      daytime: { presence: 'out', status: out },
      evening: { presence: 'out', status: t('夜さんぽ配信中', '深夜散步直播中', 'Streaming a late-night walk', '밤 산책 방송 중'), activity: 'walk-stream' },
      lateNight: { presence: 'home', status: t('おうちでまったり雑談', '在家閒聊', 'Chatting at home', '집에서 느긋하게 잡담'), activity: 'chat' }
    },
    signatureScene: { id: 'private-stream', title: t('あなただけの配信', '只給你一個人的直播', 'A stream just for you', '당신만을 위한 방송') },
    callNames: { new: '{name}さん', familiar: '{name}くん', lover: '{name}' }
  },
  alice: {
    id: 'alice',
    birthday: { value: '02-25', confirmed: true },
    hometown: { value: CITIES.saitama, confirmed: true },
    routine: {
      morning: { presence: 'asleep', status: asleep },
      daytime: { presence: 'home', status: t('午後はぼんやり', '午後發呆', 'Daydreaming through the afternoon', '오후엔 멍하니'), activity: 'daydream' },
      evening: { presence: 'home', status: t('夜の温室にいる', '在夜晚的溫室', 'In the greenhouse at night', '밤의 온실에 있음'), activity: 'greenhouse' },
      lateNight: { presence: 'home', status: home }
    },
    signatureScene: { id: 'night-greenhouse', title: t('夜の温室と、延長', '夜裡的溫室，和延長', 'The greenhouse at night — and a little longer', '밤의 온실, 그리고 연장') },
    callNames: { new: '{name}さん', familiar: '{name}くん', lover: '{name}' }
  },
  eimi: {
    id: 'eimi',
    birthday: { value: '03-18', confirmed: true },
    hometown: { value: CITIES.tochigi, confirmed: true },
    routine: {
      morning: { presence: 'out', status: t('トレーニング中', '健身中', 'Working out', '트레이닝 중'), activity: 'workout' },
      daytime: { presence: 'out', status: t('お仕事中', '工作中', 'At work', '업무 중'), activity: 'work' },
      evening: { presence: 'home', status: t('大喜利タイム', '大喜利時間', 'Ōgiri time', '오오기리 타임'), activity: 'ogiri' },
      lateNight: { presence: 'home', status: home }
    },
    signatureScene: { id: 'ogiri', title: t('大喜利お姉さん', '大喜利姐姐', 'Ōgiri big sister', '오오기리 언니') },
    // Plan v2: the teasing older sister keeps キミ even as lovers (#56).
    callNames: { new: '{name}くん', familiar: '{name}くん', lover: 'キミ' }
  }
};

/** What the app may say about her: confirmed fields only, absent otherwise (no placeholders). */
export interface ConfirmedWorld { birthday?: MonthDay; hometown?: Hometown }

export function confirmedWorld(id: StarId, world: Record<StarId, TalentWorld> = WORLD): ConfirmedWorld {
  const w = world[id];
  const out: ConfirmedWorld = {};
  if (w.birthday.confirmed) out.birthday = w.birthday.value;
  if (w.hometown.confirmed) out.hometown = w.hometown.value;
  return out;
}

/** Her weather city: the confirmed hometown, else Tokyo — the weather must never hint at an unconfirmed city. */
export function weatherPoint(id: StarId, world: Record<StarId, TalentWorld> = WORLD): Hometown {
  return confirmedWorld(id, world).hometown ?? CITIES[FALLBACK_CITY];
}

/** JST routine slot for a moment (all five live in Japan; overseas users see her hour, not theirs). */
export function routineSlot(at: Date = new Date()): RoutineSlot {
  const h = (at.getUTCHours() + 9) % 24;
  return h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'daytime' : h >= 17 && h < 23 ? 'evening' : 'lateNight';
}

/** Where she is in her day right now (#60). `status` is the phrase the home strip shows and, in English, her prompt reads. */
export interface RoutineNow {
  star: StarId;
  slot: RoutineSlot;
  presence: Presence;
  status: LocalText;
  activity: RoutineActivity | null;
}

/**
 * Her routine now, on her clock (JST), whatever the viewer's or the server's time zone. The one way every app reads a
 * routine: the home strip, her prompt, her messages and the scene triggers all ask here, never `WORLD[id].routine`.
 */
export function routineNow(id: StarId, at: Date = new Date(), world: Record<StarId, TalentWorld> = WORLD): RoutineNow {
  const slot = routineSlot(at);
  const r = world[id].routine[slot];
  return { star: id, slot, presence: r.presence, status: r.status, activity: r.activity ?? null };
}

/** All five, in cast order. */
export const routinesNow = (at: Date = new Date(), world: Record<StarId, TalentWorld> = WORLD): RoutineNow[] =>
  STAR_IDS.map((id) => routineNow(id, at, world));

/** Whether a scene's `trigger.routine` holds: it names her presence (`home` / `out` / `asleep`) or an activity. */
export const routineMatches = (condition: string, r: Pick<RoutineNow, 'presence' | 'activity'>): boolean =>
  condition === r.presence || condition === r.activity;

const SLOT_STARTS_JST = [5, 11, 17, 23];
/** The next JST slot boundary after `at` (05, 11, 17, 23 o'clock): when a view of the routines must look again. */
export function nextRoutineChange(at: Date = new Date()): Date {
  const hour = 3600_000;
  const jst = at.getTime() + 9 * hour;
  const dayStart = jst - (jst % (24 * hour));
  const next = SLOT_STARTS_JST.map((h) => dayStart + h * hour).find((t) => t > jst) ?? dayStart + (24 + SLOT_STARTS_JST[0]) * hour;
  return new Date(next - 9 * hour);
}

export function callNameFor(id: StarId, stage: CallStage, name: string): string {
  return WORLD[id].callNames[stage].replace('{name}', name);
}

// ---------------------------------------------------------------- seasons

export const SEASON_IDS = ['hatsumode', 'sakura', 'fireworks', 'christmas'] as const;
export type SeasonId = (typeof SEASON_IDS)[number];
/** Inclusive; `from` after `to` wraps the new year. */
export interface DayWindow { from: MonthDay; to: MonthDay }
export interface Season { id: SeasonId; name: LocalText; window: DayWindow | Record<CityId, DayWindow> }

/**
 * Yearly calendar shared by every user. Dates are rough until planning fixes them (#61); users' own
 * anniversaries are per-user data (#54), not here. Sakura follows her city, from about the JMA normal
 * first-bloom date (1991–2020) to the end of full bloom — Sendai and Nagano run two to three weeks behind Tokyo.
 */
export const SEASONS: Season[] = [
  { id: 'hatsumode', name: t('初詣', '新年參拜', 'New Year shrine visit', '새해 첫 참배'), window: { from: '01-01', to: '01-03' } },
  {
    id: 'sakura', name: t('お花見', '賞櫻', 'Cherry blossoms', '꽃놀이'),
    window: {
      tokyo: { from: '03-24', to: '04-03' },
      saitama: { from: '03-26', to: '04-05' },
      tochigi: { from: '03-30', to: '04-09' },
      sendai: { from: '04-08', to: '04-17' },
      nagano: { from: '04-12', to: '04-21' }
    }
  },
  { id: 'fireworks', name: t('花火', '煙火大會', 'Summer fireworks', '불꽃놀이'), window: { from: '07-20', to: '08-31' } },
  { id: 'christmas', name: t('クリスマス', '聖誕節', 'Christmas', '크리스마스'), window: { from: '12-24', to: '12-25' } }
];

const isDayWindow = (w: Season['window']): w is DayWindow => typeof (w as DayWindow).from === 'string';

/** The season's window in her (weather) city. */
export function seasonWindow(season: Season, id: StarId, world: Record<StarId, TalentWorld> = WORLD): DayWindow {
  return isDayWindow(season.window) ? season.window : season.window[weatherPoint(id, world).cityId];
}

const inWindow = (md: MonthDay, w: DayWindow) => (w.from <= w.to ? md >= w.from && md <= w.to : md >= w.from || md <= w.to);

/** Seasons running on a JST month-day for her. */
export function seasonsOn(md: MonthDay, id: StarId, world: Record<StarId, TalentWorld> = WORLD): SeasonId[] {
  return SEASONS.filter((s) => inWindow(md, seasonWindow(s, id, world))).map((s) => s.id);
}

// ---------------------------------------------------------------- persona service

/**
 * The persona service is Python and cannot import this file, so it reads a generated copy
 * (apps/agent/app/world.json, `npm run world:agent -w @jstar/shared`; a test fails when it is stale).
 * Only confirmed facts are written: an unconfirmed birthday never reaches a prompt.
 */
export function agentWorld(world: Record<StarId, TalentWorld> = WORLD): Record<StarId, ConfirmedWorld> {
  return Object.fromEntries(STAR_IDS.map((id) => [id, confirmedWorld(id, world)])) as Record<StarId, ConfirmedWorld>;
}

export function agentWorldJson(world: Record<StarId, TalentWorld> = WORLD): string {
  const doc = {
    _generated: 'From packages/shared/src/world.ts by `npm run world:agent -w @jstar/shared`. Do not edit; only agency-confirmed facts.',
    talents: agentWorld(world)
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

// ---------------------------------------------------------------- validation

/**
 * Japan as four boxes (Hokkaido, Honshu + Shikoku, Kyushu, the Nansei islands). One box would also
 * take in Seoul and Busan, so a swapped latitude / longitude could pass unnoticed.
 */
const JAPAN: [latMin: number, latMax: number, lonMin: number, lonMax: number][] = [
  [41.3, 45.6, 139.3, 145.9],
  [32.7, 41.6, 130.8, 142.1],
  [30.9, 34.0, 129.4, 132.1],
  [24.0, 30.9, 122.9, 131.4]
];
export const inJapan = (lat: number, lon: number) => JAPAN.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);
const LANG_KEYS = ['ja', 'zh-Hant', 'en'] as const;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isMonthDay(v: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

const missingLangs = (text: LocalText | undefined) => LANG_KEYS.filter((l) => !text?.[l]?.trim());

/** Everything wrong with the config; empty when valid. Run by the shared test suite. */
export function worldProblems(world: Record<StarId, TalentWorld> = WORLD, seasons: Season[] = SEASONS): string[] {
  const problems: string[] = [];
  const text = (where: string, v: LocalText | undefined) => {
    for (const l of missingLangs(v)) problems.push(`${where}: missing ${l}`);
  };
  for (const id of STAR_IDS) {
    const w = world[id];
    if (!w) { problems.push(`${id}: no record`); continue; }
    if (w.id !== id) problems.push(`${id}: id is ${w.id}`);
    if (!isMonthDay(w.birthday.value)) problems.push(`${id}: birthday ${w.birthday.value} is not a valid MM-DD`);
    if (typeof w.birthday.confirmed !== 'boolean') problems.push(`${id}: birthday.confirmed missing`);
    if (typeof w.hometown.confirmed !== 'boolean') problems.push(`${id}: hometown.confirmed missing`);
    const h = w.hometown.value;
    if (!inJapan(h.lat, h.lon)) problems.push(`${id}: hometown ${h.lat},${h.lon} is outside Japan`);
    if (!CITIES[h.cityId]) problems.push(`${id}: unknown city ${h.cityId}`);
    text(`${id}.hometown.city`, h.city);
    text(`${id}.hometown.prefecture`, h.prefecture);
    for (const slot of ROUTINE_SLOTS) {
      const r = w.routine?.[slot];
      if (!r) { problems.push(`${id}.routine.${slot}: missing`); continue; }
      if (!(PRESENCES as readonly string[]).includes(r.presence)) problems.push(`${id}.routine.${slot}: presence ${r.presence}`);
      if (r.activity !== undefined && !(ROUTINE_ACTIVITIES as readonly string[]).includes(r.activity)) problems.push(`${id}.routine.${slot}: activity ${r.activity}`);
      text(`${id}.routine.${slot}`, r.status);
    }
    if (!w.signatureScene.id) problems.push(`${id}: signatureScene.id missing`);
    text(`${id}.signatureScene`, w.signatureScene.title);
    for (const stage of CALL_STAGES) if (!w.callNames?.[stage]?.trim()) problems.push(`${id}.callNames.${stage}: missing`);
  }
  for (const slot of ROUTINE_SLOTS) {
    if (!STAR_IDS.some((id) => world[id]?.routine?.[slot]?.presence === 'home')) problems.push(`routine.${slot}: nobody is at home`);
  }
  for (const s of seasons) {
    text(`season ${s.id}`, s.name);
    const windows = isDayWindow(s.window) ? [s.window] : CITY_IDS.map((c) => (s.window as Record<CityId, DayWindow>)[c]);
    windows.forEach((w, i) => {
      if (!w) problems.push(`season ${s.id}: no window for ${CITY_IDS[i]}`);
      else if (!isMonthDay(w.from) || !isMonthDay(w.to)) problems.push(`season ${s.id}: invalid window ${w.from}–${w.to}`);
    });
  }
  return problems;
}
