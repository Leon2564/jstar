import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const envText = await readFile('.env', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match || process.env[match[1]]) continue;
  const raw = match[2];
  process.env[match[1]] = raw.replace(/^(['"])(.*)\1$/, '$2');
}

const token = process.env.VIDU_API_TOKEN;
const base = (process.env.VIDU_LIVE_BASE_URL || 'https://api.vidu.com').replace(/\/+$/, '');
if (!token) throw new Error('VIDU_API_TOKEN is missing');

const headers = { Authorization: `Token ${token}` };
const [avatarResponse, voiceResponse] = await Promise.all([
  fetch(`${base}/live/v1/avatars?pager.page=0&pager.pagesz=100`, { headers }),
  fetch(`${base}/live/v1/voices`, { headers })
]);
const body = await avatarResponse.json().catch(() => ({}));
const voiceBody = await voiceResponse.json().catch(() => ({}));
const items = Array.isArray(body.items) ? body.items : [];
const voices = Array.isArray(voiceBody.voices) ? voiceBody.voices : [];
const stars = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
const configuredAssets = await Promise.all(stars.map(async (star) => {
  const manifest = JSON.parse(await readFile(`assets/agency/${star}/vidu.json`, 'utf8'));
  const layouts = await Promise.all(['desktopAvatarId', 'mobileAvatarId'].map(async (key) => {
    if (!manifest[key]) return { configured: false, status: null };
    const response = await fetch(`${base}/live/v1/avatars/${encodeURIComponent(manifest[key])}`, { headers });
    const data = await response.json().catch(() => ({}));
    const imageUri = data.image_uri ?? data.avatar?.image_uri;
    let dimensions = null;
    if (response.ok && imageUri) {
      const imageResponse = await fetch(imageUri);
      if (imageResponse.ok) {
        const metadata = await sharp(Buffer.from(await imageResponse.arrayBuffer())).metadata();
        dimensions = metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null;
      }
    }
    return {
      configured: true,
      status: data.status ?? data.avatar?.status ?? (response.ok ? 'ready' : `http_${response.status}`),
      name: data.name ?? data.avatar?.name ?? null,
      dimensions
    };
  }));
  return { star, desktop: layouts[0], mobile: layouts[1], voice: voices.some((item) => item.voice === manifest.voice) };
}));
console.log(JSON.stringify({
  status: avatarResponse.status,
  authenticated: avatarResponse.ok,
  avatarCount: items.length,
  readyAvatarCount: items.filter((item) => item.status !== 'failed' && item.status !== 12).length,
  jstarAvatars: items
    .filter((item) => typeof item.name === 'string' && item.name.endsWith('_jstar_live'))
    .map((item) => ({ name: item.name, status: item.status })),
  voiceStatus: voiceResponse.status,
  voices: voices.map((item) => item.voice).filter(Boolean),
  configuredAssets
}));

if (!avatarResponse.ok || !voiceResponse.ok) process.exitCode = 1;
