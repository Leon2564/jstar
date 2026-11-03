import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const envText = await readFile(resolve(root, '.env'), 'utf8');
const local = {};
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match) continue;
  local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
if (!local.VIDU_API_TOKEN) throw new Error('VIDU_API_TOKEN is missing from .env');

const secrets = { VIDU_API_TOKEN: local.VIDU_API_TOKEN };
const splitUtf8 = (value, maxBytes = 4_500) => {
  if (!value) return [];
  const chunks = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > maxBytes) {
      chunks.push(chunk);
      chunk = character;
    } else chunk += character;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 2) throw new Error('Persona is too large for the two-part Worker secret layout');
  return chunks;
};
for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi']) {
  const manifest = JSON.parse(await readFile(resolve(root, `assets/agency/${star}/vidu.json`), 'utf8'));
  const prefix = `VIDU_${star.toUpperCase()}`;
  if (!manifest.desktopAvatarId || !manifest.mobileAvatarId || !manifest.voice) {
    throw new Error(`${star} is missing a desktop avatar, mobile avatar, or voice`);
  }
  secrets[`${prefix}_DESKTOP_AVATAR_ID`] = manifest.desktopAvatarId;
  secrets[`${prefix}_MOBILE_AVATAR_ID`] = manifest.mobileAvatarId;
  secrets[`${prefix}_VOICE`] = manifest.voice;
  const persona = splitUtf8(manifest.persona);
  if (persona[0]) secrets[`${prefix}_PERSONA_A`] = persona[0];
  if (persona[1]) secrets[`${prefix}_PERSONA_B`] = persona[1];
  if (manifest.greetingInstruction) secrets[`${prefix}_GREETING`] = manifest.greetingInstruction;
}

const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const result = spawnSync(process.execPath, [wrangler, 'secret', 'bulk', '-c', 'wrangler.leon.jsonc'], {
  cwd: resolve(root, 'infra/cloudflare'),
  input: JSON.stringify(secrets),
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe']
});
if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'wrangler secret bulk failed').trim());
console.log(`Synchronized ${Object.keys(secrets).length} Vidu Worker secrets.`);
