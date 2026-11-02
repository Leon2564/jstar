import { describe, expect, it } from 'vitest';
import {
  PRESENCES, ROUTINE_ACTIVITIES, ROUTINE_SLOTS, STAR_IDS, WORLD, nextRoutineChange, routineMatches, routineNow, routinesNow, worldProblems,
  type RoutineSlot
} from '../src';
import { LINES, wokenLine } from '../src/lines';
import { SCENES, jstSlot, triggerProblems, type TriggerContext } from '../src/scenes';

/** A moment at a JST wall-clock time, whatever zone the test runs in. */
const jst = (hhmm: string, day = '2026-10-01') => new Date(`${day}T${hhmm}:00+09:00`);

describe('five lives on their own clocks (#60)', () => {
  it('reads her slot and status on JST, whatever the viewer or server clock', () => {
    const r = routineNow('nana', jst('03:00'));
    expect(r).toEqual({ star: 'nana', slot: 'lateNight', presence: 'asleep', status: WORLD.nana.routine.lateNight.status, activity: null });
    expect(routineNow('unpai', jst('21:30'))).toMatchObject({ slot: 'evening', presence: 'out', activity: 'walk-stream' });
    expect(routineNow('unpai', jst('21:30')).status.ja).toBe('夜さんぽ配信中');
    expect(routineNow('eimi', jst('07:00'))).toMatchObject({ slot: 'morning', presence: 'out', activity: 'workout' });
    // 22:00 UTC is 07:00 the next morning in Japan.
    expect(routineNow('mahiro', new Date('2026-10-01T22:00:00Z')).slot).toBe('morning');
  });

  it('at any moment all five have a status, and at least one of them is at home', () => {
    for (let m = 0; m < 24 * 60; m += 15) {
      const at = new Date(jst('00:00').getTime() + m * 60_000);
      const all = routinesNow(at);
      expect(all.map((r) => r.star)).toEqual([...STAR_IDS]);
      for (const r of all) {
        expect(PRESENCES).toContain(r.presence);
        for (const l of ['ja', 'zh-Hant', 'en'] as const) expect(r.status[l], `${r.star} ${m} ${l}`).toBeTruthy();
      }
      expect(all.some((r) => r.presence === 'home'), `minute ${m}`).toBe(true);
    }
  });

  it('changes only at the slot boundaries, 05, 11, 17 and 23 JST', () => {
    expect(nextRoutineChange(jst('03:00')).toISOString()).toBe(jst('05:00').toISOString());
    expect(nextRoutineChange(jst('05:00')).toISOString()).toBe(jst('11:00').toISOString());
    expect(nextRoutineChange(jst('16:59')).toISOString()).toBe(jst('17:00').toISOString());
    expect(nextRoutineChange(jst('23:30')).toISOString()).toBe(jst('05:00', '2026-10-02').toISOString());
    const seen: RoutineSlot[] = [];
    for (let at = jst('05:00'); seen.length < 4; at = nextRoutineChange(at)) seen.push(routineNow('alice', at).slot);
    expect(seen).toEqual([...ROUTINE_SLOTS]);
  });

  it('a routine condition names her presence or one of her activities', () => {
    const streaming = routineNow('unpai', jst('21:30'));
    expect(routineMatches('out', streaming)).toBe(true);
    expect(routineMatches('walk-stream', streaming)).toBe(true);
    expect(routineMatches('home', streaming)).toBe(false);
    expect(routineMatches('walk-stream', routineNow('unpai', jst('01:00')))).toBe(false);
    const broken = structuredClone(WORLD);
    (broken.nana.routine.morning as { activity?: string }).activity = 'karaoke';
    expect(worldProblems(broken)).toEqual(['nana.routine.morning: activity karaoke']);
  });

  it('she is woken with one of her own three lines, the same all day', () => {
    for (const star of STAR_IDS) expect(LINES[star].woken, star).toHaveLength(3);
    const lines = ['2026-10-01', '2026-10-02', '2026-10-03'].map((d) => wokenLine('nana', d).ja);
    expect(new Set(lines).size).toBe(3);
    expect(wokenLine('nana', '2026-10-01')).toEqual(wokenLine('nana', '2026-10-01'));
    expect(wokenLine('nana', '2026-10-01')).toMatchInlineSnapshot(`
      {
        "en": "…Mm… is that you? I was already asleep… But just for a little bit, let's talk.",
        "ja": "……ん……キミ？ 奈々、もう寝てたよぉ……。でも、ちょっとだけならお話しよ。",
        "ko": "……응…… 너야? 나나 이미 자고 있었는데……. 그래도, 잠깐만이라면 얘기하자.",
        "voice": "/voice/scene/nana/31ba2c3ea3c3.mp3",
        "zh-Hant": "……嗯……是你？奈奈已經睡了啦……。不過，一下下的話就陪你聊。",
      }
    `);
  });
});

describe('her routine as a scene condition (#60, #65)', () => {
  const ctx = (at: Date): TriggerContext => ({
    slot: jstSlot(at.getTime()), weather: null, stage: 'lover', owns: () => true, routine: routineNow('unpai', at)
  });
  const stream = SCENES.find((s) => s.meta.id === 'private-stream')!;

  it("うんぱい's walk stream opens only while she is out streaming", () => {
    expect(stream.meta.trigger.routine).toBe('walk-stream');
    expect(triggerProblems(stream.meta, ctx(jst('21:30')))).toEqual([]);
    expect(triggerProblems(stream.meta, ctx(jst('18:00')))).toEqual([]);
    expect(triggerProblems(stream.meta, ctx(jst('01:00')))).toEqual(['routine']);
    expect(triggerProblems(stream.meta, ctx(jst('09:00')))).toEqual(['slot', 'routine']);
    // Unknown routine: the condition is unmet rather than assumed.
    expect(triggerProblems(stream.meta, { ...ctx(jst('21:30')), routine: null })).toEqual(['routine']);
  });

  it('every routine condition in a script can come true for her', () => {
    for (const s of SCENES) {
      const want = s.meta.trigger.routine;
      if (!want) continue;
      const known = (PRESENCES as readonly string[]).includes(want) || (ROUTINE_ACTIVITIES as readonly string[]).includes(want);
      expect(known, `${s.meta.id}: ${want}`).toBe(true);
      // Some quarter hour of the day meets both her routine and the scene's slots.
      const ok = Array.from({ length: 96 }, (_, i) => new Date(jst('00:00').getTime() + i * 15 * 60_000))
        .some((at) => s.meta.trigger.slots.includes(jstSlot(at.getTime())) && routineMatches(want, routineNow(s.meta.star, at)));
      expect(ok, s.meta.id).toBe(true);
    }
  });
});
