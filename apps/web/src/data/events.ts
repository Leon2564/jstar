/**
 * The events on the activity page and the home's news (#61): their status and badge. The events themselves are built
 * from the shared calendar in eventsCalendar.ts — lazy, so the calendar stays out of the entry bundle.
 */
import { useEffect, useState } from 'react';
import type { LocalText } from '@jstar/shared/domain';
import type { StarId } from './cast';

export interface EventItem { id: string; tint: string; startsAt: string; endsAt: string; title: LocalText; star?: StarId }
export type EventStatus = 'soon' | 'live' | 'ended';

/** Where an event stands now, from its dates (never stored): before it starts 予告, until it ends 開催中, then 終了. */
export function eventStatus(e: Pick<EventItem, 'startsAt' | 'endsAt'>, now: Date = new Date()): EventStatus {
  const t = now.getTime();
  return t < Date.parse(e.startsAt) ? 'soon' : t <= Date.parse(e.endsAt) ? 'live' : 'ended';
}

/** The badge for a status: its dictionary key and rarity colour. */
export const EVENT_BADGE: Record<EventStatus, { key: 'events.live' | 'events.soon' | 'events.ended'; cls: string }> = {
  soon: { key: 'events.soon', cls: 'r-R' }, live: { key: 'events.live', cls: 'r-SSR' }, ended: { key: 'events.ended', cls: 'r-N' }
};

/** Lazily loads the calendar and lists the events for this moment (an empty list until it has loaded). */
export const loadEvents = (o?: import('./eventsCalendar').EventsFor): Promise<EventItem[]> =>
  import('./eventsCalendar').then((m) => m.upcomingEvents(new Date(), o));

/** The events for the home's news (entry): loaded after the first paint. */
export function useEvents(): EventItem[] {
  const [list, setList] = useState<EventItem[]>([]);
  useEffect(() => {
    let live = true;
    void loadEvents().then((l) => { if (live) setList(l); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return list;
}
