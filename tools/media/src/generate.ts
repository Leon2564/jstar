/**
 * npm run media:gen -- [--only id,id] [--category scene] [--concurrency 4] [--draft] [--redo] [--dry]
 *
 * Resumable: out/state.json remembers each shot's task id, seed and prompt hash. A rerun polls
 * unfinished tasks instead of paying for them twice, and regenerates a shot only if its prompt changed.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { appendFile, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ArkError, createClient, isDone, type ArkClient, type GenerationRequest } from './ark';
import { download } from './download';
import { MODELS, SHOTS, anchorsOf, hasPerson, validate, type Anchor, type Shot } from './manifest';
import { MAX_REFERENCE_IMAGES, keyframeAsset, loadRegistry, referenceAssets, registryPath, womanPhrase, type Registry } from './talents';

const exec = promisify(execFile);
export const ROOT = resolve(import.meta.dirname, '../../..');
export const OUT = resolve(import.meta.dirname, '../out');
const STATE = join(OUT, 'state.json');
/** --draft: Seedance 2.5 preview at low cost to check framing and motion before the final render. */
const DRAFT = process.argv.includes('--draft');
const REDO = process.argv.includes('--redo');

export interface ShotState { taskId?: string; status: string; seed?: number; hash: string; file?: string; error?: string; updatedAt: string; attempts?: number; tokens?: number }
export type State = Record<string, ShotState>;

// Frames join the fingerprint only when set, so every shot made before chaining keeps its hash (no re-render).
export const hashShot = (s: Shot) => createHash('sha256').update(JSON.stringify([s.model, s.ratio, s.resolution, s.duration, s.prompt, s.talent ?? '', ...(s.frames ? [anchorsOf(s)] : [])])).digest('hex').slice(0, 16);

/** What a rerun must do for a shot, given what was recorded last time. */
export function planFor(shot: Shot, prev: ShotState | undefined): 'skip' | 'poll' | 'create' {
  if (!prev || prev.hash !== hashShot(shot)) return 'create';
  if (prev.status === 'downloaded' && prev.file && existsSync(join(OUT, prev.file))) return 'skip';
  // A finished task keeps its result for 48 h: a lost file is fetched again rather than paid for twice.
  // 'error' means our side failed (network, disk) — the task itself may be fine, so look before paying again.
  if (prev.taskId && ['queued', 'running', 'succeeded', 'downloaded', 'error'].includes(prev.status)) return 'poll';
  return 'create';
}

/** Keys live in the main checkout; a worktree (.claude/worktrees/<name>) reads them from there. */
const ENV_FILE = [join(ROOT, '.env.seedance'), join(ROOT.replace(/\/\.claude\/worktrees\/[^/]+$/, ''), '.env.seedance')].find((f) => existsSync(f)) ?? join(ROOT, '.env.seedance');

export async function readEnv(file = ENV_FILE): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!existsSync(file)) return env;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] ??= m[2];
  }
  return env;
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_BYTES = 10 * 1024 * 1024;

export interface RefCheck { ok: boolean; reason?: string; resize?: boolean }

/** ModelArk accepts roughly 300–6000 px per side, aspect 0.4–2.5 and ~10 MB; checked before any credit is spent. */
export function checkReference(width: number, height: number, bytes: number): RefCheck {
  if (Math.min(width, height) < 300) return { ok: false, reason: `too small (${width}×${height}); use at least 300 px on the short side` };
  const aspect = width / height;
  if (aspect < 0.4 || aspect > 2.5) return { ok: false, reason: `aspect ${aspect.toFixed(2)} outside 0.4–2.5` };
  return { ok: true, resize: bytes > MAX_BYTES || Math.max(width, height) > 4096 };
}

/** Upload order for a talent's photos: portrait/face views first, then the rest alphabetically. */
export function orderReferences(files: string[]): string[] {
  const imgs = files.filter((f) => MIME[extname(f).toLowerCase()]);
  const portrait = imgs.filter((f) => /^portrait\./i.test(f));
  return [...portrait, ...imgs.filter((f) => !portrait.includes(f)).sort()];
}

/**
 * References for a character shot, as asset:// URIs from the registry. A locked loop sends its approved
 * keyframe as both first and last frame (Seedance allows no reference images next to a last frame). Other
 * shots put the keyframe first (Image 1, the opening frame) and her face assets after it to lock identity.
 */
