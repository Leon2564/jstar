import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ringtoneOf, useRingtone } from '../../src/lib/ringtone';
import { setSound } from '../../src/lib/sound';

/** #12: her call rings in her own voice; refused autoplay (or his sound off) leaves a tap to hear her. */
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Call({ src }: { src: string | null }) {
  const r = useRingtone(src);
  return r.blocked ? <button type="button" onClick={r.unmute} data-testid="tap">tap</button> : <span data-testid="ringing">ringing</span>;
}

describe('her ringtone (#12)', () => {
  it('is the recording of the line she wakes him with; else her greeting, a morning one for her alarm', () => {
    expect(ringtoneOf({ star: 'nana', kind: 'wakeup', payload: { voice: '/voice/scene/nana/abc.mp3' } })).toBe('/voice/scene/nana/abc.mp3');
    expect(ringtoneOf({ star: 'nana', kind: 'wakeup', payload: {} }, 22)).toBe('/voice/greet/nana-morning.mp3');
    expect(ringtoneOf({ star: 'eimi', kind: 'message', payload: { voice: 'https://evil.example/x.mp3' } }, 19)).toBe('/voice/greet/eimi-evening.mp3');
  });

  it('rings by itself when the browser lets it; refused, the call offers a tap that plays it', async () => {
    setSound(true);
    const played: string[] = [];
    let allow = true;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      played.push(this.src);
      return allow ? Promise.resolve() : Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    render(<Call src="/voice/greet/nana-morning.mp3" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('ringing')).toBeTruthy();
    expect(played.at(-1)).toContain('/voice/greet/nana-morning.mp3');
    cleanup();

    allow = false;
    render(<Call src="/voice/greet/nana-morning.mp3" />);
    expect(await screen.findByTestId('tap')).toBeTruthy();
    allow = true;
    await act(async () => { fireEvent.click(screen.getByTestId('tap')); await Promise.resolve(); });
    expect(await screen.findByTestId('ringing')).toBeTruthy();
  });

  it('with his sound off she does not ring by herself', async () => {
    setSound(false);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<Call src="/voice/greet/nana-morning.mp3" />);
    expect(await screen.findByTestId('tap')).toBeTruthy();
    expect(play).not.toHaveBeenCalled();
    setSound(true);
  });
});

describe('her ringtone loops (L5, C-room 47b0fcb: it rang once)', () => {
  it('rings again after each ring until he answers or puts her off', async () => {
    vi.useFakeTimers();
    setSound(true);
    let plays = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { plays++; return Promise.resolve(); });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    // Each ring ends with no `ended` event: paused, part-way through (as a browser may leave a finished clip).
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(true);
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockReturnValue(3.5);
    const { rerender } = render(<Call src="/voice/greet/nana-morning.mp3" />);
    await act(async () => { await Promise.resolve(); });
    expect(plays).toBe(1);
    await act(async () => { vi.advanceTimersByTime(500 + 1_400 + 10); await Promise.resolve(); });
    expect(plays).toBe(2);
    await act(async () => { vi.advanceTimersByTime(3 * (500 + 1_400)); await Promise.resolve(); });
    expect(plays).toBeGreaterThanOrEqual(4);
    // Answered (no call any more): she stops.
    rerender(<Call src={null} />);
    const at = plays;
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(plays).toBe(at);
    vi.useRealTimers();
  });
});
