import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VOICE_INPUT } from '@jstar/shared/voice';
import { StoreProvider, useStore } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { createVoice, HOLD_MS, resetVoiceSupport, serverEngine, speechEngine, voiceEngines, type EngineFactory, type VoiceNotice, type VoiceSnapshot } from '../../src/lib/voice';
import { InputBar } from '../../src/scene/ui';
import * as sound from '../../src/lib/sound';

/**
 * Voice input (#72). The browser's SpeechRecognition is replaced by a fake that the tests drive: it opens, hears
 * words (interim, then final), ends or fails exactly when told to.
 */
class FakeRec {
  static all: FakeRec[] = [];
  static get last() { return FakeRec.all[FakeRec.all.length - 1]; }
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: { results: unknown }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false; stopped = false; aborted = false;
  constructor() { FakeRec.all.push(this); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  open() { this.onstart?.(); }
  /** Each part is one recognised phrase; `final` marks the ones the recogniser will not change any more. */
  hear(...parts: [string, boolean?][]) { this.onresult?.({ results: parts.map(([t, final]) => Object.assign([{ transcript: t }], { isFinal: !!final })) }); }
  end() { this.onend?.(); }
  fail(error: string) { this.onerror?.({ error }); }
}

const w = window as unknown as { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown; __E2E__?: boolean };
beforeAll(() => { w.__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { FakeRec.all = []; w.webkitSpeechRecognition = FakeRec; resetVoiceSupport(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete w.webkitSpeechRecognition; delete w.SpeechRecognition; });

function machine(engines = voiceEngines(null)) {
  const sent: string[] = [];
  const notices: VoiceNotice[] = [];
  const phases: VoiceSnapshot['phase'][] = [];
  const onStart = vi.fn();
  const v = createVoice({
    lang: 'ja', engines, onStart,
    onFinal: (t) => sent.push(t), onNotice: (n) => notices.push(n),
    onChange: (s) => { if (phases[phases.length - 1] !== s.phase) phases.push(s.phase); }
  });
  return { v, sent, notices, phases, onStart };
}

describe('voice state machine (mocked SpeechRecognition)', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('hold to talk: idle → listening with live words → let go → final words sent → idle', () => {
    const { v, sent, phases, onStart } = machine();
    expect(v.get().phase).toBe('idle');
    v.press();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(v.get().phase).toBe('starting');
    const rec = FakeRec.last;
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe('ja-JP');
    expect(rec.interimResults).toBe(true);
    rec.open();
    expect(v.get().phase).toBe('listening');
    rec.hear(['ただい']);
    expect(v.get().text).toBe('ただい');
    vi.advanceTimersByTime(HOLD_MS + 50);
    rec.hear(['ただいま', true]);
    v.release();
    expect(rec.stopped).toBe(true);
    expect(v.get().phase).toBe('finishing');
    expect(sent).toEqual([]);
    rec.hear(['ただいま', true], ['、疲れた', true]);
    rec.end();
    expect(sent).toEqual(['ただいま、疲れた']);
    expect(v.get()).toMatchObject({ phase: 'idle', text: '' });
    expect(phases).toEqual(['starting', 'listening', 'finishing', 'idle']);
  });

  it('a short tap keeps listening until the next tap (accessible toggle), and toggle() does the same for keyboards', () => {
    const { v, sent } = machine();
    v.press();
    FakeRec.last.open();
    vi.advanceTimersByTime(100);
    v.release();
    expect(v.get().phase).toBe('listening');
    FakeRec.last.hear(['おはよう']);
    v.press();
    expect(FakeRec.last.stopped).toBe(true);
    FakeRec.last.end();
    expect(sent).toEqual(['おはよう']);

    v.toggle();
    FakeRec.last.open();
    FakeRec.last.hear(['hi', true]);
    v.toggle();
    FakeRec.last.end();
    expect(sent).toEqual(['おはよう', 'hi']);
  });

  it('letting go during the permission prompt keeps it listening instead of cutting him off', () => {
    const { v } = machine();
    v.press();
    vi.advanceTimersByTime(3000);
    v.release();
    FakeRec.last.open();
    expect(v.get().phase).toBe('listening');
    expect(FakeRec.last.stopped).toBe(false);
  });

  it('stops by itself after the silence that follows his words, and sends them', () => {
    const { v, sent } = machine();
    v.toggle();
    FakeRec.last.open();
    FakeRec.last.hear(['会いたかった']);
    vi.advanceTimersByTime(VOICE_INPUT.silenceMs - 1);
    FakeRec.last.hear(['会いたかったよ']);
    vi.advanceTimersByTime(VOICE_INPUT.silenceMs - 1);
    expect(FakeRec.last.stopped).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeRec.last.stopped).toBe(true);
    FakeRec.last.end();
    expect(sent).toEqual(['会いたかったよ']);
  });

  it('stops at the 30-second cap even while he keeps talking', () => {
    const { v, sent } = machine();
    v.toggle();
    FakeRec.last.open();
    for (let s = 0; s < 30; s++) { FakeRec.last.hear([`あ${s}`]); vi.advanceTimersByTime(1000); }
    expect(FakeRec.last.stopped).toBe(true);
    FakeRec.last.end();
    expect(sent).toEqual(['あ29']);
  });

  it('gives up when nothing is said, without sending', () => {
    const { v, sent, notices } = machine();
    v.toggle();
    FakeRec.last.open();
    vi.advanceTimersByTime(VOICE_INPUT.noSpeechMs);
    expect(FakeRec.last.aborted).toBe(true);
    expect(v.get().phase).toBe('idle');
    expect(sent).toEqual([]);
    expect(notices).toEqual(['noSpeech']);
    // The recogniser's own no-speech error is the same, and an end with nothing heard too.
    v.toggle(); FakeRec.last.open(); FakeRec.last.fail('no-speech');
    v.toggle(); FakeRec.last.open(); FakeRec.last.end();
    expect(notices).toEqual(['noSpeech', 'noSpeech', 'noSpeech']);
    expect(sent).toEqual([]);
  });

  it('a refused microphone: nothing sent, a clear notice, and the next press asks again', () => {
    const { v, sent, notices } = machine();
    v.press();
    FakeRec.last.fail('not-allowed');
    expect(v.get()).toMatchObject({ phase: 'idle', blocked: true });
    expect(notices).toEqual(['denied']);
    expect(sent).toEqual([]);
    v.press();
    expect(FakeRec.all).toHaveLength(2);
    FakeRec.last.open();
    expect(v.get().blocked).toBe(false);
  });

  it('typing takes over: cancel stops listening and sends nothing', () => {
    const { v, sent } = machine();
    v.toggle();
    FakeRec.last.open();
    FakeRec.last.hear(['えっと']);
    v.cancel();
    expect(FakeRec.last.aborted).toBe(true);
    expect(v.get().phase).toBe('idle');
    FakeRec.last.end();
    expect(sent).toEqual([]);
  });

  it('when the browser\'s speech service is off (iOS without dictation), the server recogniser takes over the same press', async () => {
    const heard: string[] = [];
    const server: EngineFactory = (_lang, ev) => {
      queueMicrotask(() => { ev.onStart(); ev.onSound(); });
      return { stop: () => { ev.onText('サーバーで聞いた'); ev.onEnd(); heard.push('stop'); }, abort: () => undefined };
    };
    const { v, sent } = machine([{ kind: 'speech', make: speechEngine }, { kind: 'server', make: server }]);
    v.toggle();
    FakeRec.last.fail('service-not-allowed');
    await Promise.resolve();
    expect(v.get().phase).toBe('listening');
    v.toggle();
    expect(sent).toEqual(['サーバーで聞いた']);
    // The broken recogniser is not offered again this visit.
    expect(voiceEngines(null)).toEqual([]);
  });

  it('unsupported: no speech recognition and no server fallback means no recognisers at all', () => {
    delete w.webkitSpeechRecognition;
    expect(voiceEngines(null)).toEqual([]);
    expect(voiceEngines(() => ({ stop() {}, abort() {} }))).toEqual([]); // jsdom cannot record either
  });
});

describe('server recogniser (MediaRecorder + POST /v1/asr)', () => {
  class FakeRecorder {
    static isTypeSupported = (t: string) => t === 'audio/mp4';
    static last: FakeRecorder;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/mp4';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: unknown, public opts: { mimeType?: string }) { FakeRecorder.last = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['aac'], { type: 'audio/mp4' }) }); this.onstop?.(); }
  }
  const track = { stop: vi.fn() };
  let gum: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    delete w.webkitSpeechRecognition;
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    gum = vi.fn(async () => ({ getTracks: () => [track] }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } });
  });
  afterEach(() => { delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder; });

  it('records on first use only, uploads the clip with its type and her language, sends the words, and frees the mic', async () => {
    const upload = vi.fn(async (clip: Blob, lang: string) => `${clip.type}:${lang}:聞こえた`);
    const engines = voiceEngines(serverEngine(upload));
    expect(engines.map((e) => e.kind)).toEqual(['server']);
    const { v, sent } = machine(engines);
    expect(gum).not.toHaveBeenCalled();
    v.toggle();
    await waitFor(() => expect(v.get().phase).toBe('listening'));
    expect(gum).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.last.opts.mimeType).toBe('audio/mp4');
    v.toggle();
    await waitFor(() => expect(sent).toEqual(['audio/mp4:ja:聞こえた']));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it('a refused microphone is "denied", and a server that is off drops the mic for the visit', async () => {
    gum.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    const upload = vi.fn(async () => { throw Object.assign(new Error('asr_unavailable'), { code: 'asr_unavailable' }); });
    const { v, notices } = machine(voiceEngines(serverEngine(upload)));
    v.toggle();
    await waitFor(() => expect(notices).toEqual(['denied']));
    v.toggle();
    await waitFor(() => expect(v.get().phase).toBe('listening'));
    v.toggle();
    await waitFor(() => expect(notices).toEqual(['denied', 'failed']));
    expect(voiceEngines(serverEngine(upload))).toEqual([]);
  });
});

