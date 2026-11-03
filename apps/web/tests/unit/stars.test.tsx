import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../src/App';
import { CAST } from '../../src/data/cast';
import { ensureLang, type Lang } from '../../src/i18n';
import { initialState } from '../../src/lib/state';
import { StoreProvider } from '../../src/lib/store';

afterEach(cleanup);
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

describe('JSTARS page (N-14)', () => {
  it.each(['ja', 'zh-Hant', 'en', 'ko'] as Lang[])('the romaji slot shows her romanised name in %s', async (lang) => {
    await act(async () => { await ensureLang(lang); });
    const { findByText } = render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, lang }}>
        <MemoryRouter initialEntries={['/stars?star=mahiro']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    const mahiro = CAST.find((c) => c.id === 'mahiro')!;
    const slot = await findByText((_, el) => !!el?.classList.contains('stars-romaji'));
    expect(slot.textContent).toBe(`01 — ${mahiro.romaji}`);
  });

  it('centres the product on video calls, text chat, unlockable scenes and three public moments', async () => {
    await act(async () => { await ensureLang('zh-Hant'); });
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant' }}>
        <MemoryRouter initialEntries={['/stars?star=unpai']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    expect((await screen.findByRole('link', { name: /視訊通話/ })).getAttribute('href')).toBe('/trial');
    expect(screen.getByRole('link', { name: /文字聊天/ }).getAttribute('href')).toBe('/trial?mode=text');
    expect(screen.getByRole('heading', { name: '視訊對話場景' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '公開動態' })).toBeTruthy();
    expect(document.querySelectorAll('.stars-moment-list article')).toHaveLength(3);
  });
});
