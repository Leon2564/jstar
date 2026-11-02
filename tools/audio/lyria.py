"""
One take from Lyria 3 through OpenRouter (#82 music). The model streams its audio as SSE chunks (`delta.audio.data`,
base64); it answers MP3 (44.1 kHz stereo, 192 kbps, with a C2PA content credential) whatever `audio.format` asks.
Prints the credit before and after, and stops below $20 (the account is shared with production chat).

  set -a && . ./.env.openrouter.local && set +a
  python3 tools/audio/lyria.py pro|clip <out-basename> <prompt-file> [--seed N]
`pro` / `clip` are config/models.json music.piece / music.clip (a full model id works too).
(macOS python.org builds: SSL_CERT_FILE=/etc/ssl/cert.pem.) Writes <out>.mp3 and <out>.txt (the model's text: section
markers, or timed lyrics / vocalisations, plus usage and cost). Cost: $0.08 a pro song, $0.04 a 30 s clip.
"""
import argparse, base64, json, os, sys, time, urllib.request

ap = argparse.ArgumentParser(); ap.add_argument('model'); ap.add_argument('out'); ap.add_argument('prompt'); ap.add_argument('--seed', type=int)
a = ap.parse_args()
MODELS = json.load(open(os.path.join(os.path.dirname(__file__), '../../config/models.json')))['music']
a.model = {'pro': MODELS['piece']['model'], 'clip': MODELS['clip']['model']}.get(a.model, a.model)
H = {'Authorization': f"Bearer {os.environ['OPENROUTER_API_KEY']}", 'Content-Type': 'application/json'}

def credit() -> float:
    d = json.load(urllib.request.urlopen(urllib.request.Request('https://openrouter.ai/api/v1/credits', headers=H), timeout=30))['data']
    return d['total_credits'] - d['total_usage']

before = credit()
print(f'credit before: {before:.2f}', flush=True)
if before < 20: sys.exit('credit below $20: stop')
body = {'model': a.model, 'messages': [{'role': 'user', 'content': open(a.prompt).read().strip()}],
        'modalities': ['text', 'audio'], 'audio': {'format': 'mp3'}, 'stream': True, 'usage': {'include': True}}
if a.seed is not None: body['seed'] = a.seed
t = time.time()
try:
    resp = urllib.request.urlopen(urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', data=json.dumps(body).encode(), headers=H), timeout=600)
except urllib.error.HTTPError as e:
    sys.exit(f'HTTP {e.code}: {e.read().decode()[:2000]}')
chunks, text, usage = [], [], None
for raw in resp:
    line = raw.decode().strip()
    if not line.startswith('data:') or line == 'data: [DONE]': continue
    try: j = json.loads(line[5:])
    except ValueError: continue
    if 'error' in j: print('error:', j['error'])
    usage = j.get('usage') or usage
    for c in j.get('choices', []):
        d = c.get('delta') or {}
        if (d.get('audio') or {}).get('data'): chunks.append(d['audio']['data'])
        if (d.get('audio') or {}).get('transcript'): text.append(d['audio']['transcript'])
        if d.get('content'): text.append(d['content'])
audio = b''.join(base64.b64decode(c) for c in chunks)
if audio: open(f'{a.out}.mp3', 'wb').write(audio)
open(f'{a.out}.txt', 'w').write(''.join(text) + '\n\nUSAGE ' + json.dumps(usage) + '\n')
print(f'{time.time() - t:.0f}s, {len(audio)} bytes, cost {(usage or {}).get("cost")}, credit after {credit():.2f} (lags a call)')
print('text:', ''.join(text)[:400])
