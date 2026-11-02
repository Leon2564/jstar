/**
 * The wake-up alarm (#57): `/me/alarm`. He picks who wakes him, the time and the days; the API rings it in his own
 * clock (the device's zone, sent with every save). Right after a save the notification switch is offered, since the
 * lock screen is where a wake-up belongs; without push she still wakes him when he opens the app in the morning.
 *
 * Server mode only: the prototype has no server to ring anything, so it says so instead of pretending.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { WAKEUP_RULES } from '@jstar/shared/rules';
import { WEEKDAYS } from '@jstar/shared/alarm';
import type { AlarmViewT } from '@jstar/shared/contracts';
import { CAST, getStar, type StarId } from '../data/cast';
import { starFirst, starName, type Key, type Lang } from '../i18n';
import { useStore, useT } from '../lib/store';
import { http, serverMode } from '../services/http';
import { Header } from '../components/ui';
import { PushOptIn } from '../components/pushOptIn';
import { media, stillOf } from '../components/stage';
import '../system/system.css';
import '../styles/alarm.css';

/** The zone this device keeps; undefined when the browser will not say. */
export const deviceTz = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };

const LOCALE: Record<Lang, string> = { ja: 'ja-JP', 'zh-Hant': 'zh-TW', en: 'en-US', ko: 'ko-KR' };
/** "10/5(月) 7:30" in the zone the alarm rings in, which is what he set it by. */
export function fmtRing(iso: string, tz: string, lang: Lang): string {
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: tz, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface Form { star: StarId; time: string; days: number[]; enabled: boolean }

export default function AlarmPage() {
  const t = useT();
  return (
    <div className="page member alarm-page js-nightpage">
      {/* L9: back to where he came from (her room's 目錄 or My page); a page under another has no tab bar, like her chat. */}
      <Header back={true} title={t('alarm.title')} />
      {serverMode() ? <AlarmForm /> : <p className="col pad small muted" data-testid="alarm-offline">{t('alarm.offline')}</p>}
    </div>
  );
}

function AlarmForm() {
  const { state } = useStore();
  const t = useT();
  /** undefined while loading; null = never set. */
  const [alarm, setAlarm] = useState<AlarmViewT | null | undefined>(undefined);
  const [form, setForm] = useState<Form>({ star: state.star, time: '07:00', days: [...WEEKDAYS], enabled: true });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const here = deviceTz();

  useEffect(() => {
    let live = true;
    http.alarm().then(({ alarm: a }) => {
      if (!live) return;
      setAlarm(a);
      if (a) setForm({ star: a.star, time: a.time, days: a.days, enabled: a.enabled });
    }).catch(() => { if (live) { setAlarm(null); setFailed(true); } });
    return () => { live = false; };
  }, []);

  const save = async (next: Form) => {
    setBusy(true);
    setFailed(false);
    try {
      const { alarm: a } = await http.alarmSet({ ...next, tz: here });
      setAlarm(a);
      setSaved(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void save(form); };
  const toggleDay = (d: number) => setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort() }));

  if (alarm === undefined) return <p className="col pad small muted">{t('common.loading')}</p>;
  const first = starFirst(getStar(form.star), t.lang);
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) && form.days.length > 0;

  return (
    <div className="col pad stack alarm">
      <p className="alarm-lead">{t('alarm.lead')}</p>
      <form className="stack alarm-form" onSubmit={submit} data-testid="alarm-form">
        <fieldset className="alarm-set">
          <legend>{t('alarm.who')}</legend>
          <div className="alarm-who" role="radiogroup" aria-label={t('alarm.who')}>
            {CAST.map((m) => {
              const face = stillOf(media(`${m.id}-hero-9x16`) ?? media(`${m.id}-breath-9x16`));
              return (
                <label key={m.id} className="alarm-face">
                  <input type="radio" name="alarm-star" aria-label={starName(m, t.lang)} value={m.id} checked={form.star === m.id} onChange={() => setForm((f) => ({ ...f, star: m.id }))} />
                  {face && <img src={face} alt="" loading="lazy" decoding="async" draggable={false} />}
                  {/* L9: her first name fits the button on one line (七瀬愛麗/絲 wrapped); her full name is its label. */}
                  <span>{starFirst(m, t.lang)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="alarm-time">{t('alarm.time')}</label>
          <input id="alarm-time" className="input alarm-time" type="time" step={60} required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} data-testid="alarm-time" />
        </div>
        <fieldset className="alarm-set">
          <legend>{t('alarm.days')}</legend>
          <div className="alarm-days">
            {/* Monday first, as calendars in all three launch languages show the week. */}
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <button key={d} type="button" className="chip" aria-pressed={form.days.includes(d)} onClick={() => toggleDay(d)}>{t(`alarm.day${d}` as Key)}</button>
            ))}
          </div>
        </fieldset>
        <label className="alarm-switch">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} data-testid="alarm-enabled" />
          <span>{t('alarm.enabled')}</span>
        </label>
        <button type="submit" className="js-btn-rose large" disabled={busy || !valid} data-testid="alarm-save">{t('alarm.save')}</button>
      </form>

      {alarm && (
        <p className="small alarm-state" role="status" data-testid="alarm-status">
          {saved && <>{t('alarm.saved')} </>}
          {alarm.enabled && alarm.nextAt ? t('alarm.next', { when: fmtRing(alarm.nextAt, alarm.tz, t.lang) }) : t('alarm.off')}
        </p>
      )}
      {alarm && <p className="tiny muted" style={{ margin: 0 }} data-testid="alarm-tz">{t('alarm.tz', { tz: alarm.tz })}</p>}
      {/* He moved (or travels): one tap and she wakes him by this device's clock. */}
      {alarm && here && here !== alarm.tz && (
        <div className="alarm-tzfix">
          <p className="tiny" style={{ margin: 0 }}>{t('alarm.tzDevice', { tz: here })}</p>
          <button type="button" className="btn-text" disabled={busy} onClick={() => void save(form)} data-testid="alarm-tz-use">{t('alarm.tzUse')}</button>
        </div>
      )}
      {failed && <p role="alert" className="err" style={{ margin: 0 }}>{t('alarm.failed')}</p>}

      {saved && alarm?.enabled && (
        <div className="stack" data-testid="alarm-push">
          <p className="small" style={{ margin: 0 }}>{t('alarm.pushLead')}</p>
          <PushOptIn star={alarm.star} />
        </div>
      )}
      <p className="tiny muted" style={{ margin: '0 0 24px' }}>{t('alarm.noPush', { hour: WAKEUP_RULES.sceneUntilHour, first })}</p>
    </div>
  );
}
