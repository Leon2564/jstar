import { describe, expect, it } from 'vitest';
import { holdStage, type StageHandle } from '../../src/scene/stage';

// N-17: the cold open — her line and her first cut wait for the clip on screen; a late one gets her stall line over
// her idle poster, never an empty stage.
function fakeStage(readyAt: Record<string, number>, painted = true) {
  const t0 = Date.now();
  const isReady = (id: string) => Date.now() - t0 >= (readyAt[id] ?? 0);
  const stage: StageHandle = {
    ready: isReady,
    whenReady: (id, ms) => new Promise((r) => {
      const left = (readyAt[id] ?? 0) - (Date.now() - t0);
      if (left <= 0) r(true); else if (left <= ms) setTimeout(() => r(true), left); else setTimeout(() => r(false), ms);
    }),
    whenPainted: async () => painted
  };
  return stage;
}
const run = (stage: StageHandle, target: string, lines = ['……ちょっと待ってね']) => {
  const log: string[] = [];
  const done = holdStage({
    stage, target, idle: 'idle', quickMs: 20, stallMs: 120, lines, cancelled: () => false,
    onStall: (on) => log.push(on ? 'stall' : 'unstall'), onLine: (l) => log.push(`line:${l}`)
  }).then(() => log.push('go'));
  return { log, done };
};

describe('holding the stage (N-17)', () => {
  it('a clip already playable goes on at once', async () => {
    const { log, done } = run(fakeStage({}), 'talk');
    await done;
    expect(log).toEqual(['go']);
  });

  it('a clip ready within the short wait: no stall line', async () => {
    const { log, done } = run(fakeStage({ talk: 10 }), 'talk');
    await done;
    expect(log).toEqual(['go']);
  });

  it('a late loop gets her stall line over her idle, and goes on once it can play', async () => {
    const { log, done } = run(fakeStage({ talk: 60 }), 'talk');
    await done;
    expect(log).toEqual(['stall', 'line:……ちょっと待ってね', 'unstall', 'go']);
  });

  it('never playable in time: the line goes on over her idle poster, and the stall ends when the clip arrives', async () => {
    const { log, done } = run(fakeStage({ talk: 300 }), 'talk');
    await done;
    expect(log).toEqual(['stall', 'line:……ちょっと待ってね', 'go']);
    await new Promise((r) => setTimeout(r, 250));
    expect(log.at(-1)).toBe('unstall');
  });
});
