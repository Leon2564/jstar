import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Phrased, jaPhrases } from '../../src/scene/phrases';

// N-22: Japanese scene titles break between phrases, never inside a word.
describe('Japanese titles by phrase (N-22)', () => {
  it('splits after particles and marks, and keeps words whole', () => {
    expect(jaPhrases('おかえりと、罰ゲーム')).toEqual(['おかえりと、', '罰ゲーム']);
    expect(jaPhrases('あなただけの配信')).toEqual(['あなただけの', '配信']);
    expect(jaPhrases('夜の温室で、ピアノを')).toEqual(['夜の', '温室で、', 'ピアノを']);
    expect(jaPhrases('読み聞かせと、本気のほめ言葉')).toEqual(['読み聞かせと、', '本気の', 'ほめ言葉']);
    for (const t of ['おかえりと、罰ゲーム', 'あなただけの配信', '夜の温室で、ピアノを']) expect(jaPhrases(t).join('')).toBe(t);
  });

  it('puts a break opportunity only between phrases, and leaves other languages alone', () => {
    const { container, rerender } = render(<span><Phrased text="おかえりと、罰ゲーム" lang="ja" /></span>);
    expect(container.innerHTML).toBe('<span>おかえりと、<wbr>罰ゲーム</span>');
    rerender(<span><Phrased text="Welcome home, and a forfeit" lang="en" /></span>);
    expect(container.querySelectorAll('wbr')).toHaveLength(0);
  });
});
