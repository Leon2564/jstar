import type { TickJob } from '../lib/tick';
import { calendarGreetings } from './calendarGreetings';
import { deliverInbox } from './deliverInbox';
import { duePromises } from './duePromises';
import { inviteConfession } from './inviteConfession';
import { memoryAssets } from './memoryAssets';
import { memoryFlush } from './memoryFlush';
import { planHerMessages, sendHerMessages } from './herMessages';
import { purgeEvents } from './purgeEvents';
import { refreshWeather } from './refreshWeather';
import { ringAlarms } from './ringAlarms';
import { variantInvites } from './variantInvites';
import { weatherEvents } from './weatherEvents';

/**
 * Every job the tick runs, in this order (src/lib/tick.ts). A new job is one file exporting a TickJob and one
 * line here. Jobs that write inbox rows due now (promises, wake-ups, her messages, events) go before
 * `deliverInbox`, so what they write reaches her inbox in the same tick.
 */
export const JOBS: readonly TickJob[] = [
  duePromises,
  // Wake-ups are due the minute they are written: before the delivery, which pushes them in the same tick.
  ringAlarms,
  // Her weather messages (#63), from the weather the previous tick's refresh stored.
  weatherEvents,
  // Her message for the day (#61): birthdays, anniversaries, a season's first day.
  calendarGreetings,
  inviteConfession,
  // Her draw-night invite (#76): the evening he first got her variant card.
  variantInvites,
  planHerMessages,
  sendHerMessages,
  deliverInbox,
  purgeEvents,
  // His memory files (#51): deleted accounts' files, recordings into the store, retention (off unless set).
  memoryAssets,
  // Quiet conversations' pending chat turns into memory (batched memory): one model call each, before the weather.
  memoryFlush,
  // Last: it waits on the network, so a slow provider only ever eats into the time left after the others.
  refreshWeather
];
