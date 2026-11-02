import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { MEDIA, type MediaEntry } from '../../src/data/media.gen';
import { pickSources, SceneVideo, SpinViewer, sceneFor } from '../../src/components/stage';
import { makeParticles } from '../../src/components/starfield';
import { homeSceneFor, timeOfDay } from '../../src/pages/me';

afterEach(() => { cleanup(); vi.useRealTimers(); for (const k of Object.keys(MEDIA)) delete MEDIA[k]; });
beforeAll(() => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  // jsdom has neither PointerEvent nor a 2D canvas.
  if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent { pointerId: number; pointerType: string; constructor(t: string, i: PointerEventInit = {}) { super(t, i); this.pointerId = i.pointerId ?? 1; this.pointerType = i.pointerType ?? 'mouse'; } };
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const H264 = 'video/mp4; codecs="avc1.640028"';
const AV1 = 'video/mp4; codecs="av01.0.08M.08"';
const sources = [
  { src: '/a/av1-1920.mp4', type: AV1, width: 1920, height: 1080 },
  { src: '/a/h264-1920.mp4', type: H264, width: 1920, height: 1080 },
  { src: '/a/h264-1280.mp4', type: H264, width: 1280, height: 720 }
];
const entry = (id: string, extra: Partial<MediaEntry> = {}): MediaEntry => ({ id, category: 'scene', ratio: '16:9', poster: `/media/${id}/poster.jpg`, sources, ...extra });

describe('video source selection', () => {
  it('sends phones the small file and never AV1 they do not need', () => {
    expect(pickSources(sources, 900, () => true).map((s) => s.src)).toEqual(['/a/h264-1280.mp4']);
  });
  it('offers AV1 first on big screens that can decode it, with H.264 as fallback', () => {
    expect(pickSources(sources, 1800, () => true).map((s) => s.src)).toEqual(['/a/av1-1920.mp4', '/a/h264-1920.mp4']);
  });
  it('falls back to H.264 when AV1 is not playable, and to the largest file when none is big enough', () => {
    expect(pickSources(sources, 4000, (t) => t.includes('avc1')).map((s) => s.src)).toEqual(['/a/h264-1920.mp4']);
  });
  it('returns nothing when the browser plays none of them (the poster stays)', () => {
    expect(pickSources(sources, 1000, () => false)).toEqual([]);
  });
});

describe('star field', () => {
  it('is deterministic, so it looks the same on every visit', () => {
    expect(makeParticles(20, 3)).toEqual(makeParticles(20, 3));
    const p = makeParticles(200);
    expect(p.every((q) => q.x >= 0 && q.x <= 1 && q.z >= 0.2 && q.z <= 1)).toBe(true);
    const stars = p.filter((q) => q.star).length;
    expect(stars).toBeGreaterThan(10);
    expect(stars).toBeLessThan(60);
  });
});

describe('time of day for the companion home', () => {
  it.each([[4, 'night'], [5, 'morning'], [10, 'morning'], [11, 'day'], [16, 'day'], [17, 'night'], [23, 'night']])('%i:00 → %s', (h, want) => {
    expect(timeOfDay(h as number)).toBe(want);
  });
});

describe('scene video', () => {
  it('paints the poster immediately and leaves out the video when motion is reduced', () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const { container } = render(<SceneVideo entry={entry('x')} active />);
    expect(container.querySelector('img.scene-poster')?.getAttribute('src')).toBe('/media/x/poster.jpg');
    expect(container.querySelector('video')).toBeNull();
    window.matchMedia = mm;
  });
  it('mounts no video for an inactive scene (only one video decodes at a time)', () => {
    const { container } = render(<SceneVideo entry={entry('y')} active={false} />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });
  it('can prime a handoff without exposing the scene poster', () => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (() => 'probably') as typeof HTMLMediaElement.prototype.canPlayType;
    const { container } = render(<SceneVideo entry={entry('handoff')} active hold hidePoster />);
    expect(container.querySelector('img.scene-poster')).toBeNull();
    expect(container.querySelector('video')?.getAttribute('poster')).toBeNull();
    HTMLMediaElement.prototype.canPlayType = canPlayType;
  });
});

