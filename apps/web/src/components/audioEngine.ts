/**
 * Procedural sound for JSTAR (its own chunk, loaded on the first interaction by lib/sound.ts).
 *
 * Background: a slow navy-night pad (maj9 chords, detuned saws through a low-pass) with a music-box
 * arpeggio in a dotted-eighth echo and a long synthetic reverb. PV mode adds a soft pulse and brightens the arp.
 * UI: tap, whoosh (section change), sparkle (reveal), omen / upgrade / reveal (card draws), flip.
 * Nothing here is sampled: these sounds are synthesised, so there is no licensing.
 *
 * Scene sound (#82) is the exception: a scene names its music (Lyria 3 originals) and the weather at her window (rain
 * and a snowy night, synthesised offline) from packages/shared/src/scenes/audio.ts. Those files are fetched on first
 * use, decoded once, and looped by WebAudio over their seamless window; while a scene holds the score, the pad above
 * is silent. Her voice ducks both.
 */
import { AMBIENCE_FILE, audioFile, audioUrl, type AmbienceKind, type AudioId, type MusicId } from '@jstar/shared/scenes/audio';

export type SfxName = 'tap' | 'whoosh' | 'sparkle' | 'omen' | 'upgrade' | 'reveal' | 'flip';
/** Weather you hear at her window (#63): rain and snow from files, the storm synthesised. */
export type Ambience = AmbienceKind | null;
/**
 * The scene's music (#82): `music` plays now (null: silence); a piece that does not loop gives way to `then` when it
 * ends. `undefined` hands the music back to the site's own pad.
 */
export type Score = { music: MusicId | null; then: MusicId | null } | undefined;
export interface Engine {
  bgm(on: boolean): void; pv(on: boolean): void; duck(down: boolean): void; sfx(n: SfxName): void; ambience(kind: Ambience): void;
  score(s: Score): void; suspend(): void; resume(): void;
}

/** Scene music level, and under her voice (her lines are mastered at −16 LUFS, the BGM at −18). */
export const FILE_LEVEL = 0.75;
export const FILE_DUCKED = 0.22;
/**
 * Where each music bus sits: the synthesised pad (`synth`) and the scene's files (`file`). A scene's score silences the
 * pad (the PV score, asked for explicitly, still plays); her voice ducks whichever is playing.
 */
export function levels(s: { bgm: boolean; pv: boolean; ducked: boolean; scene: boolean }): { synth: number; file: number } {
  const padOn = s.pv || (s.bgm && !s.scene);
  return {
    synth: padOn ? (s.ducked ? 0.09 : s.pv ? 0.7 : 0.5) : 0,
    file: s.scene && s.bgm ? (s.ducked ? FILE_DUCKED : FILE_LEVEL) : 0
  };
}

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
// Dmaj9 → Bm9 → Gmaj9 → A6/9, voiced low and close.
const CHORDS = [[50, 57, 61, 64, 66], [47, 54, 57, 61, 62], [43, 50, 54, 57, 59], [45, 52, 54, 59, 61]];
const ARP = [[74, 78, 81, 85, 88, 90], [71, 74, 78, 81, 85, 86], [67, 71, 74, 78, 81, 83], [69, 73, 76, 78, 83, 85]];
const PATTERN = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0];
const STEP = 60 / 70 / 2; // eighths at 70 bpm

