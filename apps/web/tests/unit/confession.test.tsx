import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { freshRelationship, type RelationshipState } from '@jstar/shared/relationship';
import { jstDay } from '@jstar/shared/rules';
import { LINES } from '@jstar/shared/lines';
import { StoreProvider, useStore, type Actions } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, sanitize, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';
import { sceneMedia } from '@jstar/shared/scenes';
import { CONFESSION_SCENES } from '@jstar/shared/scenes/confession';
import { playable } from '../../src/scene/offer';
import { loadSceneMedia } from '../../src/data/media';

// Prototype mode (no VITE_API_BASE), like the e2e suite: the confession runs on the shared engine in this browser and
// his answer is read by the same word lists the persona service uses without a model.
// The scenes' clips are the lazy scene catalogue (src/data/media.ts): these checks run with it loaded, as the player does.
beforeAll(async () => { expect(await loadSceneMedia()).toBe(true); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** 2026-11-02 at 20:00 and 12:00 JST. */
const EVENING = Date.UTC(2026, 10, 2, 11, 0);
const NOON = Date.UTC(2026, 10, 2, 3, 0);
const at = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(ms); };

let latest: { state: AppState; actions: Actions };
let path = '';
function Spy() { latest = useStore(); path = useLocation().pathname; return null; }
const ready = (patch: Partial<RelationshipState> = {}): RelationshipState =>
  ({ ...freshRelationship('2026-10-27T00:00:00.000Z'), stage: 'confession_ready', stageDay: 7, daysTogether: 7, lastDay: '2026-11-01', rewardRank: 2, ...patch });
/** Her room's 目錄 (A2, #163) holds the secondary things: the bond, the gift, the chips, the demo menu. */
const openIndex = async () => fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
function renderAt(route: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, affinity: { ...initialState().affinity, mahiro: 420 }, rel: { mahiro: ready() }, ...patch }}>
      <MemoryRouter initialEntries={[route]}><Spy /><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const l = LINES.mahiro.confession;

async function answer(text: string) {
  // The bar is there while she still speaks; her question's prompt shows once she waits for him.
  await screen.findByText('あなたの答えを、声で（文字でも）');
  const input = screen.getByLabelText('あなたの言葉');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  return screen.findByTestId('scene-end');
}

