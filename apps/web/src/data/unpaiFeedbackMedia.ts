import type { MediaEntry } from './media.gen';

/** Owner-supplied final 4K Unpai entrance, idle, and interaction clips. */
const ids = [
  'unpai-enter-16x9',
  'unpai-idle-16x9',
  'unpai-react-a-16x9',
  'unpai-react-b-16x9',
  'unpai-react-c-16x9',
  'unpai-react-d-16x9',
  'unpai-react-e-16x9',
  'unpai-react-f-16x9',
  'unpai-react-g-16x9',
  'unpai-react-h-16x9',
  'unpai-react-i-16x9',
  'unpai-react-j-16x9'
] as const;

export const UNPAI_FEEDBACK_MEDIA = Object.fromEntries(ids.map((id) => [id, {
  id,
  category: 'character',
  star: 'unpai',
  ratio: '16:9',
  poster: `/media/unpai-feedback/posters-4k/${id}.jpg`,
  sources: [{
    src: `/media/unpai-feedback/original-4k/${id}.mp4`,
    type: 'video/mp4; codecs="avc1"',
    width: 3840,
    height: 2160
  }]
}])) as Record<string, MediaEntry>;
