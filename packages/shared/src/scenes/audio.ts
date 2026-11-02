/**
 * Scene music and weather ambience (#82): the catalogue scripts name and the web plays. No zod and no JSON, so the
 * player and the sound engine can import it for nothing.
 *
 * Files: `apps/web/public/audio/<id>.m4a` (AAC-LC in MP4, each ≤ 2 MB; how they were made: docs/asset-bible.md §十三,
 * tools/audio). A looping file carries 0.25 s of its own tail before the loop and of its own head after it, so the
 * window the player loops, `[loop.start, loop.end]` seconds, is seamless even when a decoder keeps the AAC priming.
 *
 * - `bgm`: a scene's background loop, under her lines (ducked while she speaks). Mastered at −18 LUFS.
 * - `piece`: music that is part of the moment — アリス at the piano (#69), うんぱい's song in the shared earphone
 *   (#68). Mastered at −16 LUFS, like her voice.
 * - `ambience`: the weather at her window (#63), quiet under everything. Mastered at −26 LUFS.
 */

export const AUDIO_KINDS = ['bgm', 'piece', 'ambience'] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

export interface AudioFile {
  kind: AudioKind;
  /** Seconds of audio (the loop's length for a loop). */
  seconds: number;
  /** The seamless window a looping file plays, in seconds from the file's start; none = plays once. */
  loop?: { start: number; end: number };
  /** Where it came from (docs/asset-bible.md §十三). */
  made: 'lyria-3-pro' | 'synth';
}

const loop = (seconds: number) => ({ seconds, loop: { start: 0.25, end: 0.25 + seconds } });

export const SCENE_AUDIO = {
  'bgm/home-evening': { kind: 'bgm', ...loop(79.059048), made: 'lyria-3-pro' },
  'bgm/night': { kind: 'bgm', ...loop(79.999977), made: 'lyria-3-pro' },
  'bgm/playful': { kind: 'bgm', ...loop(52.363401), made: 'lyria-3-pro' },
  'piece/alice-greenhouse': { kind: 'piece', seconds: 86.125782, made: 'lyria-3-pro' },
  'piece/unpai-earphones': { kind: 'piece', ...loop(105.356599), made: 'lyria-3-pro' },
  'ambience/rain': { kind: 'ambience', ...loop(48), made: 'synth' },
  'ambience/snow-night': { kind: 'ambience', ...loop(48), made: 'synth' }
} as const satisfies Record<string, AudioFile>;

export type AudioId = keyof typeof SCENE_AUDIO;
export const AUDIO_IDS = Object.keys(SCENE_AUDIO) as AudioId[];

/** What a scene or a clip may play as its music: a BGM loop or a piece (the shared tests hold it to SCENE_AUDIO). */
export const MUSIC_IDS = ['bgm/home-evening', 'bgm/night', 'bgm/playful', 'piece/alice-greenhouse', 'piece/unpai-earphones'] as const satisfies readonly AudioId[];
export type MusicId = (typeof MUSIC_IDS)[number];

/**
 * Weather you hear (#63): what the room's sky and a scene's `audio.ambience` name. Rain and snow are files; a storm
 * stays synthesised in the sound engine (gusts over louder rain).
 */
export const AMBIENCES = ['rain', 'snow', 'storm'] as const;
export type AmbienceKind = (typeof AMBIENCES)[number];
export const AMBIENCE_FILE: Record<Exclude<AmbienceKind, 'storm'>, AudioId> = { rain: 'ambience/rain', snow: 'ambience/snow-night' };

/** The file's URL under the web app. */
export const audioUrl = (id: AudioId): string => `/audio/${id}.m4a`;
export const audioFile = (id: string): AudioFile | undefined => (SCENE_AUDIO as Record<string, AudioFile>)[id];