describe('her confession (#55, prototype mode)', () => {
  it('plays only clips this build has: her own wide, close and hug at sunset', () => {
    for (const s of CONFESSION_SCENES) expect(playable(sceneMedia(s)), s.meta.id).toBe(true);
  });

  it('in the evening her room opens on it; she confesses close up and asks', async () => {
    at(EVENING);
    renderAt('/me/home');
    // The home and the player are lazy screens: the default wait (tests/unit/setup.ts) covers loading both.
    await waitFor(() => expect(path).toBe('/me/scene/confession-mahiro'));
    await waitFor(() => expect(screen.getByTestId('scene-sub').textContent).toContain(l.ask.ja));
    const scene = screen.getByTestId('scene');
    expect(scene.getAttribute('data-played')).toContain('confess-0');
    expect(scene.getAttribute('data-shot')).toBe('close');
    // Reached: the home will not open on it again today.
    expect(latest.state.confession.mahiro).toMatchObject({ reachedRound: 0, reachedOn: jstDay(EVENING) });
    // Prototype mode keeps no recordings: no consent box.
    expect(screen.queryByTestId('confession-keep')).toBeNull();
  });

  it('by day she only hints; the demo can still open it', async () => {
    at(NOON);
    renderAt('/me/home');
    await waitFor(() => expect(screen.getByTestId('greeting').textContent).toBe(l.hint.ja));
    expect(path).toBe('/me/home');
    const entry = await screen.findByTestId('confession-entry', {}, { timeout: 4000 });
    expect(entry.getAttribute('href')).toContain('/me/scene/confession-mahiro');
    expect(entry.textContent).toContain('まひろの話を聞く');
    expect(screen.queryByTestId('confession-demo')).toBeNull();
  });

  it('yes: lovers today (their anniversary), the memory card, and she says his name', async () => {
    at(EVENING);
    renderAt('/me/scene/confession-mahiro', { freePulls: 0 });
    const end = await answer('はい、よろしくお願いします');
    expect(end.getAttribute('data-testid')).toBe('scene-end');
    expect(screen.getByTestId('confession-anniv').textContent).toBe('今日が、まひろとあなたの記念日。');
    expect(end.textContent).toContain('告白');
    expect(screen.queryByRole('button', { name: 'もう一度' })).toBeNull();
    const scene = screen.getByTestId('scene');
    expect(scene.getAttribute('data-played')).toMatch(/^yes yes-0 yes-1 yes-2 yes-memory yes-end$/);
    expect(latest.state.rel.mahiro).toMatchObject({ stage: 'lover', anniversary: jstDay(EVENING) });
    expect(latest.state.freePulls).toBe(1);
    expect(latest.state.memories.map((m) => m.title)).toContain('告白');
    // The lines were played with {name} filled in (the subtitle of her second accept line).
    expect(l.accept[1].ja).toContain('{name}');
  });

  it('not yet: her gentle reply, the stage stays, and she waits two days together before asking again', async () => {
    at(EVENING);
    renderAt('/me/scene/confession-mahiro');
    await answer('まだ考えさせて');
    expect(screen.getByTestId('confession-later').textContent).toBe('まひろは、あなたの答えを待っています。');
    expect(screen.getByTestId('scene').getAttribute('data-played')).toMatch(/^wait-0 wait-1 wait-end$/);
    expect(latest.state.rel.mahiro?.stage).toBe('confession_ready');
    // The confession evening itself was a day together (the 8th): she asks again from the 10th.
    expect(latest.state.rel.mahiro?.daysTogether).toBe(8);
    expect(latest.state.confession.mahiro).toMatchObject({ tries: 1, lastAnswer: 'not_yet', answeredDays: 8, answeredOn: jstDay(EVENING) });
    cleanup();
    renderAt('/me/home', { confession: latest.state.confession, rel: latest.state.rel });
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    expect(path).toBe('/me/home');
    expect(screen.queryByTestId('confession-entry')).toBeNull();
    await openIndex();
    expect(screen.getByTestId('relationship')).toBeTruthy();
    // Only the demo can bring her confession day back.
    expect(screen.getByTestId('confession-demo')).toBeTruthy();
  });

  it('the demo button makes today her confession day', async () => {
    at(NOON);
    renderAt('/me/home', { rel: {} });
    await openIndex();
    fireEvent.click(await screen.findByTestId('confession-demo'));
    await waitFor(() => expect(latest.state.rel.mahiro?.stage).toBe('confession_ready'));
    expect(screen.getByTestId('stage').textContent).toBe('気になるふたり');
    fireEvent.click(screen.getByTestId('room-index-close'));
    expect(await screen.findByTestId('confession-entry')).toBeTruthy();
  });

  it('keeps a valid stored confession, drops a tampered one', () => {
    const good = { tries: 1, lastAnswer: 'not_yet', answeredDays: 7, answeredOn: '2026-11-02', invitedRound: -1, reachedRound: 0, reachedOn: '2026-11-02' };
    const s = sanitize({ v: 1, confession: { mahiro: good, nana: 'x', eimi: { tries: 'lots', lastAnswer: 'maybe' } } });
    expect(s.confession.mahiro).toEqual(good);
    expect(s.confession.nana).toBeUndefined();
    expect(s.confession.eimi).toMatchObject({ tries: 0, lastAnswer: null });
    act(() => undefined);
  });
});

