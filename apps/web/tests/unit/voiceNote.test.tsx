import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useNoteTime } from '../../src/lib/voiceNote';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A stand-in <audio> whose header says how long it is (jsdom loads no media). */
function fakeAudio(seconds: Record<string, number>) {
  const made: FakeAudio[] = [];
  class FakeAudio {
    duration = NaN;
    onloadedmetadata: (() => void) | null = null;
    constructor(public src: string) { made.push(this); }
    load() { this.duration = seconds[this.src]; this.onloadedmetadata?.(); }
  }
  vi.stubGlobal('Audio', FakeAudio);
  return made;
}

function Note({ src }: { src: string | null }) {
  return <span data-testid="t">{useNoteTime(src)}</span>;
}

describe('her voice note shows its length (#165)', () => {
  it('reads it from the file and shows it as A2 does, m:ss', async () => {
    const made = fakeAudio({ '/voice/msg/a.mp3': 6.2, '/voice/msg/b.mp3': 75, '/voice/msg/c.mp3': 0.3 });
    const { rerender } = render(<Note src="/voice/msg/a.mp3" />);
    // Nothing until the header is in: never a wrong time.
    expect(screen.getByTestId('t').textContent).toBe('');
    await act(async () => made[0].load());
    expect(screen.getByTestId('t').textContent).toBe('0:06');
    rerender(<Note src="/voice/msg/b.mp3" />);
    expect(screen.getByTestId('t').textContent).toBe('');
    await act(async () => made[1].load());
    expect(screen.getByTestId('t').textContent).toBe('1:15');
    rerender(<Note src="/voice/msg/c.mp3" />);
    await act(async () => made[2].load());
    expect(screen.getByTestId('t').textContent).toBe('0:01');
  });

  it('the last note\'s late answer never shows on the next one; no note, no file asked for', async () => {
    const made = fakeAudio({ '/voice/msg/a.mp3': 9, '/voice/msg/b.mp3': 4 });
    const { rerender } = render(<Note src="/voice/msg/a.mp3" />);
    rerender(<Note src="/voice/msg/b.mp3" />);
    await act(async () => made[0].load());
    expect(screen.getByTestId('t').textContent).toBe('');
    await act(async () => made[1].load());
    expect(screen.getByTestId('t').textContent).toBe('0:04');
    rerender(<Note src={null} />);
    expect(screen.getByTestId('t').textContent).toBe('');
    expect(made).toHaveLength(2);
  });
});