export async function referenceImages(shot: Shot, registry?: Registry): Promise<GenerationRequest['images']> {
  if (shot.frames) return frameImages(shot, registry);
  if (!shot.talent) {
    // A locked scene returns to its own published poster; there are no people in it, so a data: URL is fine.
    const poster = join(ROOT, 'apps/web/public/media', shot.id, 'poster.jpg');
    if (!shot.lock || !existsSync(poster)) return [];
    const url = `data:image/jpeg;base64,${(await readFile(poster)).toString('base64')}`;
    return [{ url, role: 'first_frame' }, { url, role: 'last_frame' }];
  }
  const reg = registry ?? (await loadRegistry(registryPath(ROOT)));
  const entry = reg[shot.talent];
  const key = keyframeAsset(entry, shot.id);
  if (shot.lock) return key ? [{ url: `asset://${key.id}`, role: 'first_frame' }, { url: `asset://${key.id}`, role: 'last_frame' }] : [];
  const identity = referenceAssets(entry).slice(0, key ? 3 : MAX_REFERENCE_IMAGES);
  return [...(key ? [key] : []), ...identity].map((a) => ({ url: `asset://${a.id}`, role: 'reference_image' as const }));
}

/** The picked people-free still of a keyframe record (out/keyframes/v2/<name>.json), as a file path. */
export async function stillFile(name: string): Promise<string | undefined> {
  const rec = join(OUT, 'keyframes', 'v2', `${name}.json`);
  if (!existsSync(rec)) return undefined;
  const pick = (JSON.parse(await readFile(rec, 'utf8')) as { pick?: string }).pick;
  return pick && existsSync(join(OUT, 'keyframes', 'v2', pick)) ? join(OUT, 'keyframes', 'v2', pick) : undefined;
}

/**
 * The last frame a clip actually rendered (out/frames/<id>[.draft]-last.jpg), for clips chained after a clip
 * that ends empty. A draft chains onto the draft, a final onto the final, so each pair shares its exact frame.
 */
export async function renderedLastFrame(id: string, draft = DRAFT): Promise<string | undefined> {
  const raw = join(OUT, 'raw', `${stateKey(id, draft)}.mp4`);
  if (!existsSync(raw)) return undefined;
  const png = join(OUT, 'frames', `${stateKey(id, draft)}-last.jpg`);
  if (!existsSync(png) || statSync(png).mtimeMs < statSync(raw).mtimeMs) {
    await mkdir(join(OUT, 'frames'), { recursive: true });
    await exec('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.5', '-i', raw, '-update', '1', '-q:v', '2', png]);
  }
  return png;
}

/**
 * First/last frames from Shot.frames (chains already followed): her keyframes as asset:// from the registry,
 * people-free stills inline. Empty when any frame is missing, so the shot is skipped rather than half-anchored.
 */
async function frameImages(shot: Shot, registry?: Registry): Promise<GenerationRequest['images']> {
  const { first, last } = anchorsOf(shot);
  const reg = registry ?? (await loadRegistry(registryPath(ROOT)));
  const url = async (a: Anchor): Promise<string | undefined> => {
    if ('keyframe' in a) {
      const key = shot.talent ? keyframeAsset(reg[shot.talent], a.keyframe) : undefined;
      return key ? `asset://${key.id}` : undefined;
    }
    const file = 'still' in a ? await stillFile(a.still) : await renderedLastFrame(a.rendered);
    return file ? `data:${MIME[extname(file).toLowerCase()] ?? 'image/png'};base64,${(await readFile(file)).toString('base64')}` : undefined;
  };
  const out: NonNullable<GenerationRequest['images']> = [];
  for (const [a, role] of [[first, 'first_frame'], [last, 'last_frame']] as const) {
    if (!a) continue;
    const u = await url(a);
    if (!u) return [];
    out.push({ url: u, role });
  }
  return out;
}

/**
 * The prompt as sent: {WOMAN} names the reference images the way Seedance requires ("Image N").
 * With a keyframe, Image 1 is declared the first frame and the others identity references.
 */
