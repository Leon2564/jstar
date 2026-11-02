import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIPSYNC_DRIFT_S, LIPSYNC_LEAD_S, clipTimeFor, lipsyncSizes, lipsyncSrc, requestLipsync, syncStep, upcomingRenders, voiceId, warmLipsync, resetWarm, WARM_EVERY_MS } from '../../src/lib/lipsync';
import { speakLine, within, type Playback } from '../../src/lib/ttsQueue';
import type { TtsResT } from '@jstar/shared/contracts';
import manifest from '../../src/data/lipsync.gen.json';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('her recorded lines, lip-synced (#73)', () => {
  const m = { 'mahiro-talk-9x16': ['41e9e0671ead'], 'mahiro-talk-16x9': ['41e9e0671ead'] };

  it('finds a render by the clip on screen and the recording, at the size the screen needs', () => {
    expect(voiceId('/voice/scene/mahiro/41e9e0671ead.mp3')).toBe('41e9e0671ead');
    expect(voiceId('/voice/greet/mahiro-day.mp3')).toBeNull();
    expect(lipsyncSrc(m, 'mahiro-talk-9x16', '/voice/scene/mahiro/41e9e0671ead.mp3', 900)).toBe('/lipsync/v1/mahiro-talk-9x16/41e9e0671ead-720x1280.mp4');
    expect(lipsyncSrc(m, 'mahiro-talk-9x16', '/voice/scene/mahiro/41e9e0671ead.mp3', 2400)).toBe('/lipsync/v1/mahiro-talk-9x16/41e9e0671ead-1080x1920.mp4');
    expect(lipsyncSrc(m, 'mahiro-talk-16x9', '/voice/scene/mahiro/41e9e0671ead.mp3', 1000)).toBe('/lipsync/v1/mahiro-talk-16x9/41e9e0671ead-1280x720.mp4');
    expect(lipsyncSizes('nana-talk-16x9')).toEqual([{ w: 1920, h: 1080 }, { w: 1280, h: 720 }]);
  });

  it('a line not rendered (another clip, another line, no list yet) plays as before', () => {
    expect(lipsyncSrc(m, 'mahiro-talkclose-9x16', '/voice/scene/mahiro/41e9e0671ead.mp3', 900)).toBeNull();
    expect(lipsyncSrc(m, 'mahiro-talk-9x16', '/voice/scene/mahiro/000000000000.mp3', 900)).toBeNull();
    expect(lipsyncSrc(null, 'mahiro-talk-9x16', '/voice/scene/mahiro/41e9e0671ead.mp3', 900)).toBeNull();
    expect(lipsyncSrc(m, undefined, '/voice/scene/mahiro/41e9e0671ead.mp3', 900)).toBeNull();
  });

  it('the shipped list names real clips and recording ids only', () => {
    const list = manifest as Record<string, string[]>;
    expect(Object.keys(list).length).toBeGreaterThan(100);
    for (const [clip, ids] of Object.entries(list)) {
      expect(clip).toMatch(/^(mahiro|nana|unpai|alice|eimi)-[a-z0-9-]+-(9x16|16x9)$/);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});

describe('her runtime voice, lip-synced (#73)', () => {
  const voiced = (n: number): TtsResT & { lipsync: string } => ({ mode: 'voice', audio: btoa('RIFF-sentence'), mime: 'audio/wav', seconds: 2, leftSeconds: n, lipsync: '1790000000.token' });
  function player() {
    const played: number[] = [];
    const ends: (() => void)[] = [];
    const play = (_c: { audio: string }, onPlaying: () => void): Playback => {
      played.push(played.length);
      let end: () => void = () => undefined;
      const done = new Promise<void>((r) => { end = r; });
      ends.push(end);
      onPlaying();
      return { done, stop: () => end() };
    };
    return { played, ends, play };
  }

  it('a video ready in time plays with its sentence, each sentence asking for its own', async () => {
    const p = player();
    const seen: [number, string | null][] = [];
    const asked: number[] = [];
    const s = speakLine('一つ目です。二つ目です。', {
      fetch: async (_t, i) => voiced(100 - i), play: p.play,
      video: async (_c, i) => { asked.push(i); return `blob:video-${i}`; }, videoWaitMs: () => 1000
    }, { onVideo: (i, src) => seen.push([i, src]) });
    await vi.waitFor(() => expect(p.played).toHaveLength(1));
    expect(seen).toEqual([[0, 'blob:video-0']]);
    p.ends[0]();
    await vi.waitFor(() => expect(p.played).toHaveLength(2));
    p.ends[1]();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(seen).toEqual([[0, 'blob:video-0'], [1, 'blob:video-1']]);
    expect(asked).toEqual([0, 1]);
  });

  it('a video too late, refused or failed: the sentence plays as before, without it', async () => {
    const p = player();
    const seen: [number, string | null][] = [];
    const s = speakLine('一つ目です。二つ目です。', {
      fetch: async (_t, i) => voiced(100 - i), play: p.play,
      video: (_c, i) => (i === 0 ? new Promise<string | null>(() => undefined) : Promise.reject(new Error('502'))),
      videoWaitMs: () => 30
    }, { onVideo: (i, src) => seen.push([i, src]) });
    await vi.waitFor(() => expect(p.played).toHaveLength(1));
    p.ends[0]();
    await vi.waitFor(() => expect(p.played).toHaveLength(2));
    p.ends[1]();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(seen).toEqual([[0, null], [1, null]]);
  });

  it('with her first sentence streamed: it plays at once over her talk loop (no render, no wait); the later ones are rendered in order, ahead, and play lip-synced', async () => {
    const p = player();
    const seen: [number, string | null][] = [];
    const rendered: number[] = [];
    let release: (() => void) | null = null;
    const s = speakLine('一つ目です。二つ目の文です。三つ目の文です。', {
      fetch: async (t, i) => (i === 0 ? { mode: 'stream' as const, url: '/v1/tts/stream/abc', seconds: 1, leftSeconds: 100 } : voiced(100 - i)),
      play: p.play,
      // Renders take time; sentence 1's comes back only when released, sentence 2's at once.
      video: (_c, i) => { rendered.push(i); return i === 1 ? new Promise<string | null>((r) => { release = () => r('blob:video-1'); }) : Promise.resolve(`blob:video-${i}`); },
      videoWaitMs: (i) => (i === 0 ? 3500 : 1200)
    }, { onVideo: (i, src) => seen.push([i, src]) });
    // The streamed sentence plays straight away, without a video and without waiting for any render.
    await vi.waitFor(() => expect(p.played).toHaveLength(1));
    expect(seen).toEqual([[0, null]]);
    // While it plays, the whole sentences after it are already being rendered — in sentence order, 1 then 2.
    await vi.waitFor(() => expect(rendered).toEqual([1, 2]));
    release!();
    p.ends[0]();
    await vi.waitFor(() => expect(p.played).toHaveLength(2));
    p.ends[1]();
    await vi.waitFor(() => expect(p.played).toHaveLength(3));
    p.ends[2]();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(seen).toEqual([[0, null], [1, 'blob:video-1'], [2, 'blob:video-2']]);
  });

  it('a later render not ready by its turn: that sentence plays over her talk loop after the short grace, never a silence longer than it', async () => {
    vi.useFakeTimers();
    const p = player();
    const seen: [number, string | null][] = [];
    const s = speakLine('一つ目です。二つ目の文です。', {
      fetch: async (_t, i) => (i === 0 ? { mode: 'stream' as const, url: '/v1/tts/stream/abc', seconds: 1, leftSeconds: 100 } : voiced(100 - i)),
      play: p.play,
      video: () => new Promise<string | null>(() => undefined),
      videoWaitMs: (i) => (i === 0 ? 3500 : 1200)
    }, { onVideo: (i, src) => seen.push([i, src]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.played).toHaveLength(1);
    p.ends[0]();
    await vi.advanceTimersByTimeAsync(1199);
    expect(p.played).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.played).toHaveLength(2);
    p.ends[1]();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(seen).toEqual([[0, null], [1, null]]);
  });

  it('lip-sync off (no video for any sentence): the streamed queue plays exactly as without lip-sync', async () => {
    const p = player();
    const seen: number[] = [];
    const s = speakLine('一つ目です。二つ目の文です。', {
      fetch: async (_t, i) => (i === 0 ? { mode: 'stream' as const, url: '/v1/tts/stream/abc', seconds: 1, leftSeconds: 100 } : voiced(100 - i)),
      play: p.play
    }, { onVideo: (i) => seen.push(i) });
    await vi.waitFor(() => expect(p.played).toHaveLength(1));
    p.ends[0]();
    await vi.waitFor(() => expect(p.played).toHaveLength(2));
    p.ends[1]();
    expect(await s.done).toEqual({ mode: 'voice' });
    expect(seen).toEqual([]);
  });

  /**
   * QA's room run (53be1c0): renders took 2.0–6.8 s each and went one at a time, slower than she speaks; with a 1.2 s
   * grace, 9 of 22 gaps were ~1.2 s and 7 of 15 sentences were lip-synced. Simulated here at those speeds: her voice
   * never waits, renders run 3 at once and come in mid-sentence when late.
   */
  function simulate(concurrency: number) {
    const durations = [1.6, 2.4, 3.1, 2.0, 3.8, 2.6, 4.2, 1.8, 3.0, 2.5, 3.6, 2.2, 4.0, 2.8, 3.4];
    const renderS = [0, 3.1, 2.4, 5.2, 6.8, 2.0, 4.4, 3.6, 2.9, 5.9, 2.2, 4.8, 3.3, 6.1, 2.7];
    const line = durations.map(() => 'あ'.repeat(10) + '。').join('');
    const t0 = Date.now();
    const starts: number[] = [];
    const ends: number[] = [];
    const shownAt: (number | null)[] = durations.map(() => null);
    let open = 0, most = 0;
    const s = speakLine(line, {
      fetch: (_t, i) => new Promise((r) => setTimeout(() => r(i === 0
        ? { mode: 'stream' as const, url: '/v1/tts/stream/x', seconds: durations[0], leftSeconds: 100 }
        : { ...voiced(100), seconds: durations[i] }), i === 0 ? 60 : 330 + 370 * durations[i])),
      play: (clip, onPlaying) => {
        let end = () => undefined as void;
        const done = new Promise<void>((r) => { end = () => { ends.push(Date.now() - t0); r(); }; });
        starts.push(Date.now() - t0);
        onPlaying();
        setTimeout(() => end(), clip.seconds * 1000);
        return { done, stop: end };
      },
      video: (_c, i) => { most = Math.max(most, ++open); return new Promise((r) => setTimeout(() => { open--; r(`blob:video-${i}`); }, renderS[i] * 1000)); },
      videoWaitMs: () => 0,
      videoConcurrency: concurrency
    }, { onVideo: (i, src) => { if (src) shownAt[i] = Date.now() - t0; } });
    return { s, starts, ends, shownAt, durations, most: () => most };
  }
  const coverage = (r: ReturnType<typeof simulate>) => {
    let covered = 0, total = 0, fromStart = 0, any = 0;
    r.durations.forEach((d, i) => {
      total += d;
      const at = r.shownAt[i];
      if (at === null) return;
      any++;
      const late = Math.max(0, at - r.starts[i]) / 1000;
      if (late < 0.05) fromStart++;
      covered += Math.max(0, d - late);
    });
    return { sentences: r.durations.length, fromStart, any, audio: +(covered / total).toFixed(2) };
  };

  it('QA pace simulated: her voice never waits for video (no gap); 3 renders at once lip-sync far more of her than one at a time', async () => {
    vi.useFakeTimers();
    const one = simulate(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await one.s.done;
    const three = simulate(3);
    await vi.advanceTimersByTimeAsync(120_000);
    await three.s.done;
    vi.useRealTimers();
    const gaps = (r: typeof one) => r.starts.slice(1).map((st, k) => st - r.ends[k]);
    for (const r of [one, three]) expect(Math.max(...gaps(r))).toBeLessThanOrEqual(250);
    const c1 = coverage(one), c3 = coverage(three);
    console.log('LIPSYNC coverage (15 sentences, warm, renders 2.0–6.8 s): one at a time', JSON.stringify(c1), '· three at once', JSON.stringify(c3));
    expect(three.most()).toBeLessThanOrEqual(3);
    expect(c3.any).toBeGreaterThan(c1.any);
    expect(c3.audio).toBeGreaterThanOrEqual(0.6);
    // The streamed first sentence is never rendered.
    expect(three.shownAt[0]).toBeNull();
  });

  it('a render that comes while her sentence sounds is switched to at once (late), never held for', async () => {
    const p = player();
    const seen: [number, string | null, boolean][] = [];
    let release: (() => void) | null = null;
    const s = speakLine('一つ目の文です。二つ目の文です。', {
      fetch: async (_t, i) => voiced(100 - i),
      play: p.play,
      video: (_c, i) => (i === 0 ? new Promise<string | null>((r) => { release = () => r('blob:late-0'); }) : Promise.resolve(null)),
      videoWaitMs: () => 0
    }, { onVideo: (i, src, late) => seen.push([i, src, !!late]) });
    await vi.waitFor(() => expect(p.played).toHaveLength(1));
    expect(seen).toEqual([[0, null, false]]);
    release!();
    await vi.waitFor(() => expect(seen).toEqual([[0, null, false], [0, 'blob:late-0', true]]));
    p.ends[0]();
    await vi.waitFor(() => expect(p.played).toHaveLength(2));
    p.ends[1]();
    expect(await s.done).toEqual({ mode: 'voice' });
  });

  it('within: the value when it comes in time, the fallback when not', async () => {
    expect(await within(Promise.resolve('v'), 50, null)).toBe('v');
    expect(await within(new Promise<string>(() => undefined), 10, null)).toBeNull();
    expect(await within(Promise.reject(new Error('x')), 50, 'fb')).toBe('fb');
  });

  it('requestLipsync sends her audio with its token and his session, and answers null on anything but a video', async () => {
    localStorage.setItem('jstar.token', 'sess.ion.jwt');
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create });
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Blob(['mp4']), { status: 200, headers: { 'content-type': 'video/mp4', 'x-end-frame': '118' } });
    }) as unknown as typeof fetch;
    const r = await requestLipsync({ clip: 'mahiro-talk-9x16', audio: btoa('abc'), mime: 'audio/wav', token: 't.k', start: 30 }, ok);
    expect(r).toEqual({ url: 'blob:x', endFrame: 118 });
    expect(calls[0].url).toMatch(/\/v1\/lipsync\?clip=mahiro-talk-9x16&start=30$/);
    expect((calls[0].init.headers as Record<string, string>)['x-lipsync-token']).toBe('t.k');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sess.ion.jwt');
    expect(new TextDecoder().decode(calls[0].init.body as Uint8Array)).toBe('abc');
    const refused = (async () => Response.json({ error: 'not_her_voice' }, { status: 403 })) as unknown as typeof fetch;
    expect(await requestLipsync({ clip: 'mahiro-talk-9x16', audio: btoa('abc'), mime: 'audio/wav', token: 't.k', start: 0 }, refused)).toBeNull();
    const offline = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await requestLipsync({ clip: 'mahiro-talk-9x16', audio: btoa('abc'), mime: 'audio/wav', token: 't.k', start: 0 }, offline)).toBeNull();
    localStorage.removeItem('jstar.token');
  });

  it('warmLipsync sends his session and never throws, online or not', () => {
    const f = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    localStorage.setItem('jstar.token', 'sess.ion.jwt');
    expect(() => warmLipsync('mahiro', f)).not.toThrow();
    expect(f).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/lipsync\/warm\?star=mahiro$/), { method: 'POST', headers: { authorization: 'Bearer sess.ion.jwt' } });
    localStorage.removeItem('jstar.token');
    resetWarm();
    warmLipsync('nana', f);
    expect(f).toHaveBeenLastCalledWith(expect.stringMatching(/star=nana$/), { method: 'POST', headers: {} });
  });

  it('asks to warm at most once a minute, and not again before a 429\'s Retry-After (no console error on re-entry)', async () => {
    resetWarm();
    const f = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } })) as unknown as typeof fetch;
    warmLipsync('mahiro', f, 0);
    warmLipsync('nana', f, 30_000);
    expect(f).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    warmLipsync('mahiro', f, WARM_EVERY_MS + 1);
    expect(f).toHaveBeenCalledTimes(1);
    warmLipsync('mahiro', f, 120_001);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('L14: a reload (or a cold link into her room) within the minute asks again for nothing — kept for the session', async () => {
    resetWarm();
    const f = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    warmLipsync('mahiro', f, 1_000_000);
    expect(f).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const fresh = await import('../../src/lib/lipsync');
    fresh.warmLipsync('mahiro', f, 1_030_000);
    expect(f).toHaveBeenCalledTimes(1);
    fresh.warmLipsync('mahiro', f, 1_000_000 + WARM_EVERY_MS + 1);
    expect(f).toHaveBeenCalledTimes(2);
    fresh.resetWarm();
  });
});

