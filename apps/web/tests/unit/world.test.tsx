import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WORLD } from '@jstar/shared/world';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { monthDayLabel, profileOf } from '../../src/data/profile';

// Talent facts are shown only once confirmed (#48). The five are confirmed (owner, 2026-09-28); the gate is tested by
// unconfirming them, and the flags are put back after each test.
const original = structuredClone(WORLD);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const id of Object.keys(WORLD) as (keyof typeof WORLD)[]) {
    WORLD[id].birthday.confirmed = original[id].birthday.confirmed;
    WORLD[id].hometown.confirmed = original[id].hometown.confirmed;
  }
});
beforeAll(() => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

function renderAt(path: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, ...patch }}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

const UNCONFIRMED_TEXT = ['誕生日', '出身', '3月4日', '東京', '待定', '未定', '準備中'];

const unconfirm = (fields: ('birthday' | 'hometown')[]) => { for (const f of fields) WORLD.mahiro[f].confirmed = false; };

describe('talent profile gate', () => {
  it('shows her confirmed birthday and hometown on the STARS page', async () => {
    expect(profileOf('mahiro')).toMatchObject({ birthday: '03-04', from: { ja: '東京', ko: '도쿄' } });
    renderAt('/stars?star=mahiro');
    await screen.findByRole('heading', { name: '唯井まひろ' });
    const profile = await screen.findByLabelText('プロフィール');
    for (const s of ['誕生日', '3月4日', '出身', '東京']) expect(profile.textContent).toContain(s);
  });

  it('shows nothing about her while nothing is confirmed, and no placeholder', async () => {
    unconfirm(['birthday', 'hometown']);
    expect(profileOf('mahiro')).toEqual({ birthday: undefined, from: undefined });
    renderAt('/stars?star=mahiro');
    await screen.findByRole('heading', { name: '唯井まひろ' });
    expect(document.querySelector('.stars-profile')).toBeNull();
    for (const s of UNCONFIRMED_TEXT) expect(document.querySelector('.stars-info')!.textContent, s).not.toContain(s);
  });

  it('shows exactly the confirmed fields on the STARS page', async () => {
    unconfirm(['hometown']);
    renderAt('/stars?star=mahiro');
    await screen.findByRole('heading', { name: '唯井まひろ' });
    const profile = await screen.findByLabelText('プロフィール');
    expect(profile.textContent).toContain('誕生日');
    expect(profile.textContent).toContain('3月4日');
    expect(profile.textContent).not.toContain('出身'); // her hometown is still unconfirmed
    cleanup();
    WORLD.mahiro.hometown.confirmed = true;
    renderAt('/stars?star=mahiro');
    const both = await screen.findByLabelText('プロフィール');
    expect(both.textContent).toContain('出身');
    expect(both.textContent).toContain('東京');
  });

  it('never shows her unconfirmed facts on the companion home', async () => {
    unconfirm(['birthday', 'hometown']);
    renderAt('/me/home', { user: { via: 'email', nickname: 'kenta' }, star: 'mahiro' });
    await screen.findByTestId('greeting');
    for (const s of ['誕生日', '出身', '3月4日', '待定']) expect(document.body.textContent, s).not.toContain(s);
  });

  it('formats the birthday per language, without a year', () => {
    expect(monthDayLabel('03-04', 'ja')).toBe('3月4日');
    expect(monthDayLabel('03-04', 'zh-Hant')).toBe('3月4日');
    expect(monthDayLabel('03-04', 'en')).toBe('March 4');
    expect(monthDayLabel('12-31', 'en')).toBe('December 31');
  });
});