export function createEngine(): Engine {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const now = () => ctx.currentTime;
  const master = ctx.createGain(); master.gain.value = 0.85;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);

  // Long synthetic room: decaying stereo noise.
  const verb = ctx.createConvolver();
  const len = Math.round(ctx.sampleRate * 2.4);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
  verb.buffer = ir;
  const verbIn = ctx.createGain(); verbIn.gain.value = 0.5;
  verbIn.connect(verb).connect(master);

  const music = ctx.createGain(); music.gain.value = 0; music.connect(master); music.connect(verbIn);
  const pad = ctx.createGain(); pad.gain.value = 0.5; pad.connect(music);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 760; lp.Q.value = 0.4; lp.connect(pad);
  const echo = ctx.createDelay(1); echo.delayTime.value = STEP * 1.5;
  const fb = ctx.createGain(); fb.gain.value = 0.34;
  const arpBus = ctx.createGain(); arpBus.gain.value = 0.55;
  arpBus.connect(music); arpBus.connect(echo); echo.connect(fb).connect(echo); echo.connect(music);
  const ui = ctx.createGain(); ui.gain.value = 0.7; ui.connect(master);
  const uiVerb = ctx.createGain(); uiVerb.gain.value = 0.35; ui.connect(uiVerb).connect(verbIn);

  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }

  let bgmOn = false; let pvOn = false; let ducked = false; let timer = 0;
  let score: Score;
  let step = 0; let next = 0; let chord = -1;

  const env = (g: GainNode, t: number, peak: number, a: number, d: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  function tone(m: number, t: number, peak: number, a: number, d: number, type: OscillatorType, out: AudioNode, glideTo?: number) {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(hz(m), t);
    if (glideTo != null) o.frequency.exponentialRampToValueAtTime(hz(glideTo), t + a + d);
    env(g, t, peak, a, d);
    o.connect(g).connect(out); o.start(t); o.stop(t + a + d + 0.05);
  }
  function hiss(t: number, dur: number, peak: number, from: number, to: number, type: BiquadFilterType = 'bandpass', out: AudioNode = ui) {
    const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = 0.9;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain(); env(g, t, peak, dur * 0.45, dur * 0.55);
    s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + dur + 0.05);
  }
  function padChord(k: number, t: number, hold: number) {
    for (const m of CHORDS[k]) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = det;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.028, t + 2.4);
      g.gain.setValueAtTime(0.028, t + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t + hold + 2.6);
      o.connect(g).connect(lp); o.start(t); o.stop(t + hold + 2.7);
    }
  }
  function schedule() {
    while (next < now() + 0.3) {
      const bar = Math.floor(step / 16) % CHORDS.length;
      const i = step % 16;
      if (i === 0 || chord < 0) { chord = bar; padChord(bar, next, (16 - i) * STEP); }
      if (PATTERN[i] || pvOn) {
        const notes = ARP[bar];
        const m = notes[(i * 5 + Math.floor(step / 16)) % notes.length];
        tone(m, next, pvOn ? 0.06 : 0.045, 0.006, pvOn ? 0.5 : 1.1, pvOn ? 'triangle' : 'sine', arpBus);
      }
      if (pvOn && i % 4 === 0) tone(40, next, 0.35, 0.004, 0.32, 'sine', music, 28);
      if (pvOn && i % 4 === 2) hiss(next, 0.05, 0.03, 7000, 9000, 'highpass', music);
      step++; next += STEP;
    }
  }
  function level() {
    const { synth: target, file } = levels({ bgm: bgmOn, pv: pvOn, ducked, scene: score !== undefined });
    fileBus.gain.cancelScheduledValues(now());
    fileBus.gain.setTargetAtTime(file, now(), ducked ? 0.12 : 0.6);
    music.gain.cancelScheduledValues(now());
    music.gain.setTargetAtTime(target, now(), target === 0 ? 0.5 : 0.8);
    pad.gain.setTargetAtTime(pvOn ? 0.35 : 0.5, now(), 0.5);
    lp.frequency.setTargetAtTime(pvOn ? 1400 : 760, now(), 1);
    const run = target > 0 && ctx.state === 'running';
    if (run && !timer) { next = Math.max(next, now() + 0.05); timer = window.setInterval(schedule, 110); schedule(); }
    if (!run && timer && target === 0) { window.setTimeout(() => { if (levels({ bgm: bgmOn, pv: pvOn, ducked, scene: score !== undefined }).synth === 0) { clearInterval(timer); timer = 0; } }, 2500); }
  }

  // ---------------------------------------------------------------- scene files (#82)

  const fileBus = ctx.createGain(); fileBus.gain.value = 0; fileBus.connect(master);
  const ambBus = ctx.createGain(); ambBus.gain.value = 1; ambBus.connect(master);
  const buffers = new Map<AudioId, Promise<AudioBuffer>>();
  const decode = (id: AudioId) => {
    let p = buffers.get(id);
    if (!p) {
      p = fetch(audioUrl(id)).then((r) => { if (!r.ok) throw new Error(`audio ${r.status}`); return r.arrayBuffer(); }).then((b) => ctx.decodeAudioData(b));
      p.catch(() => buffers.delete(id)); // a failed fetch is tried again next time
      buffers.set(id, p);
    }
    return p;
  };
  /** One file at a time on a bus: a new one fades in as the old one fades out; loops play their seamless window. */
  function track(bus: AudioNode) {
    let cur: { id: AudioId; src: AudioBufferSourceNode | null; gain: GainNode } | null = null;
    return {
      play(id: AudioId | null, fade: number, on: { end?: () => void; fail?: () => void } = {}) {
        if ((cur?.id ?? null) === id) return;
        if (cur) {
          const old = cur;
          old.gain.gain.cancelScheduledValues(now());
          old.gain.gain.setTargetAtTime(0, now(), fade / 4);
          window.setTimeout(() => { try { old.src?.stop(); } catch { /* not started */ } old.gain.disconnect(); }, fade * 1000 + 300);
        }
        cur = null;
        if (!id) return;
        const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(bus);
        const mine = { id, src: null as AudioBufferSourceNode | null, gain };
        cur = mine;
        decode(id).then((buf) => {
          if (cur !== mine) { gain.disconnect(); return; }
          const src = ctx.createBufferSource(); src.buffer = buf;
          const loop = audioFile(id)?.loop;
          if (loop) { src.loop = true; src.loopStart = loop.start; src.loopEnd = Math.min(loop.end, buf.duration); }
          else src.onended = () => { if (cur === mine) { cur = null; gain.disconnect(); on.end?.(); } };
          src.connect(gain); src.start(); mine.src = src;
          gain.gain.setTargetAtTime(1, now(), fade / 4);
        }).catch(() => { if (cur === mine) { cur = null; gain.disconnect(); on.fail?.(); } });
      }
    };
  }
  const musicTrack = track(fileBus);
  const ambTrack = track(ambBus);
  /** Plays what the score says, while background music is on. */
  function applyScore() {
    const want = bgmOn && score ? score.music : null;
    musicTrack.play(want, 2.4, {
      // A piece that ends by itself: the scene's own music comes back.
      end: () => { if (score && score.music === want) { score = { music: score.then, then: null }; applyScore(); } }
    });
    level();
  }

  const SFX: Record<SfxName, (t: number) => void> = {
    tap: (t) => tone(88, t, 0.05, 0.004, 0.09, 'sine', ui, 83),
    flip: (t) => { hiss(t, 0.06, 0.07, 2500, 5000, 'highpass'); tone(79, t, 0.035, 0.004, 0.12, 'triangle', ui); },
    whoosh: (t) => hiss(t, 0.62, 0.11, 380, 2600),
    sparkle: (t) => [86, 90, 93, 95, 98, 102].forEach((m, k) => tone(m, t + k * 0.045, 0.035, 0.003, 0.55, 'sine', ui)),
    omen: (t) => { tone(33, t, 0.2, 0.7, 0.8, 'sine', ui, 45); hiss(t, 1.1, 0.05, 200, 3200); },
    upgrade: (t) => { [69, 74, 78, 81, 86, 90, 93].forEach((m, k) => tone(m, t + k * 0.05, 0.05, 0.004, 0.4, 'triangle', ui)); hiss(t, 0.5, 0.05, 3000, 9000, 'highpass'); },
    reveal: (t) => {
      tone(40, t, 0.4, 0.005, 0.7, 'sine', ui, 26);
      [74, 78, 81, 85, 88].forEach((m) => tone(m, t + 0.02, 0.04, 0.02, 2.6, 'triangle', ui));
      SFX.sparkle(t + 0.15);
    }
  };

  /**
   * The storm (#63), synthesised: the noise through a low band (the wash on the roof), a high one (drops on the glass)
   * and a gusting rumble, each slowly swelling and fading so it never sounds like a hiss on a loop. Rain and snow play
   * their #82 files; these synthesised versions stand in only when a file cannot load.
   */
  let rain: { stop(): void } | null = null;
  let rainKind: Ambience = null;
  function startRain(kind: AmbienceKind) {
    const storm = kind === 'storm';
    const bus = ctx.createGain(); bus.gain.value = 0.0001; bus.connect(master);
    const nodes: AudioScheduledSourceNode[] = [];
    const band = (freq: number, q: number, gain: number, lfoHz: number, depth: number) => {
      const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
      s.playbackRate.value = 0.7 + Math.random() * 0.6;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      const lfo = ctx.createOscillator(); lfo.frequency.value = lfoHz;
      const amt = ctx.createGain(); amt.gain.value = gain * depth;
      lfo.connect(amt).connect(g.gain);
      s.connect(f).connect(g).connect(bus);
      s.start(); lfo.start(); nodes.push(s, lfo);
    };
    if (kind === 'snow') {
      // Only if the snowy-night file cannot play: a muffled wind that gusts and settles, a faint whistle in the frame.
      band(320, 0.5, 0.42, 0.05, 0.7);
      band(900, 3, 0.05, 0.09, 0.9);
    } else {
      band(storm ? 700 : 520, 0.6, storm ? 0.5 : 0.34, 0.07, 0.4);
      band(storm ? 4200 : 3400, 0.9, storm ? 0.22 : 0.14, 0.13, 0.6);
      if (storm) band(260, 0.4, 0.28, 0.21, 0.9);
    }
    bus.gain.setTargetAtTime(storm ? 0.5 : kind === 'snow' ? 0.3 : 0.36, now(), 1.2);
    return {
      stop() {
        bus.gain.cancelScheduledValues(now());
        bus.gain.setTargetAtTime(0.0001, now(), 0.6);
        window.setTimeout(() => { for (const n of nodes) n.stop(); bus.disconnect(); }, 3000);
      }
    };
  }

  return {
    /** Rain and snow play their files (the synthesised versions stand in if a file cannot load); a storm is synthesised. */
    ambience(kind) {
      if (kind === rainKind) return;
      rain?.stop(); rain = null; rainKind = kind;
      const file = kind && kind !== 'storm' ? AMBIENCE_FILE[kind] : null;
      ambTrack.play(file, 3, { fail: () => { if (rainKind === kind && kind && !rain) rain = startRain(kind); } });
      if (kind && !file) rain = startRain(kind);
    },
    score(s) { score = s ? { ...s } : undefined; applyScore(); },
    bgm(on) { bgmOn = on; applyScore(); },
    pv(on) { pvOn = on; level(); },
    duck(down) { ducked = down; level(); },
    sfx(n) { if (ctx.state === 'running') SFX[n](now() + 0.01); },
    suspend() { void ctx.suspend(); },
    resume() { void ctx.resume().then(level); }
  };
}
