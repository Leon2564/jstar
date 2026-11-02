import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LIPSYNC_ALIGN_WAIT_S, alignPlan, clipTimeIn, cutStartFor, phaseSrc, startPlan } from '../../src/lib/lipsync';
import { MEDIA } from '../../src/data/media.gen';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/**
 * #73, QA of d53e8ba: her render begins on its clip's frame 0, so her line starts lip-synced only with the clip there —
 * no pose change when the render takes over (the アリス confession close-up re-framed and tilted at the takeover).
 */
describe('her line starts on the render\'s first frame', () => {
  it('now: the clip was just cut to (her talk loop) or is on its frame 0', () => {
    expect(alignPlan(0, 7.9, true)).toEqual({ kind: 'now' });
    expect(alignPlan(0.015, 7.9, true)).toEqual({ kind: 'now' });
  });

  it('wrap: a loop about to come round waits for it, never longer than LIPSYNC_ALIGN_WAIT_S', () => {
    const p = alignPlan(7.7, 7.9, true);
    expect(p.kind).toBe('wrap');
    expect(p.kind === 'wrap' && p.waitS).toBeCloseTo(0.2);
    expect(alignPlan(7.9 - LIPSYNC_ALIGN_WAIT_S - 0.01, 7.9, true)).toEqual({ kind: 'none' });
  });

  it('none: mid-clip (0.15–6.4 s in, as QA found), a one-shot, or no clip timing: her clip as it is, without the render', () => {
    for (const t of [0.15, 1.85, 5.07, 6.4]) expect(alignPlan(t, 7.9, true)).toEqual({ kind: 'none' });
    expect(alignPlan(7.7, 7.9, false)).toEqual({ kind: 'none' });
    expect(alignPlan(1, Number.NaN, true)).toEqual({ kind: 'none' });
  });

  it('a cut is timed so the clip comes round to frame 0 just after her line is due (she waits only the lead)', () => {
    const D = 7.9;
    for (const hold of [0, 1.5, 2, 5.5, 9]) {
      const s = cutStartFor(D, hold)!;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(D);
      // Where the clip is when her line is due, and how long she then waits for frame 0.
      const at = (s + hold) % D;
      const plan = alignPlan(at, D, true);
      expect(plan.kind).toBe('wrap');
      expect(plan.kind === 'wrap' && plan.waitS).toBeCloseTo(0.12, 2);
    }
    expect(cutStartFor(Number.NaN, 2)).toBeNull();
    expect(cutStartFor(7.9, -1)).toBeNull();
  });
});

describe('the scene stage: a clip held on its frame, a cut started where asked', () => {
  function stubMedia() {
    const play = vi.fn(function (this: HTMLMediaElement) { return Promise.resolve(); });
    const pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    // jsdom plays nothing: say it could, so the stage gives each layer its <video>.
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    const times = new WeakMap<HTMLMediaElement, number>();
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true, get() { return times.get(this) ?? 0; }, set(v: number) { times.set(this, v); }
    });
    return { play, pause };
  }

  it('a cut starts the clip at startAt; held, it is not played until let go', async () => {
    const { play } = stubMedia();
    const { ClipStage } = await import('../../src/scene/stage');
    const entry = MEDIA['mahiro-herohd-9x16'];
    const handle = { current: null };
    const r = render(<ClipStage layers={[entry]} active={null} loops={{}} handle={handle} held={entry.id} startAt={{ [entry.id]: 6.25 }} />);
    r.rerender(<ClipStage layers={[entry]} active={entry.id} loops={{}} handle={handle} held={entry.id} startAt={{ [entry.id]: 6.25 }} />);
    const v = r.container.querySelector('video')!;
    expect(v.currentTime).toBe(6.25);
    expect(play).not.toHaveBeenCalled();
    r.rerender(<ClipStage layers={[entry]} active={entry.id} loops={{}} handle={handle} held={null} startAt={{ [entry.id]: 6.25 }} />);
    expect(play).toHaveBeenCalled();
    // Letting go does not restart the shot: it goes on from where it is.
    expect(v.currentTime).toBe(6.25);
  });

  it('without startAt a cut starts from frame 0, as before', async () => {
    stubMedia();
    const { ClipStage } = await import('../../src/scene/stage');
    const entry = MEDIA['mahiro-herohd-9x16'];
    const handle = { current: null };
    const r = render(<ClipStage layers={[entry]} active={null} loops={{}} handle={handle} />);
    const v = r.container.querySelector('video')!;
    v.currentTime = 3;
    r.rerender(<ClipStage layers={[entry]} active={entry.id} loops={{}} handle={handle} />);
    expect(v.currentTime).toBe(0);
  });
});

