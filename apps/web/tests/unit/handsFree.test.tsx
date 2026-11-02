import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/lib/store';
import { initialState } from '../../src/lib/state';
import { InputBar } from '../../src/scene/ui';
import { handsFreeOn, waitForVoice } from '../../src/lib/handsFree';
import { resetVoiceSupport } from '../../src/lib/voice';

// Hands-free (#72, optional): the level meter waits for his voice, then the ordinary voice input takes over.
class FakeRec {
  static all: FakeRec[] = [];
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
  onstart: (() => void) | null = null; onresult: ((e: { results: unknown }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null; onend: (() => void) | null = null;
  started = false;
  constructor() { FakeRec.all.push(this); }
  start() { this.started = true; }
  stop() {}
  abort() {}
}
const w = window as unknown as { __E2E__: boolean; webkitSpeechRecognition?: unknown; AudioContext?: unknown };

beforeAll(() => { w.__E2E__ = true; });
beforeEach(() => { localStorage.clear(); FakeRec.all = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); delete w.webkitSpeechRecognition; delete w.AudioContext; });

describe('hands-free (#72)', () => {
  /** A microphone and a level meter the test controls. */
  function fakeMic(level: { v: number }) {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
    w.AudioContext = class {
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (b: Float32Array) => b.fill(level.v) }; }
      createMediaStreamSource() { return { connect: () => undefined }; }
      close() { return Promise.resolve(); }
    };
    return stop;
  }

  it('waits on the level meter and starts once he talks, letting the microphone go', async () => {
    vi.useFakeTimers();
    const level = { v: 0 };
    const stop = fakeMic(level);
    const onVoice = vi.fn();
    waitForVoice(onVoice, () => undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(onVoice).not.toHaveBeenCalled();
    level.v = 0.2;
    await vi.advanceTimersByTimeAsync(300);
    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onVoice).toHaveBeenCalledTimes(1);
  });

  it('the switch is remembered, and while armed his voice starts the mic by itself', async () => {
    w.webkitSpeechRecognition = FakeRec;
    resetVoiceSupport();
    const level = { v: 0.3 };
    fakeMic(level);
    const onTalk = vi.fn();
    const ui = (armed: boolean) => <StoreProvider initial={{ ...initialState(), ageOk: true }}><InputBar placeholder="…" onSend={() => undefined} onTalk={onTalk} armed={armed} /></StoreProvider>;
    const { rerender } = render(ui(false));
    const hands = screen.getByTestId('hands-free');
    expect(hands.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(hands);
    expect(handsFreeOn()).toBe(true);
    // Not armed (she is speaking): nothing listens.
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(FakeRec.all).toHaveLength(0);
    rerender(ui(true));
    await waitFor(() => expect(FakeRec.all.length).toBe(1), { timeout: 2000 });
    expect(onTalk).toHaveBeenCalled();
    expect(screen.getByTestId('mic').dataset.phase).toBe('starting');
  });
});
