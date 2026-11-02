import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';

// N-45: the memories tab never flashes the stored (Japanese) titles while the translated ones load.
const gate = vi.hoisted(() => { let open: () => void = () => undefined; const ready = new Promise<void>((r) => { open = r; }); return { ready, open: () => open() }; });
vi.mock('../../src/scene/memoryTitle', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/scene/memoryTitle')>();
  await gate.ready;
  return real;
});

afterEach(cleanup);
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

describe('memory titles on first paint (N-45)', () => {
  it('shows a quiet placeholder until the titles are here, then the title in his language — never Japanese in between', async () => {
    await ensureLang('en');
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'en', user: { via: 'email', nickname: 'k' },
        memories: [{ id: 'm1', star: 'mahiro', title: 'おそろいのマグカップ', date: '2026-09-28', kind: 'scene', sceneId: 'welcome-home' }] }}>
        <MemoryRouter initialEntries={['/me/cards?tab=memory']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    expect(await screen.findByTestId('memory-title-wait')).toBeTruthy();
    expect(document.body.textContent).not.toContain('おそろいのマグカップ');
    await act(async () => { gate.open(); });
    expect(await screen.findByRole('img', { name: /A Matching Pair of Mugs/ })).toBeTruthy();
    expect(screen.queryByTestId('memory-title-wait')).toBeNull();
  });
});
