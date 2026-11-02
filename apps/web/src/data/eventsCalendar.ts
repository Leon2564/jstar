/**
 * The events on the activity page and the home's news (#61): built from the shared calendar, never hand-written dates
 * (the old `bday` entry was really Halloween). Her five confirmed birthdays, the yearly seasons (packages/shared
 * world.ts SEASONS) and — when known — their anniversary or his birthday, each with its real next date from today
 * (Japan's day, or his own zone's when given), titled in four languages. Lazy (events.ts loadEvents): the calendar
 * stays out of the entry bundle.
 */
import { SEASONS, WORLD, type DayWindow, type MonthDay } from '@jstar/shared/world';
import { CAST, type StarId } from './cast';
import type { EventItem } from './events';

/** What else is known of him: their anniversary per talent (YYYY-MM-DD), his birthday (YYYY-MM-DD or MM-DD). */
export interface EventsFor { anniversaries?: Partial<Record<StarId, string | null>>; hisBirthday?: string | null; tz?: string | null }

const DAY = 86_400_000;
const tintOf = (star: StarId) => CAST.find((c) => c.id === star)?.tint ?? '#E7DCE3';

/** Today on his clock (Japan's by default), as YYYY-MM-DD. */
function today(now: Date, tz?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  }
}

/** The window's next (or running) dates from `day`: [from, to] as YYYY-MM-DD, wrapping the new year. */
function nextWindow(w: DayWindow, day: string): [string, string] {
  const year = Number(day.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const from = `${y}-${w.from}`;
    const to = `${w.from <= w.to ? y : y + 1}-${w.to}`;
    if (to >= day) return [from, to];
  }
  return [`${year + 1}-${w.from}`, `${year + 1}-${w.to}`];
}

/** A yearly day (MM-DD) next from `day`, today included; 02-29 falls on 02-28 in other years. */
function nextYearly(md: MonthDay, day: string): string {
  const year = Number(day.slice(0, 4));
  for (const y of [year, year + 1]) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const date = `${y}-${md === '02-29' && !leap ? '02-28' : md}`;
    if (date >= day) return date;
  }
  return `${year + 1}-${md}`;
}

const start = (d: string) => `${d}T00:00:00+09:00`;
const end = (d: string) => `${d}T23:59:59+09:00`;

/** The widest window a season has across her cities (sakura moves north with the spring). */
function widest(window: DayWindow | Record<string, DayWindow>): DayWindow {
  if (typeof (window as DayWindow).from === 'string') return window as DayWindow;
  const all = Object.values(window as Record<string, DayWindow>);
  return { from: all.map((w) => w.from).sort()[0] as MonthDay, to: all.map((w) => w.to).sort().reverse()[0] as MonthDay };
}

/** Running and coming events from `now`, soonest first; anything already over is left out. */
export function upcomingEvents(now: Date = new Date(), o: EventsFor = {}): EventItem[] {
  const day = today(now, o.tz);
  const out: EventItem[] = [];
  for (const s of SEASONS) {
    const [from, to] = nextWindow(widest(s.window), day);
    out.push({ id: `season-${s.id}`, tint: '#DFDCEA', startsAt: start(from), endsAt: end(to), title: s.name });
  }
  for (const c of CAST) {
    const b = WORLD[c.id].birthday;
    if (!b.confirmed) continue;
    const d = nextYearly(b.value, day);
    out.push({
      id: `birthday-${c.id}`, star: c.id, tint: c.tint, startsAt: start(d), endsAt: end(d),
      title: { ja: `${c.name} 誕生日`, 'zh-Hant': `${c.zhName} 生日`, en: `${c.romaji}'s birthday`, ko: `${c.koName} 생일` }
    });
    const a = o.anniversaries?.[c.id];
    if (a && /^\d{4}-\d{2}-\d{2}$/.test(a)) {
      const ad = nextYearly(a.slice(5) as MonthDay, day);
      if (ad > a) {
        out.push({
          id: `anniversary-${c.id}`, star: c.id, tint: tintOf(c.id), startsAt: start(ad), endsAt: end(ad),
          title: { ja: `${c.first}との記念日`, 'zh-Hant': `與${c.zhFirst}的紀念日`, en: `Your anniversary with ${c.romajiFirst}`, ko: `${c.koFirst}와의 기념일` }
        });
      }
    }
  }
  const his = o.hisBirthday?.match(/(\d{2}-\d{2})$/)?.[1] as MonthDay | undefined;
  if (his) {
    const d = nextYearly(his, day);
    out.push({ id: 'birthday-you', tint: '#EADBE0', startsAt: start(d), endsAt: end(d), title: { ja: 'あなたの誕生日', 'zh-Hant': '你的生日', en: 'Your birthday', ko: '당신의 생일' } });
  }
  return out.filter((e) => Date.parse(e.endsAt) >= now.getTime() - DAY).sort((x, y) => x.startsAt.localeCompare(y.startsAt));
}

