import type { StarId } from '../data/cast';
import type { LiveLayoutT } from '../services/http';

export type LiveCover = { desktop: string; mobile: string };

/** The same framing sources are used while public and private Vidu rooms establish their RTC stream. */
export const LIVE_COVERS: Record<StarId, LiveCover> = {
  mahiro: { desktop: '/media/live/mahiro-public-live-16x9.jpg', mobile: '/media/live/mahiro-public-live-9x16.jpg' },
  nana: { desktop: '/media/live/nana-public-live-16x9.webp', mobile: '/media/live/nana-public-live-9x16.jpg' },
  unpai: { desktop: '/media/live/unpai-public-live-16x9.jpg', mobile: '/media/live/unpai-public-live-9x16.jpg' },
  alice: { desktop: '/media/live/alice-public-live-16x9.jpg', mobile: '/media/live/alice-public-live-9x16.jpg' },
  eimi: { desktop: '/media/live/eimi-public-live-16x9.jpg', mobile: '/media/live/eimi-public-live-9x16.jpg' }
};

export function liveLayoutForViewport(): LiveLayoutT {
  const desktop = window.matchMedia?.('(min-width: 1024px)').matches ?? window.innerWidth >= 1024;
  return desktop ? 'desktop' : 'mobile';
}

export function ResponsiveLiveCover({ cover, className, eager = false }: { cover: LiveCover; className: string; eager?: boolean }) {
  return (
    <picture>
      <source media="(min-width: 1024px)" srcSet={cover.desktop} />
      <img className={className} src={cover.mobile} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" />
    </picture>
  );
}
