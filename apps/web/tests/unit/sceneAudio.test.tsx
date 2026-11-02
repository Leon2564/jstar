import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AUDIO_IDS, audioFile, audioUrl } from '@jstar/shared/scenes/audio';
import { sceneById as draftById } from '@jstar/shared/scenes';
import type { ClipStep, SceneScript } from '@jstar/shared/scenes';
import { FILE_DUCKED, FILE_LEVEL, createEngine, levels } from '../../src/components/audioEngine';

const sound = vi.hoisted(() => ({ sceneMusic: vi.fn(), ambience: vi.fn() }));
vi.mock('../../src/lib/sound', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/lib/sound')>()), ...sound }));

const { baseMusic, musicAt, useSceneAudio } = await import('../../src/scene/audio');

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); sound.sceneMusic.mockReset(); sound.ambience.mockReset(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The duration an MP4 declares (`mvhd`), in seconds. */
function mp4Seconds(buf: Buffer): number {
  const at = buf.indexOf('mvhd');
  const version = buf[at + 4];
  return version === 1
    ? Number(buf.readBigUInt64BE(at + 4 + 4 + 16 + 4)) / buf.readUInt32BE(at + 4 + 4 + 16)
    : buf.readUInt32BE(at + 4 + 4 + 8 + 4) / buf.readUInt32BE(at + 4 + 4 + 8);
}

describe('scene audio files (#82)', () => {
  it('every catalogue id has its file under public/audio: AAC in MP4, at most 2 MB, as long as its loop window', () => {
    for (const id of AUDIO_IDS) {
      const path = resolve(__dirname, '../../public', audioUrl(id).slice(1));
      const size = statSync(path).size;
      expect(size, id).toBeLessThanOrEqual(2 * 1024 * 1024);
      const buf = readFileSync(path);
      expect(buf.subarray(4, 8).toString(), id).toBe('ftyp');
      expect(buf.includes('mp4a'), id).toBe(true);
      const f = audioFile(id)!;
      const secs = mp4Seconds(buf);
      // A loop's file carries 0.25 s of itself either side of the window; a piece is its own length (+ AAC framing).
      expect(secs, id).toBeGreaterThanOrEqual(f.loop ? f.loop.end : f.seconds);
      expect(secs, id).toBeLessThan((f.loop ? f.loop.end + 0.25 : f.seconds) + 0.1);
    }
  });
});

describe('music levels (#82)', () => {
  it('a scene silences the pad; her voice ducks the scene music; nothing plays with sound off', () => {
    expect(levels({ bgm: true, pv: false, ducked: false, scene: false })).toEqual({ synth: 0.5, file: 0 });
    expect(levels({ bgm: true, pv: false, ducked: false, scene: true })).toEqual({ synth: 0, file: FILE_LEVEL });
    expect(levels({ bgm: true, pv: false, ducked: true, scene: true })).toEqual({ synth: 0, file: FILE_DUCKED });
    expect(levels({ bgm: false, pv: false, ducked: false, scene: true })).toEqual({ synth: 0, file: 0 });
    expect(FILE_DUCKED).toBeLessThan(FILE_LEVEL / 3);
  });
});

// ---------------------------------------------------------------- the engine against a fake WebAudio

type Param = { value: number; setTargetAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: () => void; setValueAtTime: () => void; exponentialRampToValueAtTime: () => void };
const param = (value = 0): Param => {
  const p: Param = { value, setTargetAtTime: vi.fn((v: number) => { p.value = v; }), cancelScheduledValues: () => {}, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
  return p;
};
interface FakeSource { buffer: { duration: number } | null; loop: boolean; loopStart: number; loopEnd: number; started: boolean; stopped: boolean; onended: (() => void) | null; src: string }
function fakeAudio() {
  const sources: FakeSource[] = [];
  const gains: { gain: Param }[] = [];
  const node = () => ({ connect: (n: unknown) => n, disconnect: () => {} });
  class Ctx {
    currentTime = 0; state = 'running'; sampleRate = 8000; destination = node();
    createGain() { const g = { ...node(), gain: param(1) }; gains.push(g); return g; }
    createDynamicsCompressor() { return { ...node(), threshold: param(), ratio: param() }; }
    createConvolver() { return { ...node(), buffer: null }; }
    createBiquadFilter() { return { ...node(), type: '', frequency: param(), Q: param() }; }
    createDelay() { return { ...node(), delayTime: param() }; }
    createOscillator() { return { ...node(), type: '', frequency: param(), detune: param(), start: () => {}, stop: () => {} }; }
    createBuffer(ch: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
    createBufferSource() {
      const s: FakeSource & ReturnType<typeof node> & { playbackRate: Param; start: () => void; stop: () => void } = {
        ...node(), buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: false, stopped: false, onended: null, playbackRate: param(1), src: '',
        start() { s.started = true; }, stop() { s.stopped = true; }
      };
      sources.push(s);
      return s;
    }
    async decodeAudioData(b: ArrayBuffer) { return { duration: 200, src: new TextDecoder().decode(b) }; }
    async resume() {} async suspend() {}
  }
  const fetched: string[] = [];
  const failing = new Set<string>();
  vi.stubGlobal('AudioContext', Ctx);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    if (failing.has(url)) return new Response('', { status: 404 });
    return new Response(url);
  }));
  /** The file sources (the synth's noise sources have no decoded `src`). */
  const files = () => sources.filter((s) => (s.buffer as { src?: string } | null)?.src);
  return { sources, files, fetched, failing, gains };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sound engine: scene music and weather files (#82)', () => {
  it('plays a scene\'s loop over its seamless window, ducks it, and hands the music back on leave', async () => {
    const a = fakeAudio();
    const e = createEngine();
    e.bgm(true);
    e.score({ music: 'bgm/night', then: null });
    await flush(); await flush();
    expect(a.fetched).toEqual(['/audio/bgm/night.m4a']);
    const [night] = a.files();
    expect(night).toMatchObject({ loop: true, loopStart: 0.25, started: true });
    expect(night.loopEnd).toBeCloseTo(audioFile('bgm/night')!.loop!.end, 6);
    // Her voice: the file bus goes down, then back.
    const fileBus = a.gains.find((g) => g.gain.setTargetAtTime.mock.calls.some(([v]) => v === FILE_LEVEL))!;
    e.duck(true);
    expect(fileBus.gain.value).toBe(FILE_DUCKED);
    e.duck(false);
    expect(fileBus.gain.value).toBe(FILE_LEVEL);
    // The same music again changes nothing; leaving fades it out and stops it.
    e.score({ music: 'bgm/night', then: null });
    expect(a.files()).toHaveLength(1);
    vi.useFakeTimers();
    e.score(undefined);
    expect(fileBus.gain.value).toBe(0);
    vi.advanceTimersByTime(4000);
    expect(night.stopped).toBe(true);
  });

  it('a piece that ends by itself gives way to the scene\'s music; sound off stops everything', async () => {
    const a = fakeAudio();
    const e = createEngine();
    e.bgm(true);
    e.score({ music: 'piece/alice-greenhouse', then: 'bgm/night' });
    await flush(); await flush();
    const [piece] = a.files();
    expect(piece).toMatchObject({ loop: false, started: true });
    piece.onended!();
    await flush(); await flush();
    expect(a.fetched).toEqual(['/audio/piece/alice-greenhouse.m4a', '/audio/bgm/night.m4a']);
    const night = a.files()[1];
    expect(night.loop).toBe(true);
    vi.useFakeTimers();
    e.bgm(false);
    vi.advanceTimersByTime(4000);
    expect(night.stopped).toBe(true);
  });

  it('waits for sound: nothing is fetched while background music is off', async () => {
    const a = fakeAudio();
    const e = createEngine();
    e.score({ music: 'bgm/playful', then: null });
    await flush();
    expect(a.fetched).toEqual([]);
    e.bgm(true);
    await flush(); await flush();
    expect(a.fetched).toEqual(['/audio/bgm/playful.m4a']);
  });

  it('rain and snow play their files, a storm is synthesised, and a file that cannot load falls back to the synth', async () => {
    const a = fakeAudio();
    const e = createEngine();
    e.ambience('snow');
    await flush(); await flush();
    expect(a.fetched).toEqual(['/audio/ambience/snow-night.m4a']);
    expect(a.files()[0]).toMatchObject({ loop: true, loopStart: 0.25, started: true });
    const before = a.sources.length;
    e.ambience('storm');
    expect(a.fetched).toHaveLength(1);
    expect(a.sources.length).toBeGreaterThan(before); // the synthesised storm's noise bands
    a.failing.add('/audio/ambience/rain.m4a');
    const n = a.sources.length;
    e.ambience('rain');
    await flush(); await flush(); await flush();
    expect(a.fetched.at(-1)).toBe('/audio/ambience/rain.m4a');
    expect(a.sources.length).toBeGreaterThan(n); // synthesised rain instead
  });
});

