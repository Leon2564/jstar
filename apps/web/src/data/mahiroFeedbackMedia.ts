import type { MediaEntry } from './media.gen';

/** Final owner-supplied Yui Mahiro entrance, idle, and reaction set in its original 4K composition. */
const ids = [
  'mahiro-enter-16x9',
  'mahiro-idle-16x9',
  'mahiro-react-a-16x9',
  'mahiro-react-b-16x9',
  'mahiro-react-c-16x9',
  'mahiro-react-d-16x9',
  'mahiro-react-e-16x9',
  'mahiro-react-f-16x9',
  'mahiro-react-g-16x9',
  'mahiro-react-h-16x9',
  'mahiro-react-i-16x9',
  'mahiro-react-j-16x9'
] as const;

export const MAHIRO_FEEDBACK_MEDIA = Object.fromEntries(ids.map((id) => [id, {
  id,
  category: 'character',
  star: 'mahiro',
  ratio: '16:9',
  poster: id === 'mahiro-idle-16x9'
    ? '/media/mahiro-feedback/idle-poster.jpg'
    : '/media/mahiro-feedback/poster.jpg',
  sources: [{
    src: `/media/mahiro-feedback/original-4k/${id}.mp4`,
    type: 'video/mp4; codecs="avc1"',
    width: 3840,
    height: 2160
  }]
}])) as Record<string, MediaEntry>;
