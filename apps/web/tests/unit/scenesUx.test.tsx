import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItemT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang } from '../../src/i18n';
import * as api from '../../src/services/api';
import { pageEnds, quoteLine } from '../../src/lib/lines';
import { Choices, Subtitle } from '../../src/scene/ui';
import { zhWords } from '../../src/scene/phrases';

/** The D-scenes acceptance of 47b0fcb (v1.1.0): scenes, life events and the cross-cutting places. */
beforeAll(async () => {
  (window as unknown as { __E2E__: boolean }).__E2E__ = true;
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  await ensureLang('zh-Hant');
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('her words on screen (M4, M5, L1, L3)', () => {
  it('M5: quotes per language — 「」 in ja / zh-Hant, “ ” in en / ko', () => {
    expect(quoteLine('おかえり。', 'ja')).toBe('「おかえり。」');
    expect(quoteLine('歡迎回來。', 'zh-Hant')).toBe('「歡迎回來。」');
    expect(quoteLine('Welcome home.', 'en')).toBe('“Welcome home.”');
    expect(quoteLine('어서 와.', 'ko')).toBe('“어서 와.”');
    // A line written whole in quotes keeps one pair, in this language's marks.
    expect(quoteLine('「ここまで読んでくれてありがとう。」', 'ja')).toBe('「ここまで読んでくれてありがとう。」');
    expect(quoteLine('「Thank you for reading this far.」', 'en')).toBe('“Thank you for reading this far.”');
  });

  it('L1: a quote inside her words takes the inner pair, and the line closes (read-aloud)', () => {
    expect(quoteLine('「……そうして彼女は、朝の窓をそっと開けた。」……おしまい。ふふ。', 'ja')).toBe('「『……そうして彼女は、朝の窓をそっと開けた。』……おしまい。ふふ。」');
    expect(quoteLine('「……於是她輕輕打開了早晨的窗。」……完。', 'zh-Hant')).toBe('「『……於是她輕輕打開了早晨的窗。』……完。」');
    expect(quoteLine('She said 「hello」 to me.', 'en')).toBe('“She said ‘hello’ to me.”');
  });

  it('L3: a page never cuts an English word in two', () => {
    const text = 'Well then. Is there anything you would like to do with me tonight before the greenhouse closes?';
    const ends = pageEnds(text, (s) => s.length <= 40);
    for (const e of ends.slice(0, -1)) expect(text[e - 1] === ' ' || /[.?!]/.test(text[e - 2] ?? '') || text[e] === ' ').toBe(true);
  });

  it('L3: Chinese breaks between words, a closing mark staying with its word', () => {
    const w = zhWords('要不要再努力一下？我姑且聽聽看。');
    expect(w.join('')).toBe('要不要再努力一下？我姑且聽聽看。');
    expect(w.some((x) => x.startsWith('？') || x.startsWith('。'))).toBe(false);
  });

  it('M4: one page reads as one live line; the visible text carries its quotes', () => {
    render(<Subtitle text="Welcome home." speaking visible who="Mahiro" lang="en" />);
    expect(screen.getByTestId('scene-sub').querySelector('p')!.textContent).toBe('Mahiro: “Welcome home.”');
  });
});

describe('his choices (L7)', () => {
  it('the arrow keys move between them', () => {
    render(<MemoryRouter><Choices label="choices" options={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]} onPick={() => undefined} /></MemoryRouter>);
    const [a, b, c] = [...screen.getByTestId('scene-choices').querySelectorAll('button')];
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(c);
  });
});

function renderAt(patch: Partial<AppState> = {}, path = '/me/home') {
  return render(
    <StoreProvider initial={{ ...initialState(), ageOk: true, lang: 'zh-Hant', user: { via: 'email', nickname: 'kenta' }, star: 'mahiro', ...patch } as AppState}>
      <MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>
    </StoreProvider>
  );
}

describe('her wake-up call belongs to her room (H1)', { timeout: 20_000 }, () => {
  it('in another woman\'s room it is a small 「奈奈來電」 line that takes him to hers — never her call over this face', async () => {
    const at = new Date(); at.setHours(8, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    const wake: InboxItemT = { id: 'w1', star: 'nana', kind: 'wakeup', payload: { text: '起床囉！' }, deliveredAt: new Date(at.getTime() - 60_000).toISOString(), readAt: null, createdAt: at.toISOString() };
    vi.spyOn(api, 'inbox').mockResolvedValue({ items: [wake], unread: 1 });
    renderAt({ star: 'nana' });
    await screen.findByTestId('call-incoming-answer', {}, { timeout: 8000 });
    // He goes to アリス's room while 奈奈 still rings.
    fireEvent.click(await screen.findByTestId('room-index-open'));
    const alice = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /愛麗絲/.test(b.textContent ?? ''));
    expect(alice).toBeTruthy();
    fireEvent.click(alice!);
    await waitFor(() => expect(screen.getByTestId('room').dataset.star).toBe('alice'), { timeout: 8000 });
    expect(screen.queryByTestId('call-incoming')).toBeNull();
    const line = await screen.findByTestId('call-elsewhere');
    expect(line.textContent).toContain('奈奈來電');
    fireEvent.click(line);
    await waitFor(() => expect(screen.getByTestId('room').dataset.star).toBe('nana'), { timeout: 8000 });
    expect(await screen.findByTestId('call-incoming')).toBeTruthy();
  });
});