/** #73, owner's option b: phase renders every 7th frame let her line start wherever the clip is, on its own frame. */
describe('phase renders: her line starts where the clip is', () => {
  const N = 190, D = N / 24, STEP = 7;

  it('the next phase frame at least half a frame ahead; she waits for it under 0.3 s', () => {
    for (const t of [0.15, 1.85, 5.07, 6.4]) {
      const p = startPlan(t, D, true, N, STEP, true);
      expect(p.kind).toBe('phase');
      if (p.kind !== 'phase') continue;
      expect(p.frame % STEP).toBe(0);
      expect(p.frame / 24).toBeGreaterThan(t);
      expect(p.waitS).toBeLessThanOrEqual(STEP / 24 + 0.03);
      expect(p.frame / 24 - t).toBeCloseTo(p.waitS, 5);
    }
  });

  it('on frame 0, or coming round to it within a step: the phase-0 render', () => {
    expect(startPlan(0, D, true, N, STEP, true)).toEqual({ kind: 'now' });
    const w = startPlan(D - 0.2, D, true, N, STEP, true);
    expect(w.kind).toBe('wrap');
  });

  it('no phases (talk loops, lines without them): as before — only on frame 0 or within 0.3 s of it', () => {
    expect(startPlan(1.85, D, true, N, STEP, false)).toEqual({ kind: 'none' });
    expect(startPlan(0, D, true, N, STEP, false)).toEqual({ kind: 'now' });
  });

  it('a one-shot clip past its last phase: none', () => {
    expect(startPlan(D - 0.02, D, false, N, STEP, true)).toEqual({ kind: 'none' });
    expect(startPlan(D - 0.1, D, false, N, STEP, true)).toMatchObject({ kind: 'phase', frame: 189 });
  });

  it('phase renders are named by their first frame, 720p, and only where they exist', () => {
    const ph = { step: 7, clips: { 'alice-confession-close-9x16': { n: 190, ids: ['5e408a9ed8b4'] }, 'alice-sys-goodnight-16x9': { n: 100, ids: ['5e408a9ed8b4'] } } };
    const v = '/voice/scene/alice/5e408a9ed8b4.mp3';
    expect(phaseSrc(ph, 'alice-confession-close-9x16', v, 42)).toBe('/lipsync/v1/alice-confession-close-9x16/5e408a9ed8b4-p42-720x1280.mp4');
    expect(phaseSrc(ph, 'alice-sys-goodnight-16x9', v, 7)).toBe('/lipsync/v1/alice-sys-goodnight-16x9/5e408a9ed8b4-p7-1280x720.mp4');
    expect(phaseSrc(ph, 'alice-confession-close-9x16', v, 43)).toBeNull();
    expect(phaseSrc(ph, 'alice-confession-close-9x16', v, 0)).toBeNull();
    expect(phaseSrc(ph, 'alice-confession-close-9x16', v, 196)).toBeNull();
    expect(phaseSrc(ph, 'alice-confession-close-9x16', '/voice/scene/alice/000000000000.mp3', 42)).toBeNull();
    expect(phaseSrc(null, 'alice-confession-close-9x16', v, 42)).toBeNull();
  });

  it('where the clip will be when her next line starts (for loading its phase render ahead)', () => {
    expect(clipTimeIn(6, 3, 7.9, true)).toBeCloseTo(1.1);
    expect(clipTimeIn(6, 3, 7.9, false)).toBe(7.9);
  });

  it('the shipped phase list names clips and recording ids only', async () => {
    const list = (await import('../../src/data/lipsync.phases.gen.json')).default as { step: number; clips: Record<string, { n: number; ids: string[] }> };
    expect(list.step).toBe(7);
    for (const [clip, c] of Object.entries(list.clips)) {
      expect(clip).toMatch(/^(mahiro|nana|unpai|alice|eimi)-[a-z0-9-]+-(9x16|16x9)$/);
      expect(c.n).toBeGreaterThan(7);
      for (const id of c.ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});
