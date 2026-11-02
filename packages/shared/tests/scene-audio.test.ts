import { describe, expect, it } from 'vitest';
import { AMBIENCES, AMBIENCE_FILE, AUDIO_IDS, MUSIC_IDS, SCENE_AUDIO, audioFile, audioUrl } from '../src/scenes/audio';
import { SCENES } from '../src/scenes';
import { MAIN_SCENES as DRAFT_SCENES, sceneById as draftById } from '../src/scenes';
import { SYSTEM_AUDIO, SYSTEM_SCENES, systemSceneById } from '../src/scenes/system';
import { SYSTEM_SCENE_KINDS } from '../src/scenes/systemIds';
import { parseScene, zSceneScript, type SceneScript } from '../src/scenes/schema';

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
const script = (meta: Record<string, unknown> = {}, clip: Record<string, unknown> = {}) => ({
  meta: { id: 'sound', star: 'nana', title: T('x'), trigger: { slots: ['night'] }, ...meta },
  steps: [{ id: 'wide', type: 'clip', shot: 'wide', media: 'nana-hero', ...clip }, { id: 'end', type: 'end' }]
});
/** Every audio id a script names: its music, its ambience's file, and each clip's music. */
function audioOf(s: SceneScript): string[] {
  const a = s.meta.audio;
  return [
    ...(a?.bgm ? [a.bgm] : []),
    ...(a?.ambience && a.ambience !== 'storm' ? [AMBIENCE_FILE[a.ambience]] : []),
    ...s.steps.flatMap((st) => (st.type === 'clip' && st.music && st.music !== 'none' ? [st.music] : []))
  ];
}
const clipMusic = (s: SceneScript) => Object.fromEntries(s.steps.flatMap((st) => (st.type === 'clip' && st.music ? [[st.id, st.music]] : [])));

describe('scene audio catalogue (#82)', () => {
  it('names three BGM loops, two pieces and two weather loops, each loop window as long as its audio', () => {
    expect(AUDIO_IDS.filter((id) => SCENE_AUDIO[id].kind === 'bgm')).toEqual(['bgm/home-evening', 'bgm/night', 'bgm/playful']);
    expect(AUDIO_IDS.filter((id) => SCENE_AUDIO[id].kind === 'piece')).toEqual(['piece/alice-greenhouse', 'piece/unpai-earphones']);
    expect(AUDIO_IDS.filter((id) => SCENE_AUDIO[id].kind === 'ambience')).toEqual(['ambience/rain', 'ambience/snow-night']);
    // What a script may play as music is exactly the BGM and the pieces.
    expect([...MUSIC_IDS].sort()).toEqual(AUDIO_IDS.filter((id) => SCENE_AUDIO[id].kind !== 'ambience').sort());
    for (const id of AUDIO_IDS) {
      const f = audioFile(id)!;
      expect(id.startsWith(`${f.kind}/`), id).toBe(true);
      expect(audioUrl(id)).toBe(`/audio/${id}.m4a`);
      if (f.loop) {
        expect(f.loop.start, id).toBe(0.25);
        expect(f.loop.end - f.loop.start, id).toBeCloseTo(f.seconds, 6);
      }
    }
    // BGM and weather loop; アリス's piece ends by itself, うんぱい's song loops while she shares it.
    expect(AUDIO_IDS.filter((id) => !SCENE_AUDIO[id].loop)).toEqual(['piece/alice-greenhouse']);
    expect(Object.values(AMBIENCE_FILE).every((id) => SCENE_AUDIO[id].kind === 'ambience')).toBe(true);
    expect(audioFile('bgm/nope')).toBeUndefined();
  });
});

