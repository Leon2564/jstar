/**
 * Pickups (#78) on the web: the ones the server publishes (`GET /v1/gacha/rates`), shown on the gacha page and on
 * 提供割合 with the odds computed from their config. Nothing here decides a rate; it only formats the published ones.
 */
import { useEffect, useState } from 'react';
import { pickupDisclosure, pickupLive, poolCards, type PickupDef } from '@jstar/shared/gacha';
import type { GachaRatesResT, PickupRatesT } from '@jstar/shared/contracts';
import type { CardDef } from '@jstar/shared/domain';
import { API_BASE, serverMode } from '../services/http';

/**
 * The offline prototype has no admin and no clock of record, so it runs no Pickup of its own; the e2e suite may
 * inject some (`window.__PICKUPS__`, only with `__E2E__`) to exercise the pages.
 */
export function localPickupDefs(): PickupDef[] {
  const w = window as unknown as { __E2E__?: boolean; __PICKUPS__?: PickupDef[] };
  return w.__E2E__ && Array.isArray(w.__PICKUPS__) ? w.__PICKUPS__ : [];
}

/** 提供割合 of a Pickup from its config, as the server computes it (apps/api/src/lib/pickup.ts `pickupRates`). */
export const ratesOf = (p: PickupDef, cards: CardDef[], now = Date.now()): PickupRatesT => ({
  id: p.id, star: p.star, cardId: p.cardId, startsAt: p.startsAt, endsAt: p.endsAt, live: pickupLive(p, now),
  ...pickupDisclosure(poolCards(`star:${p.star}`, cards), p, p.rates)
});

export const localPickups = (cards: CardDef[], now = Date.now()): PickupRatesT[] =>
  localPickupDefs().filter((p) => Date.parse(p.endsAt) > now).map((p) => ratesOf(p, cards, now));

/** The published rates (server mode); null offline or when the API cannot be reached. */
export async function fetchRates(): Promise<GachaRatesResT | null> {
  if (!serverMode()) return null;
  try {
    const r = await fetch(`${API_BASE}/v1/gacha/rates`);
    return r.ok ? ((await r.json()) as GachaRatesResT) : null;
  } catch {
    return null;
  }
}

/** Pickups that are live or scheduled; null until known (an unreachable API counts as none). */
export function usePickups(cards: CardDef[]): PickupRatesT[] | null {
  const [list, setList] = useState<PickupRatesT[] | null>(() => (serverMode() ? null : localPickups(cards)));
  useEffect(() => {
    if (!serverMode()) return;
    let live = true;
    void fetchRates().then((r) => { if (live) setList(r?.pickups ?? []); });
    return () => { live = false; };
  }, []);
  return list;
}

/** A rate as published: percent, at most three decimals ("2.5%", "0.625%"). */
export const pct = (x: number) => `${(Math.round(x * 100000) / 1000).toString()}%`;

/** A Pickup's start or end, in Japan time (the business calendar), with the hour: it may start or end at any time. */
export function fmtJst(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'zh-Hant' ? 'zh-TW' : lang, {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(iso));
}
