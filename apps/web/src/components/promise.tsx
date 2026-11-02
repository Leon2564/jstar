/**
 * Promises (#59): the home card with the next promise, her proposal for the next time in the chat, and the note when
 * one was made. The API decides everything (what is due, what is kept); these only show it.
 */
import { Link } from 'react-router-dom';
import type { AlarmViewT, PromiseItemT, PromiseProposalT } from '@jstar/shared/contracts';
import { PROPOSED_TIME, alarmCovers } from './alarmProposal';
import { promiseDay, timelessPromise } from '@jstar/shared/promises';
import { PROMISE_RULES, WAKEUP_RULES } from '@jstar/shared/rules';
import { useT } from '../lib/store';
import { Icon } from './ui';

/**
 * When a promise is, counted at display (round 10): 「今夜 21:00」 / "tomorrow 09:00" while it is near, its date after —
 * never a 「明日」 frozen into its words the day before.
 */
export function promiseWhen(dueAt: string, lang: string, now = Date.now(), tz = myZone()): string {
  // Round 12: on his own clock (a Taipei account saw Tokyo's times), the day word a capital in English ("Tomorrow, 21:00").
  const day = promiseDay(dueAt, lang, now, tz);
  if (!day) {
    return new Intl.DateTimeFormat(lang === 'zh-Hant' ? 'zh-TW' : lang, {
      month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz
    }).format(new Date(dueAt));
  }
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(dueAt));
  return lang === 'en' ? `${day[0].toUpperCase()}${day.slice(1)}, ${time}` : `${day} ${time}`;
}

/**
 * C-room L9: when a promise is, as he should read it. Her wake-up promise (「明日の朝、起こしてあげる」) is due by a
 * script's "+12h" only approximately (a promise made at 02:32 read 「今天 14:32」): it is the morning she wakes him — his
 * alarm's next ring when his alarm with her covers it, else that morning at the time she proposes (07:00).
 * C-room R5: a morning that is over is never shown as still to come: the next morning she can still keep it on (her
 * wake-up keeps it within PROMISE_RULES.wakeKeepMs of its time), else it is missed.
 */
export function promiseState(p: Pick<PromiseItemT, 'kind' | 'dueAt' | 'star'> & Partial<Pick<PromiseItemT, 'status' | 'keptAt'>>,
  alarm?: Pick<AlarmViewT, 'star' | 'enabled' | 'nextAt'> | null, now = Date.now()): { at: string; state: 'open' | 'kept' | 'missed' } {
  if (p.status === 'kept') return { at: p.keptAt ?? p.dueAt, state: 'kept' };
  if (p.status === 'missed') return { at: p.dueAt, state: 'missed' };
  if (p.kind !== 'wakeup') return { at: p.dueAt, state: 'open' };
  if (alarmCovers(alarm ?? null, p.star, p.dueAt) && alarm?.nextAt && Date.parse(alarm.nextAt) > now) return { at: alarm.nextAt, state: 'open' };
  const due = new Date(p.dueAt), [h, m] = PROPOSED_TIME.split(':').map(Number);
  const morning = new Date(due.getFullYear(), due.getMonth(), due.getDate(), h, m);
  if (morning.getTime() > due.getTime()) morning.setDate(morning.getDate() - 1);
  const first = morning.toISOString();
  // Her call rings for WAKEUP_RULES.ringWindowMs after its time: until then this morning is still hers.
  while (morning.getTime() + WAKEUP_RULES.ringWindowMs < now) morning.setDate(morning.getDate() + 1);
  if (morning.getTime() > due.getTime() + PROMISE_RULES.wakeKeepMs) return { at: first, state: 'missed' };
  return { at: morning.toISOString(), state: 'open' };
}

export function promiseAt(p: Pick<PromiseItemT, 'kind' | 'dueAt' | 'star'> & Partial<Pick<PromiseItemT, 'status' | 'keptAt'>>, lang: string,
  alarm?: Pick<AlarmViewT, 'star' | 'enabled' | 'nextAt'> | null, now = Date.now()): string {
  return promiseWhen(promiseState(p, alarm, now).at, lang, now);
}

/** His clock's zone, as his browser knows it; Japan's when it cannot say. */
function myZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo'; } catch { return 'Asia/Tokyo'; }
}

/** 「次の約束」 on the companion home: when, and what. One line; the text gives way first on a narrow phone. */
export function NextPromise({ promise, first }: { promise: PromiseItemT; first: string }) {
  const t = useT();
  const when = promiseWhen(promise.dueAt, t.lang);
  const text = timelessPromise(promise.text);
  return (
    <Link to="/me/chat" className="reward promise-card" data-testid="next-promise" aria-label={t('promise.label', { first, text, when })}>
      <Icon name="spark" size={12} />
      <b>{t('promise.next')}</b>
      <span>{when}</span>
      <span className="promise-text">{text}</span>
    </Link>
  );
}

/** A promise she just kept that was a scene together: the way back into it. */
export function PromisedScene({ sceneId }: { sceneId: string }) {
  const t = useT();
  return (
    <Link to={`/me/scene/${encodeURIComponent(sceneId)}`} className="reward promise-card" data-testid="promise-scene">
      <Icon name="play" size={12} />
      <span>{t('promise.scene')}</span>
    </Link>
  );
}

/** Her proposal for the next time, as her line with his two answers. Nothing is made until he says 「約束する」. */
export function PromiseOffer({ proposal, busy, onMake, onLater }: { proposal: PromiseProposalT; busy: boolean; onMake: () => void; onLater: () => void }) {
  const t = useT();
  return (
    <div className="fade-in" data-testid="promise-offer" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <p className="msg her" style={{ margin: 0 }}>{proposal.propose}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-navy" style={{ minHeight: 44, fontSize: 14 }} disabled={busy} onClick={onMake}>{t('promise.make')}</button>
        <button type="button" className="btn btn-ghost" style={{ minHeight: 44, fontSize: 14 }} disabled={busy} onClick={onLater}>{t('promise.later')}</button>
      </div>
    </div>
  );
}

/** The note in the chat log when a promise was made: by his 「約束する」 or agreed on in the conversation. */
export function PromiseMade({ promise }: { promise: PromiseItemT }) {
  const t = useT();
  return (
    <p className="panel small fade-in" data-testid="promise-made" role="status" style={{ margin: 0, padding: 12, color: 'var(--rose-text)' }}>
      {t('promise.made', { when: promiseWhen(promise.dueAt, t.lang), text: timelessPromise(promise.text) })}
    </p>
  );
}
