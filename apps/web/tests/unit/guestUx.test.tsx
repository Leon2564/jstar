/**
 * The guest and public paths after the v1.1.0 UI/UX acceptance (A-findings: H1, H2, M6, M7, M8, M9, M10, L5, L6).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { ApiError } from '../../src/services/http';
import { MEDIA } from '../../src/data/media.gen';
import { compactMediaModule, heroFacesModule } from '../../src/data/mediaCompact';
import { faceBox, heroTarget, placeFace, type Box } from '../../src/components/heroLayout';
import { heroEntry } from '../../src/data/heroMedia';
import { CAST } from '../../src/data/cast';
import { INSTALL_WORDS } from '../../src/components/installHint';

const trialChat = vi.hoisted(() => ({ fail: null as null | ApiError }));
vi.mock('../../src/services/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/api')>();
  return { ...real, trialChat: async (...a: Parameters<typeof real.trialChat>) => { if (trialChat.fail) throw trialChat.fail; return real.trialChat(...a); } };
});

afterEach(() => { cleanup(); trialChat.fail = null; });
beforeAll(() => { Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

let go: (to: string) => void = () => {};
function Nav() { go = useNavigate(); return null; }
function renderAt(path: string, patch: Partial<ReturnType<typeof initialState>> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, ...patch }}>
      <MemoryRouter initialEntries={[path]}><Nav /><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('build-time media catalogue and face map', () => {
  it('the compact catalogue rebuilds exactly the same MEDIA object', async () => {
    const src = readFileSync(join(__dirname, '../../src/data/media.gen.ts'), 'utf8');
    const code = compactMediaModule(src);
    const mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as { MEDIA: typeof MEDIA };
    expect(mod.MEDIA).toEqual(MEDIA);
    expect(code.length).toBeLessThan(src.length / 2);
  });
  it('the home gets her face box for every stage clip it may play', () => {
    const json = readFileSync(join(__dirname, '../../src/data/faces.gen.json'), 'utf8');
    const faces = JSON.parse(heroFacesModule(json).replace(/^export const HERO_FACES=/, '').replace(/;$/, '')) as Record<string, number[]>;
    for (const c of CAST) for (const portrait of [true, false]) {
      const e = heroEntry(c.id, portrait)!;
      expect(faces[e.id], e.id).toHaveLength(4);
      expect(faceBox(e.id, e.ratio)).toEqual(faces[e.id]);
    }
    expect(Object.keys(faces).every((id) => /-(herohd|hero|night)-(9x16|16x9)$/.test(id))).toBe(true);
  });
});

describe('H1: her face in frame at every size', () => {
  const SIZES = [[390, 844], [375, 667], [320, 568], [740, 675], [900, 700], [768, 1024], [1024, 768], [1280, 720], [1440, 900], [1920, 1080]];
  it('her face is on screen, right of the copy column on a desktop and clear of the 序號 tab', () => {
    for (const [W, H] of SIZES) for (const c of CAST) {
      const e = heroEntry(c.id, H >= W)!;
      const fb = faceBox(e.id, e.ratio);
      const dispW = Math.max(W, H * (e.ratio === '16:9' ? 16 / 9 : 9 / 16)) * 1.06;
      const aim = heroTarget(W, H, (fb[2] - fb[0]) * dispW);
      const [l, t, r, b] = placeFace(fb as Box, e.ratio, W, H, aim.tx, aim.ty, 1.06).box;
      const at = `${W}×${H} ${c.id}`;
      expect(l, at).toBeGreaterThanOrEqual(0);
      expect(r, at).toBeLessThanOrEqual(W - 44);
      expect(t, at).toBeGreaterThanOrEqual(0);
      expect(b, at).toBeLessThanOrEqual(H);
      if (W >= 1024) expect(l, at).toBeGreaterThanOrEqual(Math.min(560, W * 0.42) - 1);
    }
  });
});

describe('M6: the serial form follows ?code', () => {
  it('a second code in the address fills the field again', async () => {
    renderAt('/serial?code=999000000011');
    const input = await screen.findByLabelText(/コード/) as HTMLInputElement;
    expect(input.value).toBe('9990-0000-0011');
    act(() => go('/serial?code=999000000029'));
    await waitFor(() => expect(input.value).toBe('9990-0000-0029'));
  });
});

describe('M7 / M8: the trial', () => {
  it('a failed send keeps a failed mark and 「もう一度送る」; a 429 says why', async () => {
    trialChat.fail = new ApiError('rate_limited', 429);
    renderAt('/trial');
    await screen.findByTestId('trial-left');
    fireEvent.change(screen.getByLabelText('メッセージ'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    const mark = await screen.findByTestId('trial-failed');
    expect(mark.textContent).toContain('送信できませんでした');
    expect(document.querySelector('.toast')?.textContent).toContain('1分ほど待って');
    trialChat.fail = null;
    fireEvent.click(within(mark).getByRole('button', { name: 'もう一度送る' }));
    await waitFor(() => expect(screen.queryByTestId('trial-failed')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('trial-left').textContent).toBe('あと2通'));
    expect(screen.getAllByText('hello')).toHaveLength(1);
  });
  it('the end is one rose button, and send is off', async () => {
    renderAt('/trial', { trialLeft: 0 });
    const cta = await screen.findByTestId('trial-done');
    expect(cta.className).toContain('btn-rose');
    expect(cta.textContent).toBe('無料で登録して、続けて話す');
    expect(cta.getAttribute('href')).toBe('/signup?next=/me/home');
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('M9: the gallery as a guest', () => {
  it('a localised heading; a locked card opens its preview with the free sign-up', async () => {
    renderAt('/gallery');
    expect(await screen.findByRole('heading', { level: 1, name: /カード図鑑/ })).toBeTruthy();
    const tiles = screen.getAllByRole('button', { name: /「未入手」/ });
    expect(tiles.length).toBe(150);
    fireEvent.click(tiles[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: '無料で登録して集める' }).getAttribute('href')).toBe('/signup?next=/gallery');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('M10 / L5 / L6: legal pages', () => {
  it('an unknown document is the 404 page, with the site header', async () => {
    renderAt('/legal/bogus');
    expect(await screen.findByRole('heading', { level: 1, name: 'ページが見つかりません' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'JSTAR' })).toBeTruthy();
  });
  it('each document has its h1; in Korean the English text comes under a Korean note', async () => {
    renderAt('/legal/terms', { lang: 'ko' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' })).toBeTruthy();
    expect(screen.getByTestId('legal-ko-note').textContent).toMatch(/영어 원문/);
  });
});

describe('L15: the install sheet speaks every language', () => {
  it('four languages, every line filled, no kana outside Japanese', () => {
    expect(Object.keys(INSTALL_WORDS).sort()).toEqual(['en', 'ja', 'ko', 'zh-Hant']);
    for (const [lang, w] of Object.entries(INSTALL_WORDS)) {
      for (const v of Object.values(w)) expect(v.trim(), lang).not.toBe('');
      if (lang !== 'ja') expect(Object.values(w).join(''), lang).not.toMatch(/[ぁ-ゖァ-ヺ]/);
    }
  });
});