describe('multi-view spin viewer', () => {
  const views = ['/v0.jpg', '/v1.jpg', '/v2.jpg', '/v3.jpg'];
  it('turns with the arrow keys and wraps around', () => {
    render(<SpinViewer views={views} label="衣装" hint="ドラッグで回転" />);
    const s = screen.getByRole('slider', { name: '衣装' });
    expect(s.getAttribute('aria-valuenow')).toBe('1');
    fireEvent.keyDown(s, { key: 'ArrowLeft' });
    expect(s.getAttribute('aria-valuenow')).toBe('4');
    fireEvent.keyDown(s, { key: 'ArrowRight' });
    fireEvent.keyDown(s, { key: 'ArrowRight' });
    expect(s.getAttribute('aria-valuenow')).toBe('2');
    expect(s.querySelector('img.on')?.getAttribute('src')).toBe('/v1.jpg');
  });
  it('turns when dragged', () => {
    render(<SpinViewer views={views} label="小物" hint="" />);
    const s = screen.getByRole('slider', { name: '小物' });
    Object.defineProperty(s, 'clientWidth', { value: 200 });
    fireEvent.pointerDown(s, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(s, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(s, { pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('3');
  });
});

function renderHome() {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true }}>
      <MemoryRouter initialEntries={['/']}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}
const pressed = () => document.querySelector('[role="radiogroup"][aria-label="ご本人を選ぶ"] [role="radio"][aria-checked="true"]')?.getAttribute('aria-label');

describe('home stage', () => {
  it('switches the talent with ←/→; the wheel pages the sections instead', async () => {
    renderHome();
    await screen.findByRole('radiogroup', { name: 'ご本人を選ぶ' });
    expect(pressed()).toBe('唯井まひろ');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(pressed()).toBe('八木奈々');
    await new Promise((r) => setTimeout(r, 950)); // the switch is locked while the depth transition plays
    fireEvent.wheel(document.querySelector('.home-fp')!, { deltaY: -120 });
    expect(pressed()).toBe('八木奈々');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(pressed()).toBe('唯井まひろ');
  });
  it('lays the home out as full-screen sections with a site-wide footer and legal links', async () => {
    renderHome();
    await screen.findByRole('heading', { level: 2, name: '今夜、誰に会いに行く？' });
    expect([...document.querySelectorAll('[data-fp]')].map((e) => e.id)).toEqual(['fp-hero', 'fp-stars', 'fp-how', 'fp-cards', 'fp-news']);
    const legal = screen.getByRole('navigation', { name: '規約とポリシー' });
    expect([...legal.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/legal/terms', '/legal/privacy', '/legal/ai', '/legal/operator', '/legal/rates']) // MemoryRouter; the app's HashRouter prefixes #;
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
  it('ignores arrow keys while the visitor is typing', async () => {
    renderHome();
    await screen.findByRole('radiogroup', { name: 'ご本人を選ぶ' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(pressed()).toBe('唯井まひろ');
    input.remove();
  });
  it('keeps rotating on its own, but holds while the visitor reads the panel', async () => {
    vi.useFakeTimers();
    renderHome();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7100); });
    expect(pressed()).toBe('八木奈々');
    fireEvent.pointerEnter(document.querySelector('.top-panel')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(pressed()).toBe('八木奈々');
    fireEvent.pointerLeave(document.querySelector('.top-panel')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(7100); });
    expect(pressed()).toBe('うんぱい');
  });
  it('uses the generated scene for the current talent and falls back to the tint without one', async () => {
    MEDIA['mahiro-night-16x9'] = entry('mahiro-night-16x9');
    renderHome();
    await screen.findByRole('radiogroup', { name: 'ご本人を選ぶ' });
    const main = document.querySelector('.top')!;
    expect(main.classList.contains('has-scene')).toBe(true);
    expect(main.querySelector('[data-scene="mahiro-night-16x9"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '八木奈々' }));
    expect(document.querySelector('.top')!.classList.contains('has-scene')).toBe(false);
  });
  it('prefers her in her scene and then drops the separate talent frame', async () => {
    MEDIA['mahiro-night-16x9'] = entry('mahiro-night-16x9');
    MEDIA['mahiro-hero-16x9'] = entry('mahiro-hero-16x9', { category: 'character' });
    renderHome();
    await screen.findByRole('radiogroup', { name: 'ご本人を選ぶ' });
    expect(document.querySelector('[data-scene="mahiro-hero-16x9"]')).not.toBeNull();
    expect(document.querySelector('.talent-frame')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '八木奈々' }));
    expect(document.querySelector('.talent-frame')).not.toBeNull();
  });
  it('prefers her HD loop (#24) over the v1 hero, falling back to the other orientation, then the v1 hero', () => {
    MEDIA['mahiro-hero-16x9'] = entry('mahiro-hero-16x9', { category: 'character' });
    MEDIA['mahiro-hero-9x16'] = entry('mahiro-hero-9x16', { category: 'character', ratio: '9:16' });
    expect(sceneFor('mahiro', false)?.id).toBe('mahiro-hero-16x9');
    MEDIA['mahiro-herohd-9x16'] = entry('mahiro-herohd-9x16', { category: 'character', ratio: '9:16' });
    expect(sceneFor('mahiro', true)?.id).toBe('mahiro-herohd-9x16');
    expect(sceneFor('mahiro', false)?.id).toBe('mahiro-hero-16x9');
    MEDIA['mahiro-herohd-16x9'] = entry('mahiro-herohd-16x9', { category: 'character' });
    expect(sceneFor('mahiro', false)?.id).toBe('mahiro-herohd-16x9');
    expect(homeSceneFor('mahiro', 'night', true)?.id).toBe('mahiro-herohd-9x16');
  });
  it('announces the talent to screen readers when it changes', async () => {
    renderHome();
    await screen.findByRole('radiogroup', { name: 'ご本人を選ぶ' });
    fireEvent.click(screen.getByRole('radio', { name: 'うんぱい' }));
    const live = [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent);
    expect(live).toContain('うんぱい');
  });
  it('lets a phone visitor collapse and reopen the serial hint', async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { container } = renderHome();
    const close = await screen.findByRole('button', { name: '閉じる' });
    expect(container.querySelector('.serial-dock.is-open')).not.toBeNull();
    fireEvent.click(close);
    expect(container.querySelector('.serial-dock.is-collapsed')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'シリアルコードを入力' }));
    expect(container.querySelector('.serial-dock.is-open')).not.toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
  });
  it('automatically tucks the phone serial hint away after a quiet moment', async () => {
    vi.useFakeTimers();
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { container } = renderHome();
    expect(container.querySelector('.serial-dock.is-open')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_050); });
    expect(container.querySelector('.serial-dock.is-collapsed')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'シリアルコードを入力' }));
    expect(container.querySelector('.serial-dock.is-open')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_050); });
    expect(container.querySelector('.serial-dock.is-collapsed')).not.toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    vi.useRealTimers();
  });
});