// ---------------------------------------------------------------- the player's cues

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
const clip = (id: string, music?: ClipStep['music']): ClipStep => ({ id, type: 'clip', shot: 'close', media: 'alice-hero', ...(music ? { music } : {}) });
const TOY = {
  meta: { id: 'toy', star: 'alice', title: T('toy'), trigger: { slots: ['night'] }, audio: { bgm: 'bgm/night', ambience: 'rain' } },
  steps: [clip('wide'), clip('keys', 'piece/alice-greenhouse'), clip('after'), clip('dark', 'none'), clip('last'), { id: 'end', type: 'end' }]
} as unknown as SceneScript;
const at = (id: string) => TOY.steps.find((s) => s.id === id) as ClipStep;

describe('scene cues (#82)', () => {
  it('the scene\'s own music, and what plays at a clip after a reload', () => {
    expect(baseMusic(TOY)).toBe('bgm/night');
    expect(baseMusic({ ...TOY, meta: { ...TOY.meta, audio: { ambience: 'storm' } } })).toBeNull();
    expect(baseMusic({ ...TOY, meta: { ...TOY.meta, audio: undefined } })).toBeUndefined();
    expect(musicAt(TOY, null)).toBe('bgm/night');
    expect(musicAt(TOY, at('wide'))).toBe('bgm/night');
    expect(musicAt(TOY, at('after'))).toBe('piece/alice-greenhouse');
    expect(musicAt(TOY, at('last'))).toBeNull();
  });

  it('starts the music and the weather, follows the cuts, starts over on "again", and stops on leave', () => {
    const { rerender, unmount } = renderHook(({ shot, run }: { shot: ClipStep | null; run?: string }) => useSceneAudio(TOY, shot, run), { initialProps: { shot: null as ClipStep | null, run: undefined as string | undefined } });
    expect(sound.ambience).toHaveBeenLastCalledWith('rain');
    expect(sound.sceneMusic).toHaveBeenLastCalledWith('bgm/night', 'bgm/night');
    rerender({ shot: at('wide'), run: 'r1' });
    sound.sceneMusic.mockClear();
    rerender({ shot: at('keys'), run: 'r1' });
    expect(sound.sceneMusic).toHaveBeenLastCalledWith('piece/alice-greenhouse', 'bgm/night');
    // A cut without a cue lets the piece carry on (and never restarts it after it has ended).
    rerender({ shot: at('after'), run: 'r1' });
    expect(sound.sceneMusic).toHaveBeenCalledTimes(1);
    rerender({ shot: at('dark'), run: 'r1' });
    expect(sound.sceneMusic).toHaveBeenLastCalledWith(null, 'bgm/night');
    rerender({ shot: at('dark'), run: 'r2' });
    expect(sound.sceneMusic).toHaveBeenLastCalledWith('bgm/night', 'bgm/night');
    unmount();
    expect(sound.sceneMusic).toHaveBeenLastCalledWith(undefined);
    expect(sound.ambience).toHaveBeenLastCalledWith(null);
  });

  it('a reload picks the music up where the run is', () => {
    renderHook(() => useSceneAudio(TOY, at('after'), 'r9'));
    expect(sound.sceneMusic).toHaveBeenLastCalledWith('piece/alice-greenhouse', 'bgm/night');
  });

  it('アリス\'s scene: the night loop, then her piece on the keys shot', () => {
    const s = draftById('night-greenhouse')!;
    const keys = s.steps.find((x) => x.id === 'keys') as ClipStep;
    const { rerender } = renderHook(({ shot }: { shot: ClipStep | null }) => useSceneAudio(s, shot, 'run'), { initialProps: { shot: null as ClipStep | null } });
    expect(sound.sceneMusic).toHaveBeenLastCalledWith('bgm/night', 'bgm/night');
    rerender({ shot: keys });
    expect(sound.sceneMusic).toHaveBeenLastCalledWith('piece/alice-greenhouse', 'bgm/night');
  });
});

describe('scene player sound (#82)', () => {
  it('plays the demo scene\'s music while it is open and gives the music back when he leaves', async () => {
    (window as unknown as { __E2E__: boolean }).__E2E__ = true;
    Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {};
    const { StoreProvider } = await import('../../src/lib/store');
    const { AppRoutes } = await import('../../src/App');
    const { initialState } = await import('../../src/lib/state');
    const view = render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' } }}>
        <MemoryRouter initialEntries={['/me/scene/demo-evening']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    await screen.findByRole('group', { name: 'なんて答える？' }, { timeout: 15_000 });
    expect(sound.sceneMusic).toHaveBeenCalledWith('bgm/home-evening', 'bgm/home-evening');
    expect(sound.sceneMusic).not.toHaveBeenCalledWith(undefined);
    view.unmount();
    expect(sound.sceneMusic).toHaveBeenLastCalledWith(undefined);
  }, 30_000);
});
