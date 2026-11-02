/**
 * npm run media:talent -- <command>
 *
 * Getting a talent into Seedance's private real-human library (docs/asset-bible.md §5). Two routes:
 *
 *  A. Console (free "Basic Creation Rights"): ModelArk Playground → My assets → Real-human → create a group
 *     and share the QR code; the talent verifies on her phone and uploads her photos; we accept. Then:
 *       add <star> <asset-id> [--kind face|body|other]      register each accepted asset ID
 *
 *  B. API ("Advanced Creation Rights" + the IAM policy in docs/asset-bible.md on the AK/SK):
 *       onboard <star>                                       everything below in one go, then generate and publish
 *       invite <star> [--callback URL] [--lang en]           liveness link for the talent to open (valid 30 min)
 *       confirm <star> [--wait]                              after she finishes: store her asset group ID
 *       upload <star> [--base https://…]                     upload assets/refs/<star>/*; without --base the photos go
 *                                                            to the private TOS bucket as one-hour presigned URLs
 *       refresh <star>                                       poll processing status until Active / Failed
 *
 *  C. Virtual library (no liveness; confirmed with BytePlus for our contract-authorised talents, 2026-09-24):
 *       virtual <star|all>                                   AIGC group per talent, photos from assets/refs/<star>/
 *                                                            via a temporary unguessable link, default moderation
 *       refs <star|all>                                      re-register her identity from the agency's 4K frames
 *                                                            (assets/agency/refs: front, smiling, 3/4 both sides, profile);
 *                                                            replaces the v1 character-sheet crops in the registry
 *       keyframes <star|all> [--pick hero-16x9=b,…]          approved gpt-image keyframes (default: the judge's pick,
 *                                                            out/keyframes/v2/<id>.json) → the assets that open and
 *                                                            close each loop
 *       keyframes <star> --motion eimi-seated-9x16[=b],…     motion-pilot stills of her (#79) → assets named after the
 *                                                            still, which Shot.frames refers to
 *
 *  status                                                    what each talent has, and which shots can run
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT, ROOT, checkReference, orderReferences, readEnv } from './generate';
import { ENTER_KINDS, KEYFRAMES, V1_ANCHORS, loadRecord, pickIdentityRefs } from './keyframes';
import { COMPANION_SHOTS, MOTION_KEYFRAMES, SHOTS, STARS, type Star } from './manifest';
import { REFS, type Ref } from './refs';
import { createOpenApi, type OpenApi } from './openapi';
import { isAssetId, loadRegistry, referenceAssets, registryPath, saveRegistry, type AssetKind, type Registry } from './talents';
import { hostPrivately, type TosConfig } from './tos';
import { publishViaRelay, relayConfig } from './relay';
import { publishTemporarily } from './tunnel';

const exec = promisify(execFile);
const SESSIONS = join(OUT, 'talent-sessions.json');
const TOKEN_TTL_MS = 30 * 60 * 1000;
/** Asset groups, assets and inference endpoints must share one project (ours: ARK_PROJECT in .env.seedance). */
let PROJECT = 'default';
type Log = (m: string) => void;

export const kindFromFile = (f: string): AssetKind => (/face|portrait/i.test(f) ? 'face' : /body/i.test(f) ? 'body' : 'other');