describe('a recorded line\'s render on her voice\'s clock (#73: QA 53be1c0, lag and pose jump)', () => {
  /**
   * A render as a browser plays it: a seek takes `seekMs` to land, playback runs at real time, data arrives at
   * `readyAt` (audio seconds). The voice starts at 0 and runs to `audioEnd`. Every 16 ms the player calls syncStep.
   */
  function simulate(o: { readyAt?: number; seekMs?: number; duration?: number; audioEnd?: number; stall?: [number, number] } = {}) {
    const { readyAt = 0, seekMs = 60, duration = 4, audioEnd = 4 } = o;
    const r = { time: 0, paused: true, seeking: false, seekDone: 0, seekTo: 0 };
    let shown = false;
    const shownAt: { t: number; drift: number }[] = [];
    for (let ms = 0; ms <= audioEnd * 1000; ms += 16) {
      const t = ms / 1000;
      if (r.seeking && ms >= r.seekDone) { r.seeking = false; r.time = r.seekTo; }
      // A stall: the render's playback freezes for a while (it falls behind her voice).
      const stalled = o.stall && t >= o.stall[0] && t < o.stall[1];
      if (!r.paused && !r.seeking && !stalled) r.time += 0.016;
      const step = syncStep({ time: r.time, readyState: t >= readyAt ? 4 : 1, seeking: r.seeking, paused: r.paused, duration }, t, t >= audioEnd, shown);
      if (step.pause) r.paused = true;
      if (step.seek !== undefined) { r.seeking = true; r.seekDone = ms + seekMs; r.seekTo = step.seek; }
      if (step.play) r.paused = false;
      shown = step.show;
      if (shown) shownAt.push({ t, drift: r.time - t });
    }
    return shownAt;
  }

  it('loaded ahead: it is on screen within a few frames of her voice, and never more than 40 ms off it', () => {
    const shown = simulate();
    expect(shown[0].t).toBeLessThan(0.2);
    expect(Math.max(...shown.map((s) => Math.abs(s.drift)))).toBeLessThanOrEqual(LIPSYNC_DRIFT_S + 0.001);
    expect(shown.length).toBeGreaterThan(200);
  });

  it('late: the clip stays until the render can play at the right moment, then it comes in mid-line, in step', () => {
    const shown = simulate({ readyAt: 1.3 });
    expect(shown[0].t).toBeGreaterThanOrEqual(1.3);
    expect(Math.max(...shown.map((s) => Math.abs(s.drift)))).toBeLessThanOrEqual(LIPSYNC_DRIFT_S + 0.001);
  });

  it('a render that falls behind is put back in step (and stays on screen meanwhile)', () => {
    const shown = simulate({ stall: [1.5, 1.8] });
    const after = shown.filter((s) => s.t > 2.2);
    expect(after.length).toBeGreaterThan(50);
    expect(Math.max(...after.map((s) => Math.abs(s.drift)))).toBeLessThanOrEqual(LIPSYNC_DRIFT_S + 0.001);
  });

  it('her voice asked to play but not sounding yet: the render waits on its first frame, unseen; then starts with her', () => {
    const parked = { time: 0, readyState: 4, seeking: false, paused: true, duration: 4 };
    expect(syncStep(parked, 0, false, false)).toEqual({ show: false });
    expect(syncStep({ ...parked, paused: false, time: 0.2 }, 0, false, false)).toEqual({ show: false, pause: true, seek: 0 });
    // She sounds (a frame in): it starts at once and is shown (fading in) — within 40 ms of her, no seek.
    expect(syncStep(parked, 0.02, false, false)).toEqual({ show: true, play: true });
    // Not loaded at her first frame: no start yet; once she is past 40 ms it is parked ahead to come in later.
    expect(syncStep({ ...parked, readyState: 2 }, 0.02, false, false)).toEqual({ show: false });
    expect(syncStep({ ...parked, readyState: 2 }, 0.3, false, false)).toEqual({ show: false, seek: 0.3 + LIPSYNC_LEAD_S });
  });

  it('her voice done: the render holds its last frame for the hand back, unless it never showed', () => {
    const r = { time: 3.9, readyState: 4, seeking: false, paused: false, duration: 4 };
    expect(syncStep(r, 3.95, true, true)).toEqual({ show: true, pause: true });
    expect(syncStep(r, 3.95, true, false)).toEqual({ show: false, pause: true });
    expect(syncStep({ ...r, readyState: 0 }, 0.5, false, false)).toEqual({ show: false });
  });

  it('the clip under it is moved to the render\'s frame, so neither handover jumps (loops wrap, one-shots stop)', () => {
    expect(clipTimeFor(2.5, 8, true)).toBe(2.5);
    expect(clipTimeFor(9.25, 8, true)).toBe(1.25);
    expect(clipTimeFor(9.25, 8, false)).toBeCloseTo(8 - 1 / 24);
    expect(clipTimeFor(1, Number.NaN, true)).toBeNull();
  });

  it('preload: the renders of the line about to play and of the next one, on the shot each plays over', () => {
    type B = { type: string; id: string; media?: string };
    const beats: B[] = [
      { type: 'line', id: 'a' }, { type: 'choice', id: 'q' }, { type: 'clip', id: 'c', media: 'close' },
      { type: 'line', id: 'b' }, { type: 'line', id: 'c2' }, { type: 'line', id: 'd' }
    ];
    const src = (b: B, shot: string) => (b.id === 'c2' ? null : `${shot}/${b.id}`);
    expect(upcomingRenders(beats, 0, 'wide', (b) => (b.type === 'clip' ? b.media! : null), src)).toEqual(['wide/a', 'close/b']);
    expect(upcomingRenders(beats, 3, 'close', (b) => (b.type === 'clip' ? b.media! : null), src, 3)).toEqual(['close/b', 'close/d']);
    expect(upcomingRenders(beats, 6, 'wide', () => null, src)).toEqual([]);
  });
});
