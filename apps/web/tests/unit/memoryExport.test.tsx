import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MemoryExport } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import * as api from '../../src/services/api';

// Prototype mode (no VITE_API_BASE), like the e2e suite; the server's side is apps/api/tests/memoryAssets.test.ts.
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** 2026-11-02 at 12:00 JST. */
const NOON = Date.UTC(2026, 10, 2, 3, 0);

function renderAt(route: string, patch: Partial<AppState> = {}) {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, ...patch }}>
      <MemoryRouter initialEntries={[route]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

/** Captures what is handed to the browser's download. */
function downloads() {
  const saved: { blob: Blob; name: string }[] = [];
  let last: Blob | null = null;
  // jsdom has no object URLs.
  Object.assign(URL, { createObjectURL: (b: Blob) => { last = b; return 'blob:export'; }, revokeObjectURL: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ blob: last!, name: this.download }); });
  return saved;
}

describe('思い出: exporting his memories (#51)', () => {
  it('saves them as one JSON file named for the day, and says so', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    const saved = downloads();
    renderAt('/me/cards?tab=memory', { memories: [{ id: 'mem1', star: 'nana', title: '雨の日の話', date: '2026-11-01' }] });
    // The cards page is a lazy route: give it time on a loaded runner.
    expect(await screen.findByText(/声のリンクは24時間有効です/, {}, { timeout: 8000 })).toBeTruthy();
    fireEvent.click(await screen.findByTestId('memory-export'));
    await screen.findByText('書き出しました。');
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('jstar-memories-2026-11-02.json');
    // jsdom's Blob has no text().
    const text = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsText(saved[0].blob); });
    const file = MemoryExport.parse(JSON.parse(text));
    expect(file.memories).toEqual([expect.objectContaining({ id: 'mem1', star: 'nana', title: '雨の日の話', kind: 'chat' })]);
    expect(file.account).toMatchObject({ nickname: 'kenta' });
  });

  it('once a day: the second time it says to come back tomorrow', async () => {
    const saved = downloads();
    vi.spyOn(api, 'exportMemories').mockRejectedValue(new api.ApiError('export_limit', 429));
    renderAt('/me/cards?tab=memory', { memories: [{ id: 'mem1', star: 'nana', title: '雨の日の話', date: '2026-11-01' }] });
    fireEvent.click(await screen.findByTestId('memory-export', {}, { timeout: 8000 }));
    await screen.findByText('書き出しは1日1回です。また明日どうぞ。');
    expect(saved).toHaveLength(0);
    await waitFor(() => expect((screen.getByTestId('memory-export') as HTMLButtonElement).disabled).toBe(false));
  });
});