/** Joins a public base URL and a file name without doubling or dropping the slash. */
export function assetUrl(base: string, file: string): string {
  if (!/^https:\/\//.test(base)) throw new Error('--base must be an https URL the BytePlus servers can reach');
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(file)}`;
}

export function summarize(reg: Registry): string[] {
  return STARS.map((star) => {
    const e = reg[star];
    const usable = referenceAssets(e).length;
    const shots = SHOTS.filter((s) => s.talent === star).length;
    const state = usable ? `ready: ${usable} reference(s) → ${shots} shots can run` : e.groupId ? 'verified, no active assets yet' : 'not verified';
    return `${star.padEnd(7)} group=${e.groupId ?? '—'}  assets=${e.assets.map((a) => `${a.id}(${a.kind}${a.status ? `/${a.status}` : ''})`).join(', ') || '—'}  ${state}`;
  });
}

type Sessions = Record<string, { token: string; link: string; at: number }>;
const readSessions = async (): Promise<Sessions> => (existsSync(SESSIONS) ? JSON.parse(await readFile(SESSIONS, 'utf8')) : {});

async function invite(api: OpenApi, star: Star, callback: string | undefined, lang: string | undefined, log: Log): Promise<string> {
  const r = await api<{ BytedToken: string; H5Link: string }>('CreateVisualValidateSession', { CallbackURL: callback ?? process.env.ARK_VERIFY_CALLBACK ?? 'https://example.com/jstar/verified', ProjectName: PROJECT });
  // The H5 page speaks zh, zh-Hant or en; English is the closest for the talents.
  const link = `${r.H5Link}${r.H5Link.includes('?') ? '&' : '?'}lng=${lang ?? 'en'}`;
  const all = await readSessions();
  all[star] = { token: r.BytedToken, link, at: Date.now() };
  await mkdir(OUT, { recursive: true });
  await writeFile(SESSIONS, JSON.stringify(all, null, 2));
  log(`Send this link to ${star} (valid 30 minutes). She confirms who is asking, agrees, and does a short face check on her phone:\n\n${link}\n`);
  return link;
}

/** Stores her asset group. With `wait`, keeps asking until she has finished (or the 30-minute token expires). */
async function confirm(api: OpenApi, reg: Registry, star: Star, wait: boolean, log: Log): Promise<string> {
  const s = (await readSessions())[star];
  if (!s) throw new Error(`no invite for ${star}: run invite first`);
  for (;;) {
    if (Date.now() - s.at > TOKEN_TTL_MS) throw new Error('the invite expired (30 min); run invite again');
    try {
      const r = await api<{ GroupId: string }>('GetVisualValidateResult', { BytedToken: s.token, ProjectName: PROJECT });
      if (r.GroupId) {
        reg[star].groupId = r.GroupId;
        await saveRegistry(registryPath(ROOT), reg);
        log(`✓ ${star} verified → group ${r.GroupId}`);
        return r.GroupId;
      }
    } catch (e) {
      if (!wait) throw e;
    }
    if (!wait) throw new Error(`${star} has not finished verification yet`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function upload(api: OpenApi, reg: Registry, star: Star, base: string | undefined, log: Log) {
  const group = reg[star].groupId;
  if (!group) throw new Error(`${star} has no asset group: invite + confirm first (or use the console route and \`add\`)`);
  const env = await readEnv();
  const tos: TosConfig | null = env.TOS_BUCKET ? { ak: env.ARK_AK, sk: env.ARK_SK, bucket: env.TOS_BUCKET, endpoint: env.TOS_ENDPOINT, region: env.TOS_REGION } : null;
  if (!base && !tos) throw new Error('set TOS_BUCKET in .env.seedance (private hosting) or pass --base <public https URL of assets/refs/<star>>');
  const dir = join(ROOT, 'assets/refs', star);
  for (const f of orderReferences(await readdir(dir))) {
    if (reg[star].assets.some((a) => a.source === f)) { log(`= ${f} already uploaded`); continue; }
    const path = join(dir, f);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]);
    const [w, h] = stdout.trim().split(',').map(Number);
    const check = checkReference(w, h, statSync(path).size);
    if (!check.ok) { log(`! ${f}: ${check.reason}`); continue; }
    const url = base ? assetUrl(base, f) : await hostPrivately(tos!, `talent-refs/${star}/${f}`, await readFile(path), MIME[extname(f).toLowerCase()] ?? 'application/octet-stream');
    // Default moderation stays on: the product stays inside its 写真级 boundary (docs/JSTAR-关键产品决策.md).
    const r = await api<{ Id: string }>('CreateAsset', { GroupId: group, URL: url, AssetType: 'Image', Name: `${star}-${f}`.slice(0, 64), ProjectName: PROJECT });
    reg[star].assets.push({ id: r.Id, kind: kindFromFile(f), status: 'Processing', source: f });
    await saveRegistry(registryPath(ROOT), reg);
    log(`+ ${f} → ${r.Id}`);
  }
  await poll(api, reg, star, log);
}

