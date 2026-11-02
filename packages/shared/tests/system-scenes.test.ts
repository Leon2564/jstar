import { describe, expect, it } from 'vitest';
import { STAR_IDS, type StarId } from '../src/domain';
import { CITIES } from '../src/world';
import { SYSTEM_SCENE_RULES } from '../src/rules';
import { LINES } from '../src/lines';
import { SCENES, beginRun, scenePlayable, submitStep, type Advance, type SceneError, type SceneScript, type SceneStep } from '../src/scenes';
import { parseScene, sceneProblems, zSceneScript } from '../src/scenes/schema';
import {
  SYSTEM_LINES, SYSTEM_SCENES, SYSTEM_SCENE_KINDS, WHISPER_COUNT, goodnightTime, openSystemScenes, promiseOpensScene,
  systemSceneById, systemSceneId, systemSceneOf, systemScenesFor, weatherSceneId, whisperOfNight, type SystemFacts
} from '../src/scenes/system';
import { zSystemLines } from '../src/scenes/systemSchema';

let n = 0;
const ctx = (now = 1_000_000) => ({ now, lang: 'ja', newId: (p: string) => `${p}_${n++}` });
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };
const said = (beats: SceneStep[]) => beats.flatMap((b) => (b.type === 'line' ? [b.text.ja] : []));
const scene = (kind: Parameters<typeof systemSceneId>[0], star: StarId, k?: number): SceneScript => systemSceneById(systemSceneId(kind, star, k))!;
/** A JST wall-clock time on 2026-10-09. */
const jst = (hm: string, day = '2026-10-09') => Date.parse(`${day}T${hm}:00+09:00`);
const facts = (f: Partial<SystemFacts> = {}): SystemFacts => ({ star: 'mahiro', now: jst('12:00'), calendar: [], weather: [], promiseKept: false, ...f });

