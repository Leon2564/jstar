import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/lib/store';
import { initialState } from '../../src/lib/state';
import { LiveLobby, LiveRoom } from '../../src/pages/live';

function view(path = '/live') {
  return render(
    <StoreProvider initial={{ ...initialState(), lang: 'ja' }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/live" element={<LiveLobby />} />
          <Route path="/live/:star" element={<LiveRoom />} />
        </Routes>
      </MemoryRouter>
    </StoreProvider>
  );
}

describe('public 1-to-many live preview', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers all five talents and enters the selected room', () => {
    view();
    const rooms = screen.getAllByRole('link', { name: /公開ライブを見る/ });
    expect(rooms).toHaveLength(5);
    const ids = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
    rooms.forEach((room, index) => {
      const desktopExt = ids[index] === 'nana' ? 'webp' : 'jpg';
      expect(room.querySelector('source')?.getAttribute('srcset')).toBe(`/media/live/${ids[index]}-public-live-16x9.${desktopExt}`);
      expect(room.querySelector('img')?.getAttribute('src')).toBe(`/media/live/${ids[index]}-public-live-9x16.jpg`);
    });
    const eimi = screen.getByRole('link', { name: '深田えいみの公開ライブを見る' });
    fireEvent.click(eimi);
    expect(screen.getByRole('main').className).toContain('live-room-page');
    expect(screen.getByText('深田えいみ')).toBeTruthy();
    expect(screen.getByLabelText('ライブインタラクション')).toBeTruthy();
    expect(screen.getByLabelText('深田えいみのデジタルライブ')).toBeTruthy();
    expect(screen.getByPlaceholderText('コメントを入力…')).toBeTruthy();
  });

  it('uses Nana responsive covers and a still loading stage while the RTC stream connects', () => {
    view('/live/nana');
    const stage = screen.getByLabelText('八木奈々のデジタルライブ');
    expect(stage.querySelector('picture source')?.getAttribute('srcset')).toBe('/media/live/nana-public-live-16x9.webp');
    expect(stage.querySelector('img')?.getAttribute('src')).toBe('/media/live/nana-public-live-9x16.jpg');
    expect(stage.className).toContain('is-connecting');
    expect(stage.querySelector('video')).toBeNull();
  });

  it('accepts a typed comment while the avatar connection is still starting', () => {
    view('/live/alice');
    const input = screen.getByPlaceholderText('コメントを入力…');
    fireEvent.change(input, { target: { value: 'こんばんは' } });
    const send = screen.getByRole('button', { name: '送信' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    expect(screen.getByText('こんばんは')).toBeTruthy();
  });

  it('keeps gifts selectable in a public room without an account session', async () => {
    view('/live/nana');
    fireEvent.click(screen.getByRole('button', { name: /きらめき 10/ }));
    const gift = await screen.findByTestId('gift-bouquet');
    expect((gift as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(gift);
    expect(gift.getAttribute('aria-pressed')).toBe('true');
  });
});
