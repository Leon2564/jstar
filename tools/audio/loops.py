"""
Seamless loops from a generated piece (#82: 循环无缝).

  loops.py find <in> --starts 10,20,30 --min 60 --max 100     best loop for each start (score = crossfade match)
  loops.py make <in> <out.wav> --start S --min L1 --max L2    the loop, tiled (below)

`make` picks the loop end e in [S+L1, S+L2] whose next seconds look most like the seconds from S (24 log band energies
+ onset flux, z-scored), aligns it to the sample by waveform correlation, and builds y = x[S:e] with its first X
seconds crossfaded (equal power) from x[e:e+X]: the wrap y[-1] -> y[0] is then x[e-1] -> x[e], continuous by
construction. It then writes y with its own last 0.25 s before it and its own first 0.25 s after it, so every window of
the loop's length inside the file is the same loop: a decoder that keeps the AAC priming or pads the end only shifts
where the loop sits. The player loops [0.25, 0.25 + length] (packages/shared/src/scenes/audio.ts `loop`).
"""
import argparse, wave, numpy as np
from check import load, SR

HOP = 512
PAD = 0.25

def feats(sig):
    n = (len(sig) - 2048) // HOP
    idx = np.arange(2048)[None, :] + HOP * np.arange(n)[:, None]
    mag = np.abs(np.fft.rfft(sig[idx] * np.hanning(2048), axis=1))
    freqs = np.fft.rfftfreq(2048, 1 / SR)
    edges = np.geomspace(60, 12000, 25)
    lb = np.log1p(np.stack([mag[:, (freqs >= lo) & (freqs < hi)].sum(1) for lo, hi in zip(edges[:-1], edges[1:])], 1))
    flux = np.maximum(np.diff(lb, axis=0, prepend=lb[:1]), 0).sum(1, keepdims=True)
    return np.hstack([lb, 3 * flux])

def find(F, start, lmin, lmax, win=6.0):
    s = int(start * SR / HOP); W = int(win * SR / HOP)
    ref = F[s:s + W]; ref = (ref - ref.mean(0)) / (ref.std(0) + 1e-9)
    best = (-9.0, s)
    for e in range(int((start + lmin) * SR / HOP), int((start + lmax) * SR / HOP)):
        c = F[e:e + W]
        if len(c) < W: break
        c = (c - c.mean(0)) / (c.std(0) + 1e-9)
        best = max(best, (float((ref * c).mean()), e))
    return best[0], s * HOP, best[1] * HOP

def write(path, y):
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(y, -1, 1) * 32767).astype('<i2').tobytes())

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('cmd', choices=['find', 'make']); ap.add_argument('inp'); ap.add_argument('out', nargs='?')
    ap.add_argument('--start', type=float); ap.add_argument('--starts', default=''); ap.add_argument('--min', type=float, required=True)
    ap.add_argument('--max', type=float, required=True); ap.add_argument('--xfade', type=float, default=2.0)
    a = ap.parse_args()
    x = load(a.inp); m = x.mean(1); F = feats(m)
    if a.cmd == 'find':
        for st in [float(v) for v in a.starts.split(',')]:
            sc, S, E = find(F, st, a.min, a.max)
            print(f'start {S / SR:.2f}s -> {E / SR:.2f}s = {(E - S) / SR:.2f}s  match {sc:.3f}')
    else:
        sc, S, E = find(F, a.start, a.min, a.max)
        k = int(0.1 * SR); r = int(0.015 * SR); seg = m[S:S + k]
        corr, d = max((float(np.dot(seg, m[E + d:E + d + k]) / (np.linalg.norm(m[E + d:E + d + k]) * np.linalg.norm(seg) + 1e-12)), d) for d in range(-r, r))
        E += d; X = int(a.xfade * SR)
        assert E + X <= len(x), 'no room after the loop end for the crossfade'
        y = x[S:E].copy(); t = np.linspace(0, np.pi / 2, X)[:, None]
        y[:X] = x[S:S + X] * np.sin(t) + x[E:E + X] * np.cos(t)
        P = int(PAD * SR)
        write(a.out, np.concatenate([y[-P:], y, y[:P]]))
        print(f'loop {S / SR:.3f}s -> {E / SR:.3f}s: {len(y)} samples = {len(y) / SR:.6f}s (match {sc:.3f}, wave corr {corr:.3f}); '
              f'catalogue loop: {{ start: {PAD}, end: {PAD + len(y) / SR:.6f} }}')