describe('the mic in the text boxes', () => {
  let latest: AppState;
  function Spy() { latest = useStore().state; return null; }
  const renderAt = (path: string, patch: Partial<AppState> = {}) => render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, ...patch }}>
      <Spy />
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );

  it('chat: hold, talk (the box shows it live), let go — sent like a typed message, into the same conversation', async () => {
    const hush = vi.spyOn(sound, 'stopVoice');
    renderAt('/me/chat');
    const mic = await screen.findByRole('button', { name: '声で話す（長押し、またはタップで開始）' });
    const box = screen.getByLabelText('メッセージ') as HTMLInputElement;
    fireEvent.pointerDown(mic);
    expect(hush).toHaveBeenCalled();
    act(() => { FakeRec.last.open(); FakeRec.last.hear(['雨だったね']); });
    expect(box.value).toBe('雨だったね');
    expect(box.placeholder).toBe('聞いてるよ…');
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { await new Promise((r) => setTimeout(r, HOLD_MS + 20)); });
    fireEvent.pointerUp(mic);
    act(() => { FakeRec.last.hear(['雨だったね', true]); FakeRec.last.end(); });
    await waitFor(() => expect(latest.chats.mahiro.map((m) => m.text)).toContain('雨だったね'));
    await waitFor(() => expect(latest.chats.mahiro.filter((m) => m.from === 'her')).toHaveLength(1));
    expect(box.value).toBe('');
    // Text any time: the next message is typed, into the same log.
    fireEvent.change(box, { target: { value: 'おやすみ' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(latest.chats.mahiro.filter((m) => m.from === 'me').map((m) => m.text)).toEqual(['雨だったね', 'おやすみ']));
  });

  it('chat: a refused microphone says so and puts him in the text box', async () => {
    renderAt('/me/chat');
    const mic = await screen.findByRole('button', { name: /声で話す/ });
    fireEvent.pointerDown(mic);
    act(() => { FakeRec.last.fail('not-allowed'); });
    expect(screen.getByText(/マイクが使えないので、文字で話しかけてね/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('メッセージ'));
  });

  it('chat: no mic where the browser can neither recognise nor record', async () => {
    delete w.webkitSpeechRecognition;
    renderAt('/me/chat');
    await screen.findByLabelText('メッセージ');
    expect(screen.queryByTestId('mic')).toBeNull();
  });

  it('scene: the bar is there while she still speaks, and talking over her drops the rest of her lines', async () => {
    renderAt('/me/scene/demo-evening');
    const choices = await screen.findByRole('group', { name: 'なんて答える？' }, { timeout: 4000 });
    fireEvent.click(Array.from(choices.querySelectorAll('button')).find((b) => b.textContent?.includes('今日はちょっと疲れた'))!);
    // Her answer to the choice is still playing, and the free-talk bar (with the mic) is already there.
    const mic = await screen.findByTestId('mic', {}, { timeout: 2000 });
    expect(screen.queryByText('今日あったこと、聞かせて')).toBeNull();
    fireEvent.pointerDown(mic);
    // The scene goes straight to his turn: none of her later lines ("ちょっと待ってて", "もうこんな時間") play.
    await screen.findByText('今日あったこと、聞かせて', {}, { timeout: 4000 });
    expect(screen.getByTestId('scene-sub').textContent).not.toContain('もうこんな時間');
    expect(screen.getByTestId('scene-sub').textContent).not.toContain('すぐ戻るね');
    act(() => { FakeRec.last.open(); FakeRec.last.hear(['ただいま', true]); });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    act(() => { FakeRec.last.end(); });
    expect(await screen.findByTestId('scene-end', {}, { timeout: 5000 })).toBeTruthy();
    expect(latest.chats.mahiro.map((m) => m.text)).toContain('ただいま');
  });

  it('scene bar: reaching for the mic interrupts her, typing mid-sentence takes over, Enter on the mic toggles', async () => {
    const onTalk = vi.fn();
    const onSend = vi.fn();
    render(<StoreProvider initial={{ ...initialState(), ageOk: true }}><InputBar placeholder="まひろに話しかける" onSend={onSend} onTalk={onTalk} /></StoreProvider>);
    const mic = screen.getByTestId('mic');
    const box = screen.getByLabelText('あなたの言葉') as HTMLInputElement;
    fireEvent.pointerDown(mic);
    expect(onTalk).toHaveBeenCalledTimes(1);
    act(() => { FakeRec.last.open(); FakeRec.last.hear(['ただいま']); });
    expect(box.value).toBe('ただいま');
    fireEvent.change(box, { target: { value: 'ただいま！' } });
    expect(FakeRec.last.aborted).toBe(true);
    expect(box.value).toBe('ただいま！');
    expect(onSend).not.toHaveBeenCalled();
    // Keyboard: a click without a pointer (detail 0) starts, the send button stops and sends.
    fireEvent.click(mic, { detail: 0 });
    act(() => { FakeRec.last.open(); FakeRec.last.hear(['おかえり', true]); });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    act(() => { FakeRec.last.end(); });
    // With how long he talked (#74: his voice time in a scene).
    expect(onSend).toHaveBeenCalledWith('おかえり', 'voice', expect.any(Number));
    expect(onSend.mock.calls[0][2]).toBeGreaterThanOrEqual(0);
  });

  it('scene bar: once today\'s voice time is used up it takes text only (#74)', () => {
    render(<StoreProvider initial={{ ...initialState(), ageOk: true }}><InputBar placeholder="まひろに話しかける" onSend={() => undefined} mic={false} /></StoreProvider>);
    expect(screen.queryByTestId('mic')).toBeNull();
    expect(screen.getByLabelText('あなたの言葉')).toBeTruthy();
  });
});
