import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoreProvider } from '../../src/lib/store';
import { initialState } from '../../src/lib/state';
import { Countdown } from '../../src/scene/ui';

// N-54: えいみ's goodnight showed a bare 「30」 with a bar: the chip says what it counts, on screen and to a reader.
describe('the countdown chip (N-54)', () => {
  it('shows what it counts, not a bare number', () => {
    render(<StoreProvider initial={{ ...initialState(), ageOk: true }}><Countdown endsAt={Date.now() + 30_000} total={30_000} label="scene.countdown" /></StoreProvider>);
    const chip = screen.getByTestId('scene-countdown');
    expect(chip.textContent).toBe('返事まで残り 30');
    expect(chip.getAttribute('aria-label')).toBe('返事まで残り 30');
  });
});
