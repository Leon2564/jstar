"""
Listening checks for #82 music, since nobody listens in CI:
  check.py stats <file>...                      duration, EBU R128 (I / LRA / true peak), clipping, bandwidth, stereo,
                                                spectral centroid and flatness, quietest second of the body
  check.py seam <file.m4a>:<loop samples>...    the loop as the browser plays it: decode, take [0.25 s, + length],
                                                compare the wrap with every other adjacent pair in the file
The seam passes when its energy step (50 ms RMS either side) and spectral flux sit inside the file's own distribution
(< 95th percentile) and its sample jump is below the 99th percentile of the file's adjacent-sample differences.
"""
import json, re, subprocess, sys, numpy as np
SR = 44100

def load(path):
    raw = subprocess.run(['nice', 'ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)

def lufs(path):
    out = subprocess.run(['nice', 'ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    tail = out[out.rfind('Summary:'):]
    g = lambda pat: float(re.search(pat, tail).group(1))
    return g(r'I:\s+(-?[\d.]+) LUFS'), g(r'LRA:\s+([\d.]+) LU'), g(r'Peak:\s+(-?[\d.]+) dBFS')

def stats(path):
    x = load(path); m = x.mean(1)
    I, LRA, TP = lufs(path)
    S = np.zeros(2049); n = 0
    for i in range(0, len(m) - 4096, 4096): S += np.abs(np.fft.rfft(m[i:i + 4096] * np.hanning(4096))) ** 2; n += 1
    S /= max(n, 1); f = np.fft.rfftfreq(4096, 1 / SR); db = 10 * np.log10(S + 1e-20)
    sec = [20 * np.log10(np.sqrt(np.mean(m[i * SR:(i + 1) * SR] ** 2)) + 1e-9) for i in range(len(m) // SR)]
    body = sec[2:-4] if len(sec) > 8 else sec
    return dict(file=path, seconds=round(len(m) / SR, 2), I=I, LRA=LRA, TP=TP, clip_pct=round(float((np.abs(x) > 0.999).mean() * 100), 4),
                hf_limit_hz=int(f[np.nonzero(db > db.max() - 70)[0].max()]), centroid_hz=int((f * S).sum() / S.sum()),
                flatness=round(float(np.exp(np.mean(np.log(S[5:] + 1e-20))) / np.mean(S[5:])), 4),
                lr_corr=round(float(np.corrcoef(x[:, 0], x[:, 1])[0, 1]), 2), quietest_body_db=round(min(body), 1))

def seam(m):
    w = int(0.05 * SR); db = lambda s: 20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-9)
    step = abs(db(m[-w:]) - db(m[:w]))
    wins = [db(m[i:i + w]) for i in range(0, len(m) - w, w)]
    spec = lambda s: np.log1p(np.abs(np.fft.rfft(s * np.hanning(len(s)))))
    N = 2048
    fl = [np.maximum(spec(m[i + N:i + 2 * N]) - spec(m[i:i + N]), 0).sum() for i in range(0, len(m) - 2 * N, N)]
    wf = np.maximum(spec(m[:N]) - spec(m[-N:]), 0).sum()
    jump = abs(m[-1] - m[0]); p99 = float(np.percentile(np.abs(np.diff(m)), 99))
    r = dict(energy_step_db=round(step, 2), energy_step_pct=round(float((np.abs(np.diff(wins)) < step).mean() * 100), 1),
             flux_pct=round(float((np.array(fl) < wf).mean() * 100), 1), jump=round(float(jump), 4), jump_p99=round(p99, 4))
    r['ok'] = bool(r['energy_step_pct'] < 95 and r['flux_pct'] < 95 and jump < p99)
    return r

if __name__ == '__main__':
    cmd, args = sys.argv[1], sys.argv[2:]
    for a in args:
        if cmd == 'stats': print(json.dumps(stats(a)))
        else:
            path, n = a.rsplit(':', 1); P = int(0.25 * SR)
            print(path, json.dumps(seam(load(path).mean(1)[P:P + int(n)])))
