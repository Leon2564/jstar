/**
 * Her 「明日の朝、起こしてあげる」 as an alarm proposal (#57, #66): a promise of kind `wakeup` — made at the end of her
 * evening scene or agreed on in chat — is offered as the alarm, with her. He picks the time and says yes; then it is
 * his alarm like any other (the alarm page changes it), and her wake-up that morning keeps the promise (the API).
 * Nothing is set until he says so. Server mode only: the prototype has no server to ring an alarm.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { WEEKDAYS } from '@jstar/shared/alarm';
import type { AlarmViewT, PromiseItemT } from '@jstar/shared/contracts';
import type { StarId } from '../data/cast';
import type { Lang } from '../i18n';
import { useT } from '../lib/store';
import { http, serverMode } from '../services/http';
import { Icon } from './ui';

const LOCALE: Record<Lang, string> = { ja: 'ja-JP', 'zh-Hant': 'zh-TW', en: 'en-US', ko: 'ko-KR' };
const here = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
/** "9/29(火) 7:00" in the zone the alarm rings in. */
const ringAt = (iso: string, tz: string, lang: Lang): string => {
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: tz, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch { return iso; }
};
/** The morning she promised: the default time he is offered (his own alarm time when he has one). */
export const PROPOSED_TIME = '07:00';

/** Whether his alarm already has her waking him by the time the promise is due (nothing to propose then). */
export function alarmCovers(alarm: Pick<AlarmViewT, 'star' | 'enabled' | 'nextAt'> | null, star: StarId, dueAt: string, slackMs = 18 * 3_600_000): boolean {
  return !!alarm && alarm.enabled && alarm.star === star && !!alarm.nextAt && Date.parse(alarm.nextAt) <= Date.parse(dueAt) + slackMs;
}

/**
 * N-43: the time field and 「セット」 on her dark card, readable in every state (WCAG AA): ivory on the card, navy on
 * ivory, and while it is being set a softer ivory that still reads (never the browser's grey at half opacity).
 */
// L4: 44 px targets, near-square corners (A2), on the end card and in her chat alike.
const TIME: React.CSSProperties = {
  minHeight: 44, padding: '0 8px', borderRadius: 2, border: '1px solid rgba(239, 232, 237, 0.55)', background: 'rgba(239, 232, 237, 0.12)',
  color: '#EFE8ED', colorScheme: 'dark', font: 'inherit', fontSize: 13
};
const TIME_BUSY: React.CSSProperties = { color: '#D9D2DC', borderStyle: 'dashed', opacity: 1 };
const SET: React.CSSProperties = { minHeight: 44, padding: '0 14px', borderRadius: 2, border: 0, background: '#EFE8ED', color: '#1B1E3D', fontWeight: 600, fontSize: 13, opacity: 1 };
const SET_BUSY: React.CSSProperties = { background: '#C9C2CE', color: '#1B1E3D', cursor: 'progress', opacity: 1 };

export function AlarmProposal({ star, first, promise, onSet }: { star: StarId; first: string; promise: Pick<PromiseItemT, 'dueAt' | 'text'>; onSet?: (a: AlarmViewT) => void }) {
  const t = useT();
  /** undefined while loading. */
  const [alarm, setAlarm] = useState<AlarmViewT | null | undefined>(undefined);
  const [time, setTime] = useState(PROPOSED_TIME);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!serverMode()) return;
    let live = true;
    http.alarm().then(({ alarm: a }) => { if (!live) return; setAlarm(a); if (a) setTime(a.time); }).catch(() => { if (live) setAlarm(null); });
    return () => { live = false; };
  }, []);
  if (!serverMode() || alarm === undefined) return null;

  // Set (now, or before): the promise card says when she comes.
  if (done || alarmCovers(alarm, star, promise.dueAt)) {
    return (
      <Link to="/me/alarm" className="reward promise-card" data-testid="alarm-proposal-set">
        <Icon name="clock" size={12} />
        <span>{alarm?.nextAt ? t('promise.alarmSet', { first, when: ringAt(alarm.nextAt, alarm.tz, t.lang) }) : t('alarm.saved')}</span>
      </Link>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return;
    setBusy(true);
    setFailed(false);
    try {
      // With her, at his time; his days stay as they were (every day when he never set one).
      const { alarm: a } = await http.alarmSet({ star, time, days: alarm?.days.length ? alarm.days : [...WEEKDAYS], enabled: true, tz: here() });
      setAlarm(a);
      setDone(true);
      if (a) onSet?.(a);
      // M11: he set her alarm — the moment her notifications may be offered (components/pushOffer.tsx, once).
      window.dispatchEvent(new Event('jstar:alarm-set'));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const replaces = alarm && alarm.enabled && alarm.star !== star;
  return (
    <form className="reward promise-card promise-alarm" data-testid="alarm-proposal" onSubmit={(e) => void submit(e)} aria-label={t('promise.alarmAsk', { first })}>
      <Icon name="clock" size={12} />
      <span className="promise-text" role={failed ? 'alert' : undefined}>{failed ? t('alarm.failed') : t(replaces ? 'promise.alarmReplaces' : 'promise.alarmAsk', { first })}</span>
      <input type="time" step={60} required value={time} onChange={(e) => setTime(e.target.value)} aria-label={t('alarm.time')} data-testid="alarm-proposal-time"
        disabled={busy} style={busy ? { ...TIME, ...TIME_BUSY } : TIME} />
      <button type="submit" disabled={busy} data-testid="alarm-proposal-yes" aria-busy={busy} style={busy ? { ...SET, ...SET_BUSY } : SET}>{t('promise.alarmYes')}</button>
    </form>
  );
}
