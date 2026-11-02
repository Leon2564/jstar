import type { MediaEntry } from './media.gen';

/** Owner-supplied final entrance clip. One landscape master is cover-cropped for both desktop and phone. */
const entrance = (id: 'alice-enter-16x9' | 'alice-enter-9x16'): MediaEntry => ({
  id,
  category: 'character',
  star: 'alice',
  ratio: '16:9',
  poster: '',
  sources: [{
    src: '/media/alice-entrance/alice-enter.mp4',
    type: 'video/mp4; codecs="avc1"',
    width: 3840,
    height: 2160
  }]
});

export const ALICE_ENTRANCE_MEDIA: Record<string, MediaEntry> = {
  'alice-enter-16x9': entrance('alice-enter-16x9'),
  'alice-enter-9x16': entrance('alice-enter-9x16')
};
