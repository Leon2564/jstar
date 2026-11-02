import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALL_STAGES, CITIES, ROUTINE_SLOTS, SEASONS, STAR_IDS, WORLD, agentWorld, agentWorldJson, callNameFor, confirmedWorld,
  inJapan, isMonthDay, routineSlot, seasonsOn, weatherPoint, worldProblems, type StarId, type TalentWorld
} from '../src';

/** A copy of the config with some fields unconfirmed again, as a value added later would start. */
function withUnconfirmed(patch: Partial<Record<StarId, { birthday?: boolean; hometown?: boolean }>>): Record<StarId, TalentWorld> {
  const copy = structuredClone(WORLD);
  for (const [id, p] of Object.entries(patch) as [StarId, { birthday?: boolean; hometown?: boolean }][]) {
    if (p.birthday) copy[id].birthday.confirmed = false;
    if (p.hometown) copy[id].hometown.confirmed = false;
  }
  return copy;
}

describe('talent world config (#48)', () => {
  it('has a complete, valid record for each of the five talents', () => {
    expect(Object.keys(WORLD).sort()).toEqual([...STAR_IDS].sort());
    expect(worldProblems()).toEqual([]);
  });

  it('birthdays are real MM-DD dates and match the plan', () => {
    for (const id of STAR_IDS) expect(isMonthDay(WORLD[id].birthday.value), id).toBe(true);
    expect(Object.fromEntries(STAR_IDS.map((id) => [id, WORLD[id].birthday.value])))
      .toEqual({ mahiro: '03-04', nana: '09-03', unpai: '07-17', alice: '02-25', eimi: '03-18' });
    expect(['02-29', '12-31', '01-01'].every(isMonthDay)).toBe(true);
    expect(['02-30', '13-01', '00-10', '4-01', '04-31', '2026-04-01'].some(isMonthDay)).toBe(false);
  });

  it('hometowns lie inside Japan and have their city in four languages', () => {
    for (const id of STAR_IDS) {
      const h = WORLD[id].hometown.value;
      expect(inJapan(h.lat, h.lon), id).toBe(true);
      for (const l of ['ja', 'zh-Hant', 'en', 'ko'] as const) expect(h.city[l], `${id} ${l}`).toBeTruthy();
    }
    const outside = structuredClone(WORLD);
    outside.nana.hometown.value = { ...outside.nana.hometown.value, lat: 37.5665, lon: 126.978 }; // Seoul
    expect(worldProblems(outside)).toEqual(['nana: hometown 37.5665,126.978 is outside Japan']);
    // Edges: Naha, Sapporo and Fukuoka are in; Busan, Taipei and Vladivostok are not; nor is a swapped pair.
    expect([[26.21, 127.68], [43.06, 141.35], [33.59, 130.4]].every(([a, b]) => inJapan(a, b))).toBe(true);
    expect([[35.18, 129.08], [25.03, 121.57], [43.12, 131.89], [139.69, 35.69]].some(([a, b]) => inJapan(a, b))).toBe(false);
  });

  it('every routine has all four slots in three languages, and someone is always at home', () => {
    for (const id of STAR_IDS) {
      expect(Object.keys(WORLD[id].routine).sort()).toEqual([...ROUTINE_SLOTS].sort());
      for (const slot of ROUTINE_SLOTS) {
        for (const l of ['ja', 'zh-Hant', 'en'] as const) expect(WORLD[id].routine[slot].status[l], `${id} ${slot} ${l}`).toBeTruthy();
      }
    }
    for (const slot of ROUTINE_SLOTS) expect(STAR_IDS.some((id) => WORLD[id].routine[slot].presence === 'home'), slot).toBe(true);
    const broken = structuredClone(WORLD);
    delete (broken.alice.routine as Partial<TalentWorld['routine']>).lateNight;
    broken.eimi.routine.morning.status.en = '';
    expect(worldProblems(broken)).toEqual(expect.arrayContaining(['alice.routine.lateNight: missing', 'eimi.routine.morning: missing en']));
  });

  it('signature scenes and call names are complete', () => {
    for (const id of STAR_IDS) {
      expect(WORLD[id].signatureScene.id).toBeTruthy();
      for (const stage of CALL_STAGES) expect(WORLD[id].callNames[stage], `${id} ${stage}`).toBeTruthy();
    }
    expect(callNameFor('mahiro', 'new', 'けんた')).toBe('けんたさん');
    expect(callNameFor('eimi', 'lover', 'けんた')).toBe('キミ');
  });

  it('the five birthdays and hometowns are confirmed (owner, 2026-09-28), with nothing left to check', () => {
    const cities = { mahiro: 'tokyo', nana: 'nagano', unpai: 'sendai', alice: 'saitama', eimi: 'tochigi' };
    for (const id of STAR_IDS) {
      expect(WORLD[id].birthday.confirmed, id).toBe(true);
      expect(WORLD[id].hometown.confirmed, id).toBe(true);
      expect(WORLD[id].birthday.note ?? WORLD[id].hometown.note, id).toBeUndefined();
      expect(confirmedWorld(id)).toEqual({ birthday: WORLD[id].birthday.value, hometown: CITIES[cities[id] as keyof typeof CITIES] });
    }
  });

  it('only confirmed fields leave the config', () => {
    const world = withUnconfirmed({ mahiro: { hometown: true }, nana: { birthday: true }, unpai: { birthday: true, hometown: true } });
    expect(confirmedWorld('mahiro', world)).toEqual({ birthday: '03-04' });
    expect(confirmedWorld('nana', world)).toEqual({ hometown: CITIES.nagano });
    expect(confirmedWorld('unpai', world)).toEqual({});
    expect(agentWorld(world)).toEqual({
      mahiro: { birthday: '03-04' }, nana: { hometown: CITIES.nagano }, unpai: {},
      alice: { birthday: '02-25', hometown: CITIES.saitama }, eimi: { birthday: '03-18', hometown: CITIES.tochigi }
    });
  });

  it('the weather is her confirmed city, and falls back to Tokyo for an unconfirmed one', () => {
    expect(weatherPoint('nana').cityId).toBe('nagano');
    expect(weatherPoint('nana', withUnconfirmed({ nana: { hometown: true } })).cityId).toBe('tokyo');
  });

  it('routine slots follow JST, whatever the server clock', () => {
    expect(routineSlot(new Date('2026-10-01T22:00:00Z'))).toBe('morning'); // 07:00 JST
    expect(routineSlot(new Date('2026-10-01T03:00:00Z'))).toBe('daytime'); // 12:00 JST
    expect(routineSlot(new Date('2026-10-01T12:00:00Z'))).toBe('evening'); // 21:00 JST
    expect(routineSlot(new Date('2026-10-01T18:00:00Z'))).toBe('lateNight'); // 03:00 JST
  });

  it('seasons: fixed windows, and sakura by her (weather) city', () => {
    expect(SEASONS.map((s) => s.id).sort()).toEqual(['christmas', 'fireworks', 'hatsumode', 'sakura']);
    expect(seasonsOn('12-24', 'alice')).toEqual(['christmas']);
    expect(seasonsOn('01-02', 'alice')).toEqual(['hatsumode']);
    expect(seasonsOn('08-10', 'alice')).toEqual(['fireworks']);
    // Nagano blooms about three weeks after Tokyo; an unconfirmed hometown would get Tokyo's bloom.
    expect(seasonsOn('03-28', 'nana')).toEqual([]);
    expect(seasonsOn('04-15', 'nana')).toEqual(['sakura']);
    expect(seasonsOn('03-28', 'nana', withUnconfirmed({ nana: { hometown: true } }))).toEqual(['sakura']);
  });

  it('the persona service copy (apps/agent/app/world.json) is up to date', () => {
    const file = readFileSync(new URL('../../../apps/agent/app/world.json', import.meta.url), 'utf8');
    // Stale? Run `npm run world:agent -w @jstar/shared`.
    expect(file).toBe(agentWorldJson());
  });
});