describe('scene audio in scripts (#82)', () => {
  it('accepts a scene\'s music and weather, and a clip\'s music or silence', () => {
    expect(zSceneScript.safeParse(script({ audio: { bgm: 'bgm/night', ambience: 'rain' } }, { music: 'piece/alice-greenhouse' })).success).toBe(true);
    expect(zSceneScript.safeParse(script({ audio: {} }, { music: 'none' })).success).toBe(true);
    for (const a of AMBIENCES) expect(zSceneScript.safeParse(script({ audio: { ambience: a } })).success, a).toBe(true);
  });

  it('refuses a file that does not exist, weather as music, music on a line, and stray fields', () => {
    const bad = (meta: Record<string, unknown>, clip: Record<string, unknown> = {}) => zSceneScript.safeParse(script(meta, clip)).success;
    expect(bad({ audio: { bgm: 'bgm/nope' } })).toBe(false);
    expect(bad({ audio: { bgm: 'ambience/rain' } })).toBe(false);
    expect(bad({ audio: { ambience: 'hail' } })).toBe(false);
    expect(bad({ audio: { bgm: 'bgm/night', volume: 1 } })).toBe(false);
    expect(bad({}, { music: 'ambience/rain' })).toBe(false);
    expect(bad({}, { music: '/audio/bgm/night.m4a' })).toBe(false);
    expect(zSceneScript.safeParse({ ...script(), steps: [{ id: 'l', type: 'line', text: T('x'), music: 'bgm/night' }, { id: 'end', type: 'end' }] }).success).toBe(false);
  });

  it('every script names only catalogue audio (live, drafts, system scenes)', () => {
    for (const s of [...SCENES, ...DRAFT_SCENES, ...SYSTEM_SCENES]) {
      expect(() => parseScene(s), s.meta.id).not.toThrow();
      for (const id of audioOf(s)) expect(audioFile(id), `${s.meta.id}: ${id}`).toBeDefined();
    }
  });

  it('the five scenes sound like their moment', () => {
    expect(Object.fromEntries(['welcome-home', 'read-aloud', 'read-aloud-rain', 'private-stream', 'night-greenhouse', 'ogiri'].map((id) => [id, draftById(id)!.meta.audio]))).toEqual({
      'welcome-home': { bgm: 'bgm/home-evening' },
      'read-aloud': { bgm: 'bgm/night' },
      'read-aloud-rain': { bgm: 'bgm/night', ambience: 'rain' },
      'private-stream': { bgm: 'bgm/playful' },
      'night-greenhouse': { bgm: 'bgm/night' },
      ogiri: { bgm: 'bgm/playful' }
    });
    expect(SCENES.find((s) => s.meta.id === 'demo-evening')!.meta.audio).toEqual({ bgm: 'bgm/home-evening' });
    // うんぱい: the stream's music stops in the alley, and her song starts as she hands over the earphone (#68).
    expect(clipMusic(draftById('private-stream')!)).toEqual({ alley: 'none', share: 'piece/unpai-earphones' });
    // えいみ: the teasing game gives way to the night as she opens her arms (#70).
    expect(clipMusic(draftById('ogiri')!)).toEqual({ hug: 'bgm/night' });
  });

  it('アリス plays her piece on the keys shot, after asking him to listen, and the shot stays long enough to hear it', () => {
    const s = draftById('night-greenhouse')!;
    expect(clipMusic(s)).toEqual({ keys: 'piece/alice-greenhouse' });
    const ids = s.steps.map((st) => st.id);
    expect(ids.indexOf('listen')).toBe(ids.indexOf('keys') - 1);
    const keys = s.steps.find((st) => st.id === 'keys');
    expect(keys?.type === 'clip' && keys.hold).toBeGreaterThanOrEqual(30);
  });

  it('system scenes: rain and snow at her window, the night loop for goodnight, and silence when the lights go out', () => {
    for (const star of ['mahiro', 'alice'] as const) {
      expect(systemSceneById(`rainy-night-${star}`)!.meta.audio).toEqual({ bgm: 'bgm/night', ambience: 'rain' });
      expect(systemSceneById(`first-snow-${star}`)!.meta.audio).toEqual({ bgm: 'bgm/night', ambience: 'snow' });
      expect(systemSceneById(`typhoon-${star}`)!.meta.audio).toEqual({ ambience: 'storm' });
      expect(systemSceneById(`his-birthday-${star}`)!.meta.audio).toEqual({ bgm: 'bgm/home-evening' });
      for (const id of [`goodnight-${star}`, `whisper-${star}-1`]) {
        const s = systemSceneById(id)!;
        expect(s.meta.audio).toEqual({ bgm: 'bgm/night' });
        expect(clipMusic(s)).toEqual({ lights: 'none' });
      }
    }
    for (const s of SYSTEM_SCENES) expect(s.meta.audio, s.meta.id).toBeDefined();
    expect(systemSceneById('promise-morning-nana')!.meta.audio).toEqual({ bgm: 'bgm/home-evening' });
    expect(Object.keys(SYSTEM_AUDIO).sort()).toEqual([...SYSTEM_SCENE_KINDS].sort());
  });
});
