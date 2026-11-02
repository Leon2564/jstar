import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SceneVideo } from '../../src/components/stage';
import { MEDIA } from '../../src/data/media.gen';

// N-52: a cold open paints her small poster first and swaps to the full one once it has loaded.
describe('her first poster (N-52)', () => {
  it('the small poster first, softly; the full one takes over when it has loaded', () => {
    const entry = MEDIA['mahiro-herohd-9x16'];
    expect(entry.posters?.length).toBeGreaterThan(1);
    const { container } = render(<SceneVideo entry={entry} active={false} />);
    const lqip = container.querySelector('img[data-lqip]') as HTMLImageElement;
    const full = [...container.querySelectorAll('img')].find((i) => !i.hasAttribute('data-lqip'))!;
    expect(lqip.getAttribute('src')).toContain('poster-sm');
    expect(full.style.opacity).toBe('0');
    fireEvent.load(full);
    expect(container.querySelector('img[data-lqip]')).toBeNull();
    expect(full.style.opacity).toBe('');
  });
});

describe('her first poster in a scene (N-52 follow-up)', () => {
  it('the scene stage paints her small poster first and swaps to the full one once it has loaded', async () => {
    const { ClipStage } = await import('../../src/scene/stage');
    const entry = MEDIA['mahiro-herohd-9x16'];
    const handle = { current: null };
    const { container } = render(<ClipStage layers={[entry]} active={entry.id} loops={{}} handle={handle} />);
    const small = container.querySelector('img[data-lqip]') as HTMLImageElement;
    const full = [...container.querySelectorAll('img.scn-poster')].find((i) => !i.hasAttribute('data-lqip')) as HTMLImageElement;
    expect(small.getAttribute('src')).toContain('poster-sm');
    expect(full.style.opacity).toBe('0');
    fireEvent.load(full);
    expect(full.style.opacity).toBe('');
    expect(small.style.opacity).toBe('0');
  });
});
