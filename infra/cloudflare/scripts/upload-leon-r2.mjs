import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const publicRoot = resolve(root, 'apps/web/public');
const stateDir = resolve(root, 'infra/cloudflare/.wrangler');
const stateFile = resolve(stateDir, 'leon-r2-upload-state.json');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const bucket = 'jstar-media';
const resourceDirectories = ['audio', 'cards', 'gifts', 'icons', 'media', 'voice'];
const concurrency = Number(process.env.JSTAR_R2_CONCURRENCY || 4);

const mimeTypes = new Map([
  ['.avif', 'image/avif'], ['.gif', 'image/gif'], ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.json', 'application/json'],
  ['.m4a', 'audio/mp4'], ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm']
]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { completed: {} };
  }
}

const files = resourceDirectories.flatMap((dir) => walk(resolve(publicRoot, dir)));
const state = loadState();
mkdirSync(stateDir, { recursive: true });
let completed = Object.keys(state.completed).length;
let failed = false;

function saveState() {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function upload(path) {
  const key = relative(publicRoot, path).split(sep).join('/');
  const stats = statSync(path);
  const signature = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
  if (state.completed[key] === signature) return Promise.resolve(false);

  const mime = mimeTypes.get(extname(path).toLowerCase()) || 'application/octet-stream';
  const args = [
    wrangler, 'r2', 'object', 'put', `${bucket}/${key}`,
    `--file=${path}`, `--content-type=${mime}`,
    '--cache-control=public, max-age=86400, stale-while-revalidate=604800',
    '--remote', '--force'
  ];

  return new Promise((resolveUpload, rejectUpload) => {
    const child = spawn(process.execPath, args, { cwd: resolve(root, 'infra/cloudflare'), windowsHide: true });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', rejectUpload);
    child.on('close', (code) => {
      if (code !== 0) return rejectUpload(new Error(error.trim() || `wrangler exited with ${code}`));
      state.completed[key] = signature;
      completed += 1;
      if (completed % 10 === 0 || completed === files.length) {
        saveState();
        console.log(`Uploaded ${completed}/${files.length}`);
      }
      resolveUpload(true);
    });
  });
}

async function worker(queue) {
  while (queue.length && !failed) {
    const path = queue.shift();
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await upload(path);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 2000));
      }
    }
    if (lastError) {
      failed = true;
      console.error(`Upload failed: ${relative(publicRoot, path)}`);
      console.error(lastError.message);
    }
  }
}

const queue = [...files];
await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
saveState();
if (failed) process.exit(1);
console.log(`R2 upload complete: ${files.length} files in ${bucket}`);
