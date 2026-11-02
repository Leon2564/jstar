"""
Procedural weather ambience (#63, #82): rain at her window and a snowy night, synthesised here (nothing sampled, nothing
licensed). Everything is built circularly on a fixed loop length — noise filtered in the frequency domain of the whole
loop, swells whose periods divide the loop, drops placed modulo the loop — so the file loops with no seam at all.
  ambience.py rain|snow out.wav [seconds] [seed]
The file carries the loop's own last 0.25 s before it and first 0.25 s after it, like loops.py make, so the player
loops [0.25, 0.25 + seconds].
"""
import sys, wave, numpy as np
SR = 44100
kind, out = sys.argv[1], sys.argv[2]
T = float(sys.argv[3]) if len(sys.argv) > 3 else 48.0
rng = np.random.default_rng(int(sys.argv[4]) if len(sys.argv) > 4 else 82)
N = int(T * SR); t = np.arange(N) / SR
f = np.fft.rfftfreq(N, 1 / SR)

def shaped(resp):
    """Circular noise with magnitude response `resp(f)`: periodic in N by construction."""
    spec = (rng.standard_normal(len(f)) + 1j * rng.standard_normal(len(f))) * resp(f)
    spec[0] = 0
    y = np.fft.irfft(spec, n=N)
    return y / (np.sqrt(np.mean(y ** 2)) + 1e-12)

def swell(periods, depth):
    """Slow loudness changes: cosines with a whole number of cycles per loop."""
    e = np.zeros(N)
    for k in periods: e += np.cos(2 * np.pi * (k / T) * t + rng.uniform(0, 2 * np.pi)) / len(periods)
    return 1 + depth * e

def band(lo, hi, tilt=0.0):
    return lambda fr: ((fr >= lo) & (fr <= hi)) * (np.maximum(fr, 20) / 1000.0) ** tilt * (1 / (1 + (lo / np.maximum(fr, 1)) ** 4)) * (1 / (1 + (fr / hi) ** 4))

def place(buf, grain, at):
    n = len(grain); idx = (np.arange(n) + at) % N
    np.add.at(buf, idx, grain)

L = np.zeros(N); R = np.zeros(N)
if kind == 'rain':
    # The wash: rain on the roof and the street, a warm low band and a brighter hiss, each swelling slowly.
    for ch, pan in ((L, 0), (R, 1)):
        ch += 0.55 * shaped(lambda fr: band(180, 2500, -0.5)(fr)) * swell([1, 2, 3], 0.25)
        ch += 0.22 * shaped(lambda fr: band(2500, 9000, -0.8)(fr)) * swell([2, 5], 0.35)
    # Drops on the glass: thousands of tiny filtered ticks, a few bigger drips with a short glassy ring.
    tick_len = int(0.004 * SR)
    for _ in range(int(90 * T)):
        at = rng.integers(N); amp = rng.uniform(0.02, 0.12) ** 1.6 * 6
        g = rng.standard_normal(tick_len) * np.exp(-np.arange(tick_len) / (tick_len / 5)) * amp
        g = np.diff(g, prepend=0)  # brighter
        p = rng.uniform(0, 1); place(L, g * (1 - p), at); place(R, g * p, at)
    ring = int(0.12 * SR)
    for _ in range(int(1.2 * T)):
        at = rng.integers(N); fr = rng.uniform(1400, 3400); amp = rng.uniform(0.05, 0.18)
        k = np.arange(ring) / SR
        g = amp * np.sin(2 * np.pi * fr * k * (1 - 0.15 * k / 0.12)) * np.exp(-k / 0.025)
        p = rng.uniform(0.15, 0.85); place(L, g * (1 - p), at); place(R, g * p, at)
elif kind == 'snow':
    # A snowy night is mostly hush: a muffled wind outside that gusts and settles, a faint whistle at the window
    # frame now and then, and the small ticks of a warm stove in the room.
    gust = swell([1, 2, 3, 5], 0.6)
    for ch in (L, R):
        ch += 0.6 * shaped(lambda fr: band(40, 700, -1.2)(fr)) * gust
        ch += 0.12 * shaped(lambda fr: band(700, 2200, -1.0)(fr)) * swell([2, 3], 0.7) * gust
    whistle = shaped(lambda fr: np.exp(-((fr - 880) / 40.0) ** 2) + 0.6 * np.exp(-((fr - 1320) / 50.0) ** 2))
    wenv = np.clip(swell([1, 3], 1.4) - 1.2, 0, None)
    L += 0.05 * whistle * wenv; R += 0.04 * np.roll(whistle, int(0.013 * SR)) * wenv
    tick = int(0.006 * SR)
    for _ in range(int(0.7 * T)):
        at = rng.integers(N); amp = rng.uniform(0.02, 0.07)
        g = rng.standard_normal(tick) * np.exp(-np.arange(tick) / (tick / 6)) * amp
        p = rng.uniform(0.3, 0.7); place(L, g * (1 - p), at); place(R, g * p, at)
else:
    sys.exit('rain|snow')
# Partly shared between the ears (about 0.4 correlation): wide, but never two unrelated noises.
y = np.stack([0.9 * L + 0.2 * R, 0.9 * R + 0.2 * L], 1)
y *= 0.25 / (np.sqrt(np.mean(y ** 2)) + 1e-12)
P = int(0.25 * SR)
y = np.concatenate([y[-P:], y, y[:P]])
pcm = (np.clip(y, -1, 1) * 32767).astype('<i2')
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(out, f'{T}s')