export function promptFor(shot: Shot, imageCount: number, withKeyframe = false): string {
  if (shot.frames) {
    const { first, last } = anchorsOf(shot);
    if (!shot.talent) return `${shot.loop ? 'The first frame and the last frame are the same picture: start exactly from it and end exactly on it, so the clip loops seamlessly.' : 'Start exactly from the first frame and end exactly on the last frame.'}\n${shot.prompt}`;
    return shot.prompt.replace('{WOMAN}', hasPerson(first) && hasPerson(last) ? 'The woman in the first and last frames' : hasPerson(first) || !last ? 'The woman in the first frame' : 'The woman in the last frame');
  }
  if (shot.lock && !shot.talent) return `The first frame and the last frame are the same picture: start exactly from it and end exactly on it, so the clip loops seamlessly.\n${shot.prompt}`;
  if (!shot.prompt.includes('{WOMAN}')) return shot.prompt;
  if (shot.lock) return `The first frame and the last frame are the same photograph: start exactly from it and end exactly on it, so the clip loops seamlessly.\n${shot.prompt.replace('{WOMAN}', 'The woman in the first frame')}`;
  if (!withKeyframe) return shot.prompt.replace('{WOMAN}', womanPhrase(imageCount));
  const others = imageCount - 1;
  const ids = Array.from({ length: others }, (_, i) => `Image ${i + 2}`);
  const identity = others > 0 ? ` Images ${ids.length > 1 ? `${ids.slice(0, -1).join(', ').replace(/Image /g, '')} and ${others + 1}` : '2'} show the same woman's face for identity; keep her face exactly consistent with them.` : '';
  return `Image 1 is the first frame of the video; start exactly from it.${identity}\n${shot.prompt.replace('{WOMAN}', 'The woman in Image 1')}`;
}

/** Merges into what is on disk, so two runs working on different shots never erase each other's records. */
export function mergeState(onDisk: State, mine: State, touched: Iterable<string>): State {
  const out = { ...onDisk };
  for (const id of touched) if (mine[id]) out[id] = mine[id];
  return out;
}

const touched = new Set<string>();
let writing: Promise<void> = Promise.resolve();
/** Writes are queued (workers in this process share one file) and go through a per-process temp file. */
function saveState(state: State, id?: string): Promise<void> {
  if (id) touched.add(id);
  const tmp = `${STATE}.${process.pid}.tmp`;
  writing = writing.catch(() => {}).then(async () => {
    await mkdir(OUT, { recursive: true });
    const onDisk: State = existsSync(STATE) ? JSON.parse(await readFile(STATE, 'utf8')) : {};
    await writeFile(tmp, JSON.stringify(mergeState(onDisk, state, touched), null, 2));
    await rename(tmp, STATE);
  });
  return writing;
}

/** List price of Seedance 2.5 on ModelArk without video input (USD per token); logged per task for docs/SPEND.md. */
export const SD25_USD_PER_TOKEN = 10.7 / 1e6;
/** Output-side rejections ("may be related to copyright restrictions") are retried with a fresh seed. */
export const isRetryableRejection = (msg = '') => /copyright/i.test(msg);
export const MAX_ATTEMPTS = 3;

