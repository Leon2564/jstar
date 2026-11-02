import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The sound front door (lib/sound.ts) with the engine chunk replaced by spies. */
const fake = vi.hoisted(() => {
  const calls: string[] = [];
  const spy = (name: string) => vi.fn((...a: unknown[]) => { calls.push(`${name}(${a.map((x) => JSON.stringify(x) ?? 'undefined').join(',')})`); });
  const engine = { bgm: spy('bgm'), pv: spy('pv'), duck: spy('duck'), sfx: spy('sfx'), ambience: spy('ambience'), score: spy('score'), suspend: spy('suspend'), resume: spy('resume') };
  return { calls, engine, createEngine: vi.fn(() => engine) };
});
vi.mock('../../src/components/audioEngine', () => ({ createEngine: fake.createEngine }));

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
async function fresh(pref: 'on' | 'off') {
  localStorage.setItem('jstar.sound', pref);
  vi.resetModules();
  return import('../../src/lib/sound');
}

beforeEach(() => { localStorage.clear(); fake.calls.length = 0; fake.createEngine.mockClear(); });
afterEach(() => { window.dispatchEvent(new Event('pointerdown')); });

describe('scene music through the sound switch (#82)', () => {
  it('waits for his first tap: nothing loads before it, then the scene\'s music (not the site\'s pad) starts', async () => {
    const s = await fresh('on');
    s.installSound();
    s.sceneMusic('bgm/night', 'bgm/night');
    s.ambience('snow');
    await settle();
    expect(fake.createEngine).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(fake.createEngine).toHaveBeenCalledTimes(1);
    // The score is set before the music is switched on, so the pad never starts under the scene.
    const i = fake.calls.indexOf('score({"music":"bgm/night","then":"bgm/night"})');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(fake.calls.indexOf('bgm(true)')).toBeGreaterThan(i);
    expect(fake.calls).toContain('ambience("snow")');
  });

  it('with sound off it stays silent; turning sound on starts the scene where it is, off stops it', async () => {
    const s = await fresh('off');
    s.installSound();
    window.dispatchEvent(new Event('pointerdown'));
    s.sceneMusic('piece/unpai-earphones', 'bgm/playful');
    await settle();
    expect(fake.createEngine).not.toHaveBeenCalled();
    s.setSound(true);
    await settle();
    expect(fake.calls).toContain('score({"music":"piece/unpai-earphones","then":"bgm/playful"})');
    expect(fake.calls).toContain('bgm(true)');
    fake.calls.length = 0;
    s.setSound(false);
    await settle();
    expect(fake.calls).toEqual(['bgm(false)', 'ambience(null)']);
  });

  it('her voice ducks it, and leaving hands the music back to the site', async () => {
    const s = await fresh('on');
    s.installSound();
    window.dispatchEvent(new Event('pointerdown'));
    s.sceneMusic('bgm/home-evening', 'bgm/home-evening');
    s.duck(true);
    s.duck(false);
    s.sceneMusic(undefined);
    await settle();
    expect(fake.calls.slice(-3)).toEqual(['duck(true)', 'duck(false)', 'score(undefined)']);
  });
});
