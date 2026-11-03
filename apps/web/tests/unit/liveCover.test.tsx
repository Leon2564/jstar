import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_COVERS, ResponsiveLiveCover, liveLayoutForViewport } from '../../src/components/liveCover';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared Vidu loading cover', () => {
  it('uses the desktop 16:9 source and mobile 9:16 fallback for every star', () => {
    for (const [star, cover] of Object.entries(LIVE_COVERS)) {
      const { container, unmount } = render(<ResponsiveLiveCover cover={cover} className="cover" eager />);
      expect(container.querySelector('source')?.getAttribute('media')).toBe('(min-width: 1024px)');
      expect(container.querySelector('source')?.getAttribute('srcset')).toContain(`${star}-public-live-16x9`);
      expect(container.querySelector('img')?.getAttribute('src')).toContain(`${star}-public-live-9x16`);
      unmount();
    }
  });

  it('selects the same responsive Vidu layout as the cover breakpoint', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    expect(liveLayoutForViewport()).toBe('desktop');
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    expect(liveLayoutForViewport()).toBe('mobile');
  });
});
