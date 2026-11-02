import type { MediaEntry } from './media.gen';

/** Owner-supplied Alice idle and reaction clips, prepared for smooth 1080p web playback. */
const ids = [
  'alice-idle-16x9',
  'alice-react-a-16x9',
  'alice-react-b-16x9',
  'alice-react-c-16x9',
  'alice-react-d-16x9',
  'alice-react-e-16x9',
  'alice-react-f-16x9',
  'alice-react-g-16x9',
  'alice-react-h-16x9',
  'alice-react-i-16x9',
  'alice-react-j-16x9'
] as const;

export const ALICE_FEEDBACK_MEDIA = Object.fromEntries(ids.map((id) => [id, {
  id,
  category: 'character',
  star: 'alice',
  ratio: '16:9',
  poster: `/media/alice-feedback/posters/${id}.jpg`,
  sources: [{
    src: `/media/alice-feedback/web-1080/${id}.mp4`,
    type: 'video/mp4; codecs="avc1"',
    width: 1920,
    height: 1080
  }]
}])) as Record<string, MediaEntry>;
