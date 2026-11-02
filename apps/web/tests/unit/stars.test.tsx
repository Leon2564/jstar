import { act, cleanup, render } from '@testing-library/react';
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
});
