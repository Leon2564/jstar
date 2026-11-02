import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CARDS } from '../../src/data/cards';
import { CardShowcase } from '../../src/components/cardShowcase';
import { StoreProvider } from '../../src/lib/store';
import { initialState } from '../../src/lib/state';

afterEach(cleanup);

function show(onClose = vi.fn(), cardId?: string) {
  const card = CARDS.find((item) => item.id === cardId) ?? CARDS.find((item) => item.rarity === 'UR') ?? CARDS[0];
  const view = render(
    <StoreProvider initial={{ ...initialState(), lang: 'zh-Hant' }}>
      <CardShowcase card={card} onClose={onClose} />
    </StoreProvider>
  );
  return { ...view, container: view.baseElement, card, onClose };
}

function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
}

describe('card showcase', () => {
  it('keeps a dragged viewing angle until the reset control is used', () => {
    const { container, card } = show();
    const physical = container.querySelector<HTMLElement>('.card-showcase-physical')!;
    const inner = container.querySelector<HTMLElement>('.card-showcase-inner')!;
    expect(container.querySelector('.card-showcase')?.classList.contains(`tier-${card.rarity}`)).toBe(true);
    expect(container.querySelector('.card-showcase-back img')?.getAttribute('src')).toBe('/cards/jstar-genesis-back.png');
    pointer(physical, 'pointerdown', 100, 100);
    pointer(physical, 'pointermove', 320, 80);
    pointer(physical, 'pointerup', 320, 80);
    expect(inner.style.getPropertyValue('--showcase-ry')).not.toBe('0deg');
    fireEvent.click(container.querySelector('.card-showcase-reset')!);
    expect(inner.style.getPropertyValue('--showcase-rx')).toBe('0deg');
    expect(inner.style.getPropertyValue('--showcase-ry')).toBe('0deg');
  });

  it('only closes from the return control or Escape, not the empty backdrop', () => {
    const onClose = vi.fn();
    const { container } = show(onClose);
    fireEvent.click(container.querySelector('.card-showcase')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.card-showcase-return')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('uses the card PV in the Eimi bonus-card showcase', () => {
    const { container } = show(vi.fn(), 's1-eimi-29');
    const video = container.querySelector<HTMLVideoElement>('.card-showcase-motion')!;
    expect(video.getAttribute('src')).toBe('/cards/s1-eimi-29/motion.mp4');
    expect(video.autoplay).toBe(false);
    expect(video.loop).toBe(false);
  });
});