async function poll(api: OpenApi, reg: Registry, star: Star, log: Log, timeoutMs = 15 * 60 * 1000) {
  const started = Date.now();
  for (;;) {
    let pending = 0;
    for (const a of reg[star].assets) {
      if (a.status === 'Active' || a.status === 'Failed' || a.status === undefined) continue;
      const r = await api<{ Status: string }>('GetAsset', { Id: a.id, ProjectName: PROJECT });
      a.status = r.Status;
      if (r.Status !== 'Active' && r.Status !== 'Failed') pending++;
      else log(`  ${a.id} ${a.source ?? ''} → ${r.Status}${r.Status === 'Failed' ? ' (not the same face as the verification, or several faces in the photo)' : ''}`);
    }
    await saveRegistry(registryPath(ROOT), reg);
    if (!pending) return;
    if (Date.now() - started > timeoutMs) { log(`  still processing: run \`refresh ${star}\` later`); return; }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * Route C: the talent's reference photos go into her own AIGC (virtual library) group. Basis: BytePlus
 * confirmed this route for our signed, AI-authorised talents (docs/asset-bible.md §5). Moderation stays default.
 */
async function virtual(api: OpenApi, reg: Registry, star: Star, log: Log) {
  const dir = join(ROOT, 'assets/refs', star);
  const files = orderReferences(await readdir(dir)).map((f) => ({ path: join(dir, f), source: f, kind: kindFromFile(f) }));
  if (!files.length) throw new Error(`no photos in assets/refs/${star}/`);
  await uploadToGroup(api, reg, star, files, log);
}

/** Keyframe kinds (media:keyframes) → the character loop each one opens and closes (same id: <star>-<kind>). */
export const KEYFRAME_SHOT: Record<string, (star: Star) => string> = Object.fromEntries([...COMPANION_SHOTS.map((c) => c.kind), ...ENTER_KINDS, ...V1_ANCHORS].map((k) => [k, (s: Star) => `${s}-${k}`]));

/** Parses "hero-16x9=a,hero-day-9x16=c"; kinds not named keep `defaults` (the judge's picks), else candidate a. */
export function parsePicks(arg: string | undefined, defaults: Record<string, string> = {}): Record<string, string> {
  const picks: Record<string, string> = Object.fromEntries(Object.keys(KEYFRAME_SHOT).map((k) => [k, defaults[k] ?? 'a']));
  for (const part of (arg ?? '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!(k in KEYFRAME_SHOT) || !/^[a-z]$/.test(v ?? '')) throw new Error(`bad pick "${part}" (e.g. hero-16x9=b)`);
    picks[k] = v;
  }
  return picks;
}

/** Approved keyframes (out/keyframes/v2/<star>-<kind>-<letter>.png) become assets in her group, one per loop. */
async function keyframes(api: OpenApi, reg: Registry, star: Star, pickArg: string | undefined, log: Log) {
  const judged: Record<string, string> = {};
  for (const kind of Object.keys(KEYFRAME_SHOT)) {
    const pick = (await loadRecord(`${star}-${kind}`))?.pick;
    if (pick) judged[kind] = pick.replace(/\.png$/, '').slice(-1);
  }
  const picks = parsePicks(pickArg, judged);
  const files = Object.entries(picks)
    .map(([kind, letter]) => ({ path: join(KEYFRAMES, `${star}-${kind}-${letter}.png`), source: `keyframe-v2:${kind}:${letter}`, kind: 'keyframe' as const, shot: KEYFRAME_SHOT[kind](star) }))
    .filter((f) => existsSync(f.path));
  if (!files.length) throw new Error(`no keyframes for ${star}: run npm run media:keyframes -- --only ${star}`);
  // A new pick replaces the previous keyframe of that shot.
  for (const f of files) reg[star].assets = reg[star].assets.filter((a) => !(a.kind === 'keyframe' && a.shot === f.shot && a.source !== f.source));
  await uploadToGroup(api, reg, star, files, log);
}

/** Parses "eimi-seated-9x16,eimi-gown-9x16=b" into still → candidate letter (undefined: the recorded pick). */
export function parseMotionPicks(arg: string): { name: string; letter?: string }[] {
  return arg.split(',').filter(Boolean).map((part) => {
    const [name, letter] = part.split('=');
    if (!MOTION_KEYFRAMES.some((m) => m.name === name)) throw new Error(`unknown motion keyframe "${name}"`);
    if (letter !== undefined && !/^[a-z]$/.test(letter)) throw new Error(`bad pick "${part}" (e.g. eimi-gown-9x16=b)`);
    return { name, letter };
  });
}

/** Motion-pilot stills with her in them become keyframe assets named after the still (Shot.frames refers to them). */
async function motionKeyframes(api: OpenApi, reg: Registry, star: Star, arg: string, log: Log) {
  const files = [];
  for (const { name, letter } of parseMotionPicks(arg)) {
    const mk = MOTION_KEYFRAMES.find((m) => m.name === name)!;
    if (mk.star !== star) throw new Error(`${name} is ${mk.star}'s, not ${star}'s`);
    if (!mk.person) { log(`= ${name}: people-free, sent inline (no asset needed)`); continue; }
    const file = letter ? `${name}-${letter}.png` : (await loadRecord(name))?.pick;
    if (!file || !existsSync(join(KEYFRAMES, file))) throw new Error(`no picked keyframe for ${name}: run npm run media:keyframes -- --motion ${name}`);
    files.push({ path: join(KEYFRAMES, file), source: `keyframe-motion:${name}:${file.replace(/\.png$/, '').slice(-1)}`, kind: 'keyframe' as const, shot: name });
  }
  for (const f of files) reg[star].assets = reg[star].assets.filter((a) => !(a.kind === 'keyframe' && a.shot === f.shot && a.source !== f.source));
  if (files.length) await uploadToGroup(api, reg, star, files, log);
}

/** Identity views for the asset library: the keyframe trio plus the other three-quarter side and a profile. */
export function libraryRefs(refs: Ref[]): Ref[] {
  const chosen = pickIdentityRefs(refs);
  const has = (v: Ref['view']) => chosen.some((r) => r.view === v);
  const best = (v: Ref['view']) => refs.filter((r) => r.view === v).sort((a, b) => b.quality - a.quality)[0];
  for (const v of ['left34', 'right34', 'profile'] as const) if (!has(v) && best(v)) chosen.push(best(v));
  return chosen;
}

/**
 * Re-registers her identity from the agency's 4K frames. The v1 face/body assets (character-sheet crops) leave
 * the registry, so every later reference-mode shot uses only the new ones; they stay in the BytePlus group.
 */
async function agencyRefs(api: OpenApi, reg: Registry, star: Star, log: Log) {
  const { refs } = JSON.parse(await readFile(join(REFS, star, 'refs.json'), 'utf8')) as { refs: Ref[] };
  const chosen = libraryRefs(refs);
  if (!chosen.length) throw new Error(`no agency references for ${star} (run npm run media:refs)`);
  reg[star].assets = reg[star].assets.filter((a) => a.kind === 'keyframe' || a.source?.startsWith('agency:'));
  const files = chosen.map((r) => ({ path: join(REFS, star, r.file), source: `agency:${r.file}`, kind: 'face' as const }));
  await uploadToGroup(api, reg, star, files, log);
}

/**
 * Uploads files into the talent's AIGC group through a temporary link. Basis for the virtual library:
 * BytePlus confirmed this route for our signed, AI-authorised talents (docs/asset-bible.md §5).
 * Moderation stays default.
 */
async function uploadToGroup(api: OpenApi, reg: Registry, star: Star, files: { path: string; source: string; kind: AssetKind; shot?: string }[], log: Log) {
  if (!reg[star].groupId || reg[star].groupType !== 'AIGC') {
    const r = await api<{ Id: string }>('CreateAssetGroup', { Name: `JSTAR ${star}`, Description: 'JSTAR First Five talent, contract-authorised for AI generation', GroupType: 'AIGC', ProjectName: PROJECT });
    reg[star].groupId = r.Id;
    reg[star].groupType = 'AIGC';
    await saveRegistry(registryPath(ROOT), reg);
    log(`+ group ${r.Id}`);
  }
  const todo = [];
  for (const f of files) {
    if (reg[star].assets.some((a) => a.source === f.source && a.status !== 'Failed')) { log(`= ${f.source} already uploaded`); continue; }
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f.path]);
    const [w, h] = stdout.trim().split(',').map(Number);
    const check = checkReference(w, h, statSync(f.path).size);
    if (check.ok) todo.push(f); else log(`! ${f.source}: ${check.reason}`);
  }
  if (!todo.length) return;
  // R2 relay when configured (JSTAR_RELAY_URL; see relay.ts), else a cloudflared quick tunnel.
  const relay = await relayConfig();
  const pub = relay ? await publishViaRelay(todo.map((f) => f.path), log, relay) : await publishTemporarily(todo.map((f) => f.path), log);
  try {
    for (const f of todo) {
      const r = await api<{ Id: string }>('CreateAsset', { GroupId: reg[star].groupId, URL: pub.urlFor(f.path), AssetType: 'Image', Name: `${star}-${f.source}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64), ProjectName: PROJECT });
      reg[star].assets = reg[star].assets.filter((a) => a.source !== f.source);
      reg[star].assets.push({ id: r.Id, kind: f.kind, status: 'Processing', source: f.source, ...(f.shot ? { shot: f.shot } : {}) });
      await saveRegistry(registryPath(ROOT), reg);
      log(`+ ${f.source} → ${r.Id}`);
    }
    // Keep the link up until the platform has fetched and processed every file.
    await poll(api, reg, star, log);
  } finally {
    await pub.close();
    log(relay ? '  relay objects deleted' : '  temporary link closed');
  }
}

/** Route B end to end: link → her verification → photos → Active assets → her shots on the site. */
async function onboard(api: OpenApi, reg: Registry, star: Star, callback: string | undefined, lang: string | undefined, log: Log) {
  if (!reg[star].groupId) {
    await invite(api, star, callback, lang, log);
    log('Waiting for her to finish (checks every 10 s, up to 30 min)…');
    await confirm(api, reg, star, true, log);
  }
  await upload(api, reg, star, undefined, log);
  if (!referenceAssets(reg[star]).length) throw new Error(`${star} has no active assets; check the photos (clear, single face, same person) and run upload again`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const ids = SHOTS.filter((s) => s.talent === star).map((s) => s.id).join(',');
  log(`Generating ${ids}…`);
  await exec(npm, ['run', 'gen', '--', '--only', ids, '--concurrency', '4'], { cwd: resolve(ROOT, 'tools/media'), maxBuffer: 1 << 24 });
  await exec(npm, ['run', 'process'], { cwd: resolve(ROOT, 'tools/media'), maxBuffer: 1 << 24 });
  log(`✓ ${star} is on the site (apps/web/src/data/media.gen.ts and media.scene.gen.ts updated)`);
}

async function main() {
  const [cmd, starArg, ...rest] = process.argv.slice(2);
  const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const log: Log = (m) => console.log(m);
  const reg = await loadRegistry(registryPath(ROOT));
  const star = starArg as Star;
  const needStar = () => { if (!STARS.includes(star)) throw new Error(`unknown talent "${starArg}" (one of ${STARS.join(', ')})`); };
  const api = async () => { const env = await readEnv(); PROJECT = env.ARK_PROJECT || 'default'; return createOpenApi(env.ARK_AK, env.ARK_SK); };

  switch (cmd) {
    case undefined:
    case 'status':
      summarize(reg).forEach(log);
      return;
    case 'add': {
      needStar();
      const ids = rest.filter(isAssetId);
      if (!ids.length) throw new Error('usage: add <star> <asset-id> [more ids] [--kind face|body|other]');
      const kind = (opt('--kind') as AssetKind | undefined) ?? 'face';
      for (const id of ids) if (!reg[star].assets.some((a) => a.id === id)) reg[star].assets.push({ id, kind, source: 'console' });
      await saveRegistry(registryPath(ROOT), reg);
      break;
    }
    case 'invite':
      needStar();
      await invite(await api(), star, opt('--callback'), opt('--lang'), log);
      log(`Then run: npm run media:talent -- confirm ${star} --wait`);
      return;
    case 'confirm':
      needStar();
      await confirm(await api(), reg, star, rest.includes('--wait'), log);
      break;
    case 'upload':
      needStar();
      await upload(await api(), reg, star, opt('--base'), log);
      break;
    case 'refresh':
      needStar();
      await poll(await api(), reg, star, log);
      break;
    case 'virtual': {
      const client = await api();
      for (const s of starArg === 'all' ? STARS : [star]) {
        if (!STARS.includes(s)) throw new Error(`unknown talent "${starArg}"`);
        log(`▸ ${s}`);
        await virtual(client, reg, s, log);
      }
      summarize(reg).forEach(log);
      return;
    }
    case 'refs': {
      const client = await api();
      for (const s of starArg === 'all' ? STARS : [star]) {
        if (!STARS.includes(s)) throw new Error(`unknown talent "${starArg}"`);
        log(`▸ ${s}`);
        await agencyRefs(client, reg, s, log);
      }
      summarize(reg).forEach(log);
      return;
    }
    case 'keyframes': {
      const client = await api();
      for (const s of starArg === 'all' ? STARS : [star]) {
        if (!STARS.includes(s)) throw new Error(`unknown talent "${starArg}"`);
        log(`▸ ${s}`);
        if (opt('--motion')) await motionKeyframes(client, reg, s, opt('--motion')!, log);
        else await keyframes(client, reg, s, opt('--pick'), log);
      }
      summarize(reg).forEach(log);
      return;
    }
    case 'onboard':
      needStar();
      await onboard(await api(), reg, star, opt('--callback'), opt('--lang'), log);
      break;
    default:
      throw new Error(`unknown command "${cmd}" (status | add | invite | confirm | upload | refresh | onboard | virtual | refs | keyframes)`);
  }
  summarize(reg).filter((l) => l.startsWith(star)).forEach(log);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
