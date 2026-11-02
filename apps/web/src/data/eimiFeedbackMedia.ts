import type { MediaEntry } from './media.gen';

/**
 * Owner-supplied final feedback clips. The 4K masters remain beside these files;
 * the site serves high-quality 1080p derivatives so a dissolve can decode two
 * layers smoothly on desktop and phone without changing the approved framing.
 */
const POSTER = '/media/eimi-feedback/poster.png';
const ENTER_POSTER = '/media/eimi-feedback/enter-poster.png';
const ids = [
  'eimi-idle-16x9',
  'eimi-react-a-16x9',
  'eimi-react-b-16x9',
  'eimi-react-c-16x9',
  'eimi-react-d-16x9',
  'eimi-react-e-16x9',
  'eimi-react-f-16x9',
  'eimi-react-g-16x9',
  'eimi-react-h-16x9',
  'eimi-react-i-16x9',
  'eimi-react-j-16x9'
] as const;

const feedback = Object.fromEntries(ids.map((id) => [id, {
  id,
  category: 'character',
  star: 'eimi',
  ratio: '16:9',
  poster: POSTER,
  sources: [{
    src: `/media/eimi-feedback/web-1080/${id}.mp4`,
    type: 'video/mp4; codecs="avc1"',
    width: 1920,
    height: 1080
  }]
}])) as Record<string, MediaEntry>;

export const EIMI_FEEDBACK_MEDIA: Record<string, MediaEntry> = {
  ...feedback,
  'eimi-enter-16x9': {
    id: 'eimi-enter-16x9',
    category: 'character',
    star: 'eimi',
    ratio: '16:9',
    poster: ENTER_POSTER,
    sources: [{
      src: '/media/eimi-feedback/web-1080/eimi-enter-16x9.mp4',
      type: 'video/mp4; codecs="avc1"',
      width: 1920,
      height: 1080
    }]
  }
};