async function logSeedanceSpend(key: string, taskId: string, tokens: number | undefined, resolution: string) {
  if (!tokens) return;
  await mkdir(OUT, { recursive: true });
  await appendFile(join(OUT, 'spend.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), model: 'seedance-2.5', purpose: `video ${key} ${resolution}`, id: taskId, tokens, cost: Number((tokens * SD25_USD_PER_TOKEN).toFixed(4)) })}\n`);
}

/** Drafts are previews: their own state key and file, never picked up by media:process. */
export const stateKey = (id: string, draft = DRAFT) => (draft ? `${id}.draft` : id);

async function runShot(shot: Shot, state: State, client: ArkClient, env: Record<string, string>, log: (m: string) => void) {
  const key = stateKey(shot.id);
  const prev = state[key];
  // --redo: pay for a fresh take of a finished shot (e.g. the camera drifted and the loop jumps); new seed.
  const plan = REDO && prev?.status === 'downloaded' && prev.hash === hashShot(shot) ? 'create' : planFor(shot, prev);
  if (plan === 'skip') { log(`= ${shot.id} already downloaded`); return; }
  const hash = hashShot(shot);
  const stamp = () => new Date().toISOString();
  let taskId = plan === 'poll' ? prev!.taskId! : undefined;
  let attempts = plan === 'poll' ? prev!.attempts ?? 1 : 0;
  const create = async (freshSeed: boolean) => {
    const images = await referenceImages(shot);
    if ((shot.talent || shot.frames) && !images?.length) { log(`- ${shot.id} skipped: ${shot.frames ? 'a first/last frame is missing (media:keyframes -- --motion …, then media:talent -- keyframes <star> --motion …)' : `${shot.talent} has no ${shot.lock ? 'approved keyframe asset for this shot (media:keyframes → media:talent keyframes)' : 'verified real-human assets yet'}`} (npm run media:talent -- status)`); state[key] = { status: 'needs-assets', hash, updatedAt: stamp() }; await saveState(state, key); return undefined; }
    const model = env[MODELS[shot.model]];
    if (!model) throw new Error(`${MODELS[shot.model]} missing in .env.seedance`);
    const withKey = !!(shot.talent && !shot.frames && images?.[0] && keyframeAsset((await loadRegistry(registryPath(ROOT)))[shot.talent], shot.id));
    // The final render reuses the approved draft's seed so it stays as close as possible to what was reviewed;
    // a retry after an output-side rejection needs a new one.
    const seed = DRAFT || freshSeed ? undefined : state[stateKey(shot.id, true)]?.seed;
    // With a first frame the output takes the keyframe's own aspect ratio (Seedance refuses an explicit one).
    const ratio = images?.some((i) => i.role === 'first_frame') ? 'adaptive' : shot.ratio;
    const id = await client.create({ model, prompt: promptFor(shot, images?.length ?? 0, withKey), ratio, draft: DRAFT, seed, duration: shot.duration, resolution: DRAFT ? '480p' : shot.resolution, images });
    attempts++;
    state[key] = { taskId: id, status: 'queued', hash, attempts, updatedAt: stamp() };
    await saveState(state, key);
    log(`+ ${key} → ${id}${attempts > 1 ? ` (attempt ${attempts}, new seed)` : ''}`);
    return id;
  };
  if (!taskId) taskId = await create(REDO);
  if (!taskId) return;
  for (let misses = 0; ; ) {
    let task;
    try {
      task = await client.get(taskId);
      misses = 0;
    } catch (e) {
      // Polling runs for minutes over a flaky link; only give up after a sustained outage.
      if (++misses > 12) throw e;
      await new Promise((r) => setTimeout(r, 5_000 * misses));
      continue;
    }
    if (isDone(task.status)) {
      if (task.status !== 'succeeded' || !task.content?.video_url) {
        state[key] = { taskId, status: task.status, hash, attempts, error: task.error?.message ?? 'no video', updatedAt: stamp() };
        await saveState(state, key);
        log(`! ${shot.id} ${task.status}: ${task.error?.message ?? ''}`);
        if (isRetryableRejection(task.error?.message) && attempts < MAX_ATTEMPTS) {
          const next = await create(true);
          if (!next) return;
          taskId = next;
          continue;
        }
        return;
      }
      const tokens = task.usage?.total_tokens;
      if (prev?.taskId !== taskId || prev?.status !== 'downloaded') await logSeedanceSpend(key, taskId, tokens, DRAFT ? '480p' : shot.resolution);
      const file = `raw/${key}.mp4`;
      const bytes = await download(task.content.video_url, join(OUT, file));
      state[key] = { taskId, status: 'downloaded', seed: task.seed, hash, file, attempts, tokens, updatedAt: stamp() };
      await saveState(state, key);
      log(`✓ ${key} ${(bytes / 1e6).toFixed(1)} MB (seed ${task.seed})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const problems = validate(SHOTS);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const only = arg('--only')?.split(',');
  const category = arg('--category');
  const shots = SHOTS.filter((s) => (!only || only.includes(s.id)) && (!category || s.category === category));
  if (args.includes('--dry')) { for (const s of shots) console.log(`${s.id}\t${s.model}\t${s.ratio}\t${s.resolution}\t${s.duration}s\t${s.use}`); return; }

  const env = await readEnv();
  const client = createClient(env.ARK_API_KEY);
  const state: State = existsSync(STATE) ? JSON.parse(await readFile(STATE, 'utf8')) : {};
  const concurrency = Number(arg('--concurrency') ?? 4);
  const queue = [...shots];
  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let shot = queue.shift(); shot; shot = queue.shift()) {
      try { await runShot(shot, state, client, env, log); } catch (e) { log(`! ${shot.id} ${(e as Error).message}${e instanceof ArkError ? ` — ${e.body.slice(0, 300)}` : ''}`); const k = stateKey(shot.id); state[k] = { ...(state[k] ?? { hash: hashShot(shot) }), status: 'error', error: (e as Error).message, updatedAt: new Date().toISOString() }; await saveState(state, k); }
    }
  }));
  const summary = shots.map((s) => `${state[stateKey(s.id)]?.status ?? 'none'}`).reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
  log(`done ${JSON.stringify(summary)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) void main();
