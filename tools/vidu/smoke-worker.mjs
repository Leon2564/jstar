import WebSocket from 'ws';

const origin = process.env.JSTAR_ORIGIN || 'https://jstar-leon.lionellong.workers.dev';
const star = process.env.VIDU_STAR || 'unpai';
const layout = process.env.VIDU_LAYOUT || 'desktop';
const response = await fetch(`${origin}/v1/live/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ star, lang: 'ja', layout })
});
const session = await response.json().catch(() => ({}));
if (!response.ok || !session.liveId || !session.rtc?.token || !session.controlUrl || !session.controlId) {
  console.log(JSON.stringify({ sessionStatus: response.status, sessionReady: false, error: session.error || 'invalid_response' }));
  process.exit(1);
}

const controlUrl = new URL(session.controlUrl, origin);
controlUrl.protocol = controlUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(controlUrl);
let seq = 0;
const packet = (type, payload) => JSON.stringify({
  type,
  live_id: session.liveId,
  conn_id: session.controlId,
  seq_id: ++seq,
  payload
});

const result = await new Promise((resolve) => {
  const timeout = setTimeout(() => resolve({ controlReady: false, error: 'timeout' }), 20_000);
  socket.on('open', () => socket.send(packet(1, { conn_init: { version: 1 } })));
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 2) return;
    const ack = message.payload?.conn_init_ack;
    clearTimeout(timeout);
    if (ack?.success) socket.send(packet(5, { hangup: { hangup_reason: 'smoke_test_complete' } }));
    resolve({ controlReady: Boolean(ack?.success), error: ack?.success ? undefined : ack?.error_code || ack?.error_msg || 'rejected' });
  });
  socket.on('error', () => { clearTimeout(timeout); resolve({ controlReady: false, error: 'websocket_error' }); });
});
socket.close();
console.log(JSON.stringify({ sessionStatus: response.status, sessionReady: true, star, layout, ...result }));
if (!result.controlReady) process.exitCode = 1;