describe('system scenes (#71): the scripts', () => {
  it('the pack\'s own words have their shape, and are reviewed (#84, owner 2026-09-28)', () => {
    expect(() => zSystemLines.parse(SYSTEM_LINES)).not.toThrow();
    expect(SYSTEM_LINES.draft).toBe(false);
  });

  it('twelve per talent, each a valid script (zod and sceneProblems), with a system id of its own', () => {
    expect(SYSTEM_SCENES).toHaveLength(STAR_IDS.length * (SYSTEM_SCENE_KINDS.length - 1 + WHISPER_COUNT));
    for (const s of SYSTEM_SCENES) {
      expect(zSceneScript.safeParse(s).success, s.meta.id).toBe(true);
      expect(sceneProblems(s), s.meta.id).toEqual([]);
      expect(() => parseScene(s), s.meta.id).not.toThrow();
      const of = systemSceneOf(s.meta.id)!;
      expect(of.star, s.meta.id).toBe(s.meta.star);
      expect(systemSceneId(of.kind, of.star, of.n)).toBe(s.meta.id);
      expect(s.meta.title).toEqual(SYSTEM_LINES.titles[of.kind]);
    }
    expect(new Set(SYSTEM_SCENES.map((s) => s.meta.id)).size).toBe(SYSTEM_SCENES.length);
    // Loaded on their own (like the confession), never bundled with the web's SCENES.
    expect(SCENES.some((s) => systemSceneOf(s.meta.id))).toBe(false);
  });

  it('names only its own ids', () => {
    for (const id of ['whisper-mahiro', 'whisper-mahiro-0', 'whisper-mahiro-6', 'goodnight-mahiro-1', 'goodnight-bob', 'demo-evening', 'confession-nana', 'first-snow-nana-']) {
      expect(systemSceneOf(id), id).toBeNull();
    }
    expect(systemSceneOf('rainy-night-alice')).toEqual({ kind: 'rainyNight', star: 'alice' });
    expect(weatherSceneId('typhoon', 'eimi')).toBe('typhoon-eimi');
  });

  it('plays her own footage: the clips of each moment (tools/media/src/shots/system-v11.ts), her room, close, her morning', () => {
    const own = (star: string) => new RegExp(`^${star}-(sys-[a-z-]+|hero|herohd|breath|morning)$`);
    for (const s of SYSTEM_SCENES) {
      const star = s.meta.star;
      const clips = s.steps.flatMap((x) => (x.type === 'clip' ? [x.media] : []));
      for (const c of [...clips, s.meta.idle]) expect(c, s.meta.id).toMatch(own(star));
    }
    const clipsOf = (kind: Parameters<typeof scene>[0], star: StarId, k?: number) => scene(kind, star, k).steps.flatMap((x) => (x.type === 'clip' ? [x.media] : []));
    for (const star of STAR_IDS) {
      // Goodnight and the whispers: by the bed, at his ear, then her bedroom dark but for a small lamp (#71).
      expect(clipsOf('goodnight', star)).toEqual([`${star}-sys-goodnight`, `${star}-sys-lights-out`]);
      expect(scene('goodnight', star).meta.idle).toBe(`${star}-sys-goodnight`);
      expect(clipsOf('whisper', star, 1)).toEqual([`${star}-sys-whisper`, `${star}-sys-lights-out`]);
      expect(scene('whisper', star, 1).meta.idle).toBe(`${star}-sys-whisper`);
      // A promise kept (#59): she waits, sees him (played once), then her HD hero loop, which starts on the frame it ends on.
      expect(clipsOf('promiseKept', star)).toEqual([`${star}-sys-promise-kept`, `${star}-herohd`, `${star}-sys-promise-kept-close`]);
      expect(scene('promiseKept', star).steps[0]).toMatchObject({ loop: false });
      expect(scene('promiseKept', star).meta.idle).toBe(`${star}-herohd`);
      // The weather (#63): her window in her own world, wide then close.
      for (const [kind, slug] of [['firstSnow', 'first-snow'], ['rainyNight', 'rainy-night'], ['typhoon', 'typhoon']] as const) {
        expect(clipsOf(kind, star)).toEqual([`${star}-sys-${slug}-wide`, `${star}-sys-${slug}-close`]);
        expect(scene(kind, star).meta.idle).toBe(`${star}-sys-${slug}-wide`);
      }
      // The birthdays (#61): the cake and candles on hers, what she made ready on his; wide, then close.
      for (const [kind, slug] of [['herBirthday', 'herbday'], ['hisBirthday', 'hisbday']] as const) {
        expect(clipsOf(kind, star)).toEqual([`${star}-sys-${slug}-wide`, `${star}-sys-${slug}-close`]);
        expect(scene(kind, star).meta.idle).toBe(`${star}-sys-${slug}-wide`);
      }
    }
  });

  it('reviewed, they play everywhere (existing footage only); while any of the words are drafts they are demo-only', () => {
    for (const s of SYSTEM_SCENES) {
      expect(s.meta.demo, s.meta.id).toBeUndefined();
      expect(scenePlayable(s, true), s.meta.id).toBe(true);
      expect(scenePlayable(s, false), s.meta.id).toBe(true);
    }
    // One side back to a draft is enough to keep them on the test site.
    for (const draft of [systemScenesFor('nana', { ...LINES.nana, draft: true }, SYSTEM_LINES), systemScenesFor('nana', LINES.nana, { ...SYSTEM_LINES, draft: true })]) {
      for (const s of draft) {
        expect(s.meta.demo, s.meta.id).toBe(true);
        expect([scenePlayable(s, true), scenePlayable(s, false)], s.meta.id).toEqual([true, false]);
      }
    }
  });

  it('subtitles in four languages, traditional characters, no place, no age, no placeholder', () => {
    const simplified = /[这们说个时过还没让对给听读书梦来会样发见觉经间里后点头爱亲欢话认问应现实开关门电车东边岁带钟吗么]/;
    const cities = Object.values(CITIES).flatMap((c) => [c.city.ja, c.city['zh-Hant'], c.city.en, c.prefecture.ja]);
    const texts: { ja: string; 'zh-Hant': string; en: string; ko: string }[] = [];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        if ('ja' in x && 'en' in x) texts.push(x as (typeof texts)[number]);
        else Object.values(x).forEach(walk);
      }
    };
    walk(SYSTEM_SCENES);
    walk(SYSTEM_LINES);
    expect(texts.length).toBeGreaterThan(300);
    for (const t of texts) {
      expect(t['zh-Hant'], t.ja).not.toMatch(simplified);
      for (const l of ['ja', 'zh-Hant', 'en', 'ko'] as const) {
        expect(t[l]?.trim().length, `${t.ja} [${l}]`).toBeGreaterThan(0);
        expect(t[l], t.ja).not.toMatch(/\d+\s*(歳|才|歲|years? old)|\{/);
        for (const c of cities) expect(t[l].includes(c), `${t.ja} names ${c}`).toBe(false);
      }
    }
  });
});

