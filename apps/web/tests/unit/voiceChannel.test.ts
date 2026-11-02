import { afterEach, describe, expect, it, vi } from 'vitest';

// N-32: two of her voices at once — her reaction started while her line still played. One voice at a time.
class FakeAudio {
  static all: FakeAudio[] = [];
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  constructor(public src: string) { FakeAudio.all.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.onpause?.(); } }
}

describe('her one voice (N-32)', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeAudio.all = []; vi.resetModules(); });

  it('a new line stops the one still playing before it starts; stopAll stops her at once', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const { playVoiceOnce, speakingNow, stopAll } = await import('../../src/scene/voiceChannel');
    const first = playVoiceOnce('/voice/a.mp3');
    expect(speakingNow()).toBe(true);
    const second = playVoiceOnce('/voice/b.mp3');
    await first.done;
    expect(FakeAudio.all.map((a) => a.paused)).toEqual([true, false]);
    expect(FakeAudio.all.filter((a) => !a.paused)).toHaveLength(1);
    stopAll();
    await second.done;
    expect(speakingNow()).toBe(false);
  });

  it('the scene player plays her voice only through this channel', async () => {
    const src = (await import('node:fs')).readFileSync('src/scene/player.tsx', 'utf8');
    expect(src).not.toMatch(/new Audio\(/);
    expect(src).toMatch(/stopAll\(\);\s*\n\s*herVoice\.current\?\.stop\(\);/);
  });

  it('across channels too: stopVoice (his mic, leaving) silences this channel and her runtime voice; a line here leaves the other channels alone', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = await import('../../src/lib/sound');
    const { playVoiceOnce, speakingNow } = await import('../../src/scene/voiceChannel');
    const herRuntime = vi.fn();
    const off = sound.onHush(herRuntime);
    const line = playVoiceOnce('/voice/a.mp3');
    expect(herRuntime).not.toHaveBeenCalled();
    sound.stopVoice();
    await line.done;
    expect([speakingNow(), herRuntime.mock.calls.length]).toEqual([false, 1]);
    off();
    sound.stopVoice();
    expect(herRuntime.mock.calls.length).toBe(1);
  });
});


describe('her runtime voice plays under the page CSP', () => {
  it('uses blob: URLs, never data: URLs (CSP media-src allows blob: only; a data: URL never sounds)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // Her room and her scenes alike (the scene player used data: URLs too).
    for (const f of ['../../src/lib/herVoice.ts', '../../src/scene/player.tsx']) {
      const src = readFileSync(resolve(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(/(playVoiceOnce|preloadVoice|playAudio)\(`data:/);
      expect(src, f).toMatch(/clipUrl\(clip\)/);
    }
    expect(readFileSync(resolve(__dirname, '../../src/lib/clipUrl.ts'), 'utf8')).toMatch(/URL\.createObjectURL\(new Blob/);
  });
});

describe('her streamed sentence through Media Source Extensions (#73, first sound)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('appends the stream as it comes, ends the stream, and stops the download when stopped', async () => {
    const appended: number[] = [];
    let ended: string | undefined | null = null;
    class FakeSB extends EventTarget {
      updating = false;
      appendBuffer(b: Uint8Array) { this.updating = true; appended.push(b.length); setTimeout(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); }, 1); }
    }
    class FakeMS extends EventTarget {
      static isTypeSupported = (t: string) => t === 'audio/mpeg';
      readyState = 'closed';
      constructor() { super(); setTimeout(() => { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }, 1); }
      addSourceBuffer() { return new FakeSB(); }
      endOfStream(e?: string) { ended = e; this.readyState = 'ended'; }
    }
    vi.stubGlobal('MediaSource', FakeMS);
    const urls: string[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => { urls.push('blob:ms'); return 'blob:ms'; }, revokeObjectURL: () => undefined }));
    const { streamSource } = await import('../../src/scene/voiceChannel');
    let signal: AbortSignal | undefined;
    const f = (async (_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(200)); c.close(); } }), { headers: { 'content-type': 'audio/mpeg' } });
    }) as typeof fetch;
    const s = streamSource('/v1/tts/stream/abc', f)!;
    expect(s.src).toBe('blob:ms');
    await vi.waitFor(() => expect(ended).toBeUndefined());
    expect(appended).toEqual([100, 200]);
    s.stop();
    expect(signal?.aborted).toBe(true);
  });

  it('a failed stream ends the MediaSource with an error (the page then plays the sentence whole); no MSE for MP3: null', async () => {
    let ended: string | undefined | null = null;
    class FakeMS extends EventTarget {
      static isTypeSupported = () => true;
      readyState = 'closed';
      constructor() { super(); setTimeout(() => { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }, 1); }
      addSourceBuffer() { return Object.assign(new EventTarget(), { updating: false, appendBuffer: () => undefined }); }
      endOfStream(e?: string) { ended = e; this.readyState = 'ended'; }
    }
    vi.stubGlobal('MediaSource', FakeMS);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:ms', revokeObjectURL: () => undefined }));
    const { streamSource } = await import('../../src/scene/voiceChannel');
    streamSource('/v1/tts/stream/gone', (async () => Response.json({ error: 'no_ticket' }, { status: 404 })) as typeof fetch);
    await vi.waitFor(() => expect(ended).toBe('network'));
    vi.stubGlobal('MediaSource', Object.assign(FakeMS, { isTypeSupported: () => false }));
    expect(streamSource('/x', fetch)).toBeNull();
  });
});
