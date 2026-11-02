import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const token = process.env.VIDU_API_TOKEN || '';
const base = (process.env.VIDU_LIVE_BASE_URL || 'https://api.vidu.com').replace(/\/+$/, '');
const star = (process.env.VIDU_STAR || 'eimi').trim().toLowerCase();
if (!/^[a-z][a-z0-9-]{1,15}$/.test(star)) throw new Error('VIDU_STAR must be a short lowercase talent id');
const prefix = `VIDU_${star.toUpperCase().replaceAll('-', '_')}`;
const imagePath = resolve(process.env[`${prefix}_IMAGE_PATH`] || `assets/agency/${star}/live-cover.jpeg`);
const voicePath = resolve(process.env[`${prefix}_VOICE_PATH`] || `assets/agency/${star}/voice.mp3`);
const manifestPath = resolve(process.env[`${prefix}_MANIFEST`] || `assets/agency/${star}/vidu.json`);
const voiceOnly = /^(?:1|true)$/i.test(process.env.VIDU_VOICE_ONLY || '');
if (!token) throw new Error('VIDU_API_TOKEN is required');

let previous = {};
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* first provision */ }

const headers = { Authorization: `Token ${token}`, 'content-type': 'application/json' };

const request = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${data.error || data.message || 'unknown error'}`);
  return data;
};

const query = async (path) => {
  const res = await fetch(`${base}${path}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${data.error || data.message || 'unknown error'}`);
  return data;
};

const audio = `data:audio/mpeg;base64,${(await readFile(voicePath)).toString('base64')}`;
let avatarId = previous.avatarId;
if (!voiceOnly) {
  const image = `data:image/jpeg;base64,${(await readFile(imagePath)).toString('base64')}`;
  const listed = await query('/live/v1/avatars?pager.page=0&pager.pagesz=100');
  const avatarName = `${star}_jstar_live`;
  const existingAvatar = (listed.items || []).find((item) => item.name === avatarName && item.status !== 'failed' && item.status !== 12);
  const avatar = existingAvatar || await request('/live/v1/avatars', { image_uri: image, name: avatarName });
  avatarId = avatar.id || avatar.avatar?.id;
}
// Vidu's realtime voice backend accepts a maximum 16-character preferred name.
const voiceName = `${star.slice(0, 5)}${Date.now().toString(36).slice(-10)}`;
const voice = await request('/live/v1/voices/clone', { audio_url: audio, voice: voiceName, language: 'ja' });
const persona = process.env[`${prefix}_PERSONA`] || previous.persona;
const greetingInstruction = process.env[`${prefix}_GREETING_INSTRUCTION`] || previous.greetingInstruction;
const manifest = {
  ...previous,
  ...(avatarId ? { avatarId } : {}),
  voice: voice.voice || voiceName,
  ...(persona ? { persona } : {}),
  ...(greetingInstruction ? { greetingInstruction } : {}),
  provisionedAt: new Date().toISOString()
};
if ((!voiceOnly && !manifest.avatarId) || !manifest.voice) throw new Error('Vidu returned an incomplete avatar or voice response');
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Vidu assets are ready: ${manifestPath}`);