describe('system scenes (#71): what they play', () => {
  it('goodnight with the pass: her whisper, "just a little longer" gets the next one, then the lights go out', () => {
    for (const star of STAR_IDS) {
      for (let k = 1; k <= WHISPER_COUNT; k++) {
        const s = scene('whisper', star, k);
        const begun = ok(beginRun(s, { ...ctx(), rewardable: true }));
        const whispers = LINES[star].goodnight.whisper;
        expect(said(begun.state.beats)).toEqual([whispers[k - 1].ja]);
        expect(begun.state.at).toBe('answer');
        const stay = ok(submitStep(s, begun.state, { choice: 'stay' }, ctx()));
        expect(said(stay.state.beats)).toEqual([whispers[k % WHISPER_COUNT].ja]);
        expect(stay.state.beats.map((b) => b.type === 'clip' && b.media).filter(Boolean)).toEqual([`${star}-sys-lights-out`]);
        expect(stay.state.outcome).toBe('goodnight');
        expect(stay.grant.affinity).toBe(SYSTEM_SCENE_RULES.affinity.whisper);
        expect(stay.grant.memories).toEqual([]);
        const night = ok(submitStep(s, begun.state, { choice: 'night' }, ctx()));
        expect(said(night.state.beats)).toEqual([]);
        expect(night.state.outcome).toBe('goodnight');
      }
    }
  });

  it('goodnight without the pass: her one plain goodnight', () => {
    const s = scene('goodnight', 'unpai');
    const begun = ok(beginRun(s, { ...ctx(), rewardable: true }));
    expect(said(begun.state.beats)).toEqual([LINES.unpai.goodnight.plain.ja]);
    const done = ok(submitStep(s, begun.state, { choice: 'tomorrow' }, ctx()));
    expect(done.state.outcome).toBe('goodnight');
    expect(done.grant.affinity).toBe(SYSTEM_SCENE_RULES.affinity.goodnight);
    // Silence is a goodnight too, and costs nothing.
    const quiet = ok(submitStep(s, begun.state, { timeout: true }, ctx(1_000_000 + 30_000)));
    expect(quiet.state.outcome).toBe('goodnight');
    expect(quiet.grant.affinity).toBe(0);
  });

  it('weather: all three of her lines for the event, his answer between; the first snow is a memory card', () => {
    for (const star of STAR_IDS) {
      for (const event of ['firstSnow', 'typhoon', 'rainyNight'] as const) {
        const s = scene(event, star);
        const lines = LINES[star].weather[event].map((t) => t.ja);
        const begun = ok(beginRun(s, { ...ctx(), rewardable: true }));
        expect(said(begun.state.beats)).toEqual([lines[0]]);
        const done = ok(submitStep(s, begun.state, { choice: SYSTEM_LINES.choices[event][0].id }, ctx()));
        expect(said(done.state.beats)).toEqual(lines.slice(1));
        expect(done.state.ended).toBe(true);
        expect(done.grant.affinity).toBe(SYSTEM_SCENE_RULES.affinity.weather);
        expect(done.grant.memories.map((m) => m.title)).toEqual(event === 'firstSnow' ? [SYSTEM_LINES.memories.firstSnow.ja] : []);
      }
    }
    expect(scene('rainyNight', 'nana').meta.trigger.slots).toEqual(['evening', 'night']);
    expect(scene('firstSnow', 'nana').meta.trigger.slots).toHaveLength(4);
  });

  it('her birthday: wide, his gift (no countdown), close for her thanks, a memory card', () => {
    const s = scene('herBirthday', 'alice');
    const t = SYSTEM_LINES.talents.alice.herBirthday;
    const begun = ok(beginRun(s, { ...ctx(), rewardable: true }));
    expect(said(begun.state.beats)).toEqual(t.open.map((x) => x.ja));
    const gift = s.steps.find((x) => x.id === 'answer');
    expect(gift).toMatchObject({ type: 'choice', prompt: SYSTEM_LINES.prompts.herBirthday });
    expect(gift && 'timeout' in gift ? gift.timeout : undefined).toBeUndefined();
    expect(submitStep(s, begun.state, { timeout: true }, ctx(10_000_000))).toBe('invalid_submission');
    const done = ok(submitStep(s, begun.state, { choice: 'letter' }, ctx()));
    expect(done.state.beats.filter((b) => b.type === 'clip').map((b) => b.type === 'clip' && b.shot)).toEqual(['close']);
    expect(said(done.state.beats)).toEqual([t.thanks.ja]);
    expect(done.grant).toMatchObject({ affinity: SYSTEM_SCENE_RULES.affinity.birthday, memories: [{ title: SYSTEM_LINES.memories.herBirthday.ja }] });
  });

  it('his birthday: she prepared something, and wishes him well; a memory card', () => {
    const s = scene('hisBirthday', 'eimi');
    const t = SYSTEM_LINES.talents.eimi.hisBirthday;
    const begun = ok(beginRun(s, { ...ctx(), rewardable: true }));
    expect(said(begun.state.beats)).toEqual([t.open.ja, t.gift.ja]);
    const done = ok(submitStep(s, begun.state, { choice: 'shy' }, ctx()));
    expect(said(done.state.beats)).toEqual([t.wish.ja]);
    expect(done.grant.memories.map((m) => m.title)).toEqual([SYSTEM_LINES.memories.hisBirthday.ja]);
  });

  it('a promise kept: her opening and his answer; the memory card is the promise\'s own (#59), not another', () => {
    const s = scene('promiseKept', 'mahiro');
    const t = SYSTEM_LINES.talents.mahiro.promiseKept;
    const begun = ok(beginRun(s, { ...ctx(), rewardable: true }));
    expect(said(begun.state.beats)).toEqual([t.open.ja]);
    const done = ok(submitStep(s, begun.state, { choice: 'missed' }, ctx()));
    expect(said(done.state.beats)).toEqual([t.close.ja]);
    expect(done.grant).toMatchObject({ affinity: SYSTEM_SCENE_RULES.affinity.promiseKept, memories: [], promises: [] });
  });

  it('a replay the same day shows everything and grants nothing', () => {
    const s = scene('herBirthday', 'mahiro');
    const begun = ok(beginRun(s, { ...ctx(), rewardable: false }));
    const done = ok(submitStep(s, begun.state, { choice: 'flowers' }, ctx()));
    expect(done.grant).toMatchObject({ affinity: 0, memories: [] });
  });
});

