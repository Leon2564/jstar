import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const source = resolve(root, 'apps/web/dist');
const target = resolve(root, 'apps/web/dist-cloudflare');
const r2Directories = new Set(['audio', 'cards', 'gifts', 'icons', 'media', 'voice']);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, {
  recursive: true,
  filter(path) {
    const rel = relative(source, path);
    if (!rel) return true;
    return !r2Directories.has(rel.split(sep)[0]);
  }
});

console.log(`Prepared Worker assets at ${target}`);
