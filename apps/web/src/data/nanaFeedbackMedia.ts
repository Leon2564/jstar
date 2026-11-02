import type { MediaEntry } from './media.gen';

/** Final 4K Yagi entrance, idle, and reaction set, all sharing one 16:9 composition. */
const ids = [
  'nana-enter-16x9',
  'nana-idle-16x9',
  'nana-react-a-16x9',
  'nana-react-b-16x9',
  'nana-react-c-16x9',
  'nana-react-d-16x9',
  'nana-react-e-16x9',
  'nana-react-f-16x9',
  'nana-react-g-16x9',
  'nana-react-h-16x9',
  'nana-react-i-16x9',
  'nana-react-j-16x9'
] as const;

export const NANA_FEEDBACK_MEDIA = Object.fromEntries(ids.map((id) => [id, {
  id,
  category: 'character',
  star: 'nana',
  ratio: '16:9',
  poster: `/media/nana-feedback/posters-4k/${id}.jpg`,
  sources: [{
    src: `/media/nana-feedback/original-4k/${id}.mp4`,
    type: 'video/mp4; codecs="avc1"',
    width: 3840,
    height: 2160
  }]
}])) as Record<string, MediaEntry>;