describe('system scenes (#71): when each one opens', () => {
  it('goodnight from 22:00 to 05:00 on his own clock', () => {
    expect(goodnightTime(jst('21:59'))).toBe(false);
    expect(goodnightTime(jst('22:00'))).toBe(true);
    expect(goodnightTime(jst('04:59'))).toBe(true);
    expect(goodnightTime(jst('05:00'))).toBe(false);
    // 22:30 in Tokyo is 21:30 in Taipei.
    expect(goodnightTime(jst('22:30'), 'Asia/Taipei')).toBe(false);
    expect(goodnightTime(jst('23:30'), 'Asia/Taipei')).toBe(true);
  });

  it('her five whispers take turns, one a night; after midnight is still the same night', () => {
    const nights = Array.from({ length: WHISPER_COUNT }, (_, i) => whisperOfNight(jst('23:00', `2026-10-${String(10 + i).padStart(2, '0')}`)));
    expect(new Set(nights).size).toBe(WHISPER_COUNT);
    expect(nights.every((k) => k >= 1 && k <= WHISPER_COUNT)).toBe(true);
    expect(whisperOfNight(jst('01:30', '2026-10-11'))).toBe(whisperOfNight(jst('23:00', '2026-10-10')));
  });

  it('the pass decides the whisper; nothing opens by day', () => {
    const pass = new Date(jst('12:00') + 7 * 86_400_000).toISOString();
    expect(openSystemScenes(facts())).toEqual([]);
    expect(openSystemScenes(facts({ passUntil: pass }))).toEqual([]);
    const late = jst('22:30');
    expect(openSystemScenes(facts({ now: late }))).toEqual(['goodnight-mahiro']);
    expect(openSystemScenes(facts({ now: late, passUntil: pass }))).toEqual([`whisper-mahiro-${whisperOfNight(late)}`]);
    // An expired pass is no pass.
    expect(openSystemScenes(facts({ now: late, passUntil: new Date(late - 1000).toISOString() }))).toEqual(['goodnight-mahiro']);
  });

  it('the calendar, her weather messages and a promise open theirs, most important first', () => {
    expect(openSystemScenes(facts({ calendar: ['herBirthdaySoon', 'season'] }))).toEqual([]);
    expect(openSystemScenes(facts({
      now: jst('23:00'), calendar: ['herBirthday', 'hisBirthday'], weather: ['rainyNight', 'firstSnow'], promiseKept: true
    }))).toEqual(['promise-kept-mahiro', 'his-birthday-mahiro', 'her-birthday-mahiro', 'first-snow-mahiro', 'rainy-night-mahiro', 'goodnight-mahiro']);
    expect(openSystemScenes(facts({ star: 'alice', weather: ['typhoon'] }))).toEqual(['typhoon-alice']);
  });

  it('a promise opens it only when it is of kind scene or free, names no scene, and he came to keep it', () => {
    const now = jst('20:00');
    const due = new Date(now - 3_600_000).toISOString();
    const p = { kind: 'scene' as const, sceneId: null, status: 'open', dueAt: due, keptAt: null };
    expect(promiseOpensScene(p, now)).toBe(true);
    expect(promiseOpensScene(null, now)).toBe(false);
    expect(promiseOpensScene({ ...p, sceneId: 'demo-evening' }, now)).toBe(false);
    expect(promiseOpensScene({ ...p, kind: 'wakeup' }, now)).toBe(false);
    // N-64: a promise made in chat (kind free) and one of her suggestions (a message) are kept in her room too.
    for (const kind of ['free', 'message'] as const) expect(promiseOpensScene({ ...p, kind }, now), kind).toBe(true);
    // Too early, or long past its window.
    expect(promiseOpensScene({ ...p, dueAt: new Date(now + 5 * 3_600_000).toISOString() }, now)).toBe(false);
    expect(promiseOpensScene({ ...p, dueAt: new Date(now - 5 * 3_600_000).toISOString() }, now)).toBe(false);
    // Kept a moment ago (her greeting kept it as he came in): still his moment; kept yesterday: not any more.
    expect(promiseOpensScene({ ...p, status: 'kept', keptAt: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(promiseOpensScene({ ...p, status: 'kept', keptAt: new Date(now - 86_400_000).toISOString() }, now)).toBe(false);
    expect(promiseOpensScene({ ...p, status: 'missed' }, now)).toBe(false);
  });
});
