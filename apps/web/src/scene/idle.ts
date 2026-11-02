import { useEffect, useRef, useState } from 'react';
import { SCENE_RULES } from '@jstar/shared/rules';

export type IdlePhase = 'active' | 'loop' | 'prompt';

/**
 * Test hook: e2e runs scale every scene timer (idle and countdowns) so half an hour of waiting takes seconds.
 * Only read when the page runs under the e2e flag.
 */
export function timeScale(): number {
  const w = window as unknown as { __E2E__?: boolean; __SCENE_TIME_SCALE__?: number };
  return w.__E2E__ && typeof w.__SCENE_TIME_SCALE__ === 'number' && w.__SCENE_TIME_SCALE__ > 0 ? w.__SCENE_TIME_SCALE__ : 1;
}

/**
 * When he stops answering (docs/requirements.md §13.1): after 30 s the stage returns to her idle loop, after 60 s she
 * asks whether he is still there, after 5 minutes the run ends — no penalty. Any touch, key or typing starts over.
 * Runs only while `enabled` (she is waiting for him), so her own lines never count as his silence.
 */
export function useIdle(enabled: boolean, onEnd: () => void): [IdlePhase, () => void] {
  const [phase, setPhase] = useState<IdlePhase>('active');
  const [epoch, setEpoch] = useState(0);
  const end = useRef(onEnd);
  end.current = onEnd;
  const wake = () => { setPhase('active'); setEpoch((e) => e + 1); };
  useEffect(() => {
    if (!enabled) { setPhase('active'); return; }
    const k = timeScale();
    const timers = [
      setTimeout(() => setPhase('loop'), SCENE_RULES.idleLoopMs * k),
      setTimeout(() => setPhase('prompt'), SCENE_RULES.idlePromptMs * k),
      setTimeout(() => end.current(), SCENE_RULES.idleEndMs * k)
    ];
    const poke = () => wake();
    const events = ['pointerdown', 'keydown', 'input'] as const;
    events.forEach((e) => window.addEventListener(e, poke, { passive: true }));
    return () => { timers.forEach(clearTimeout); events.forEach((e) => window.removeEventListener(e, poke)); };
  }, [enabled, epoch]);
  return [phase, wake];
}