describe('keeping his voice (#55): only when he asked, the recording recogniser hears him and hands the clip over', () => {
  class FakeRecorder {
    static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus';
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['opus'], { type: 'audio/webm' }) }); this.onstop?.(); }
  }
  class FakeSpeech { lang = ''; continuous = false; interimResults = false; maxAlternatives = 1; onstart = null; onresult = null; onerror = null; onend = null; start() {} stop() {} abort() {} }
  const w = window as unknown as Record<string, unknown>;
  beforeEach(() => {
    w.MediaRecorder = FakeRecorder;
    w.webkitSpeechRecognition = FakeSpeech;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) } });
    vi.spyOn(api, 'asrOn').mockReturnValue(true);
  });
  afterEach(() => { delete w.MediaRecorder; delete w.webkitSpeechRecognition; });

  it('without consent the browser’s own recogniser comes first; with it, the recording one — and the clip goes to `keep`', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useVoice } = await import('../../src/components/voice');
    const { resetVoiceSupport } = await import('../../src/lib/voice');
    resetVoiceSupport();
    const upload = vi.spyOn(api, 'transcribeClip').mockResolvedValue('はい');
    const wrap = ({ children }: { children: React.ReactNode }) => <StoreProvider initial={{ ...initialState(), ageOk: true }}>{children}</StoreProvider>;
    const kept: Blob[] = [];
    const finals: string[] = [];
    const plain = renderHook(() => useVoice({ onFinal: () => undefined }), { wrapper: wrap });
    expect(plain.result.current.available).toBe(true);
    plain.unmount();
    const keeping = renderHook(() => useVoice({ onFinal: (t) => finals.push(t), keep: (b) => kept.push(b) }), { wrapper: wrap });
    act(() => keeping.result.current.ctl.toggle());
    await waitFor(() => expect(keeping.result.current.phase).toBe('listening'));
    act(() => keeping.result.current.ctl.toggle());
    await waitFor(() => expect(finals).toEqual(['はい']));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('audio/webm');
  });
});

describe('her confession message and the memory of his yes (server data, mocked)', () => {
  it('her confession-day message: picking her opens her room on it with ✦, which leads to the confession and reads it (R18)', async () => {
    const msg = { id: 'c1', star: 'nana' as const, kind: 'message' as const, payload: { text: LINES.nana.confession.inbox.ja, scene: 'confession-nana' }, deliveredAt: '2026-11-02T08:00:00.000Z', readAt: null, createdAt: '2026-11-02T08:00:00.000Z' };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [msg], unread: 1 });
    const read = vi.spyOn(api, 'readInbox').mockResolvedValue({ item: { ...msg, readAt: '2026-11-02T09:00:00.000Z' }, unread: 0 });
    at(EVENING);
    renderAt('/me/home', { rel: {} });
    await openIndex();
    fireEvent.click(await screen.findByRole('button', { name: /未読1件/ }));
    // Her room, her line, and ✦: nothing leaves the room until he taps it.
    expect((await screen.findByTestId('inbox-line', {}, { timeout: 4000 })).textContent).toBe(LINES.nana.confession.inbox.ja);
    expect(path).toBe('/me/home');
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('confession-entry', {}, { timeout: 4000 }));
    await waitFor(() => expect(path).toBe('/me/scene/confession-nana'));
    expect(read).toHaveBeenCalledWith('c1');
  });

  it('lists his words, says when no voice was kept, and deletes the recording only after a second tap', async () => {
    const kept = { memoryId: 'mem1', star: 'mahiro' as const, transcript: 'はい、よろしく', audio: true, createdAt: '2026-11-02T11:00:00.000Z' };
    vi.spyOn(api, 'confessionMemories').mockResolvedValue([kept, { ...kept, memoryId: 'mem2', star: 'eimi', audio: false }]);
    const forget = vi.spyOn(api, 'forgetConfessionVoice').mockResolvedValue({ ...kept, audio: false });
    renderAt('/me/cards?tab=memory', { memories: [{ id: 'mem1', star: 'mahiro', title: '告白', date: '11/02' }] });
    const items = await screen.findAllByTestId('confession-memory');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('あなたの答え：「はい、よろしく」');
    expect(items[1].textContent).toContain('録音なし');
    const del = screen.getByTestId('confession-forget');
    fireEvent.click(del);
    expect(forget).not.toHaveBeenCalled();
    expect(del.textContent).toBe('削除する（元に戻せません）');
    fireEvent.click(del);
    await waitFor(() => expect(forget).toHaveBeenCalledWith('mem1'));
    await waitFor(() => expect(screen.getAllByText('録音なし')).toHaveLength(2));
  });
});
