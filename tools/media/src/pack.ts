/**
 * npm run media:pack -- --only id,id --name motion-pilot-79 [--title "…"] [--note file.md]
 *
 * Review pack for the owner and the agency (#79, #80): the final clips (blinks sped up where media:process did
 * so), their 480p drafts, the stills each clip starts and ends on with their likeness scores, the media:check
 * report, and a one-page HTML contact sheet that opens from disk. It holds the talent's likeness, so it is written
 * only to the private agency area (assets/agency/review/<name>/, gitignored) and never published.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OUT, renderedLastFrame, stillFile } from './generate';
import { KEYFRAMES, loadRecord } from './keyframes';
import { SHOTS, anchorsOf, type Anchor, type Shot } from './manifest';
import { clipFile, rawFile, type MotionReport } from './motion';
import { AGENCY } from './refs';

const exec = promisify(execFile);

export interface PackStill { role: 'first' | 'last'; label: string; file: string; likeness?: number; hair?: number }
export interface PackClip {
  id: string; use: string; duration: number; video: string; draft?: string; poster: string;
  stills: PackStill[]; check?: MotionReport; draftCheck?: MotionReport; retimed: boolean; attempts: number;
}
export interface Pack { title: string; at: string; note?: string; clips: PackClip[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const verdict = (c?: MotionReport) => (c ? `${c.ok ? '✓ pass' : '✗ fail'}${c.problems?.length ? ` — ${c.problems.join('; ')}` : ''}` : '—');

/** Contact sheet: one card per clip (video, stills, numbers), readable offline, light and dark. */
export function renderPack(p: Pack): string {
  const rows = p.clips.map((c) => {
    const k = c.check;
    const facts = [
      ['Length', `${c.duration} s`],
      ['media:check', verdict(k)],
      ['Blinks', k?.blinks.length ? k.blinks.map((b) => `${b.duration}s @${b.at}s`).join(', ') : '—'],
      ['Loop seam', k?.loopSeam !== undefined ? String(k.loopSeam) : '—'],
      ['Chain seam', k?.chainSeam ? `${k.chainSeam.diff} after ${k.chainSeam.after}` : '—'],
      ['Likeness (frames)', k?.likeness ? k.likeness.scores.join(' / ') : '—'],
      ['Draft check', verdict(c.draftCheck)],
      ['Renders', `${c.attempts} final${c.retimed ? ', blinks sped up in post' : ''}`]
    ];
    const stills = c.stills.map((s) => `<figure><img src="${esc(s.file)}" alt="${esc(s.label)}" loading="lazy"><figcaption>${s.role === 'first' ? 'First' : 'Last'} frame · ${esc(s.label)}${s.likeness !== undefined ? ` · likeness ${s.likeness}` : ''}${s.hair !== undefined ? ` · hair ${s.hair}` : ''}</figcaption></figure>`).join('');
    return `<article id="${esc(c.id)}"><h2>${esc(c.id)}</h2><p class="use">${esc(c.use)}</p>
<div class="row"><video src="${esc(c.video)}" poster="${esc(c.poster)}" controls loop muted playsinline preload="metadata"></video>
<div class="side"><dl>${facts.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>${c.draft ? `<p class="small"><a href="${esc(c.draft)}">480p draft</a></p>` : ''}<div class="stills">${stills}</div></div></div></article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title><style>
:root{--bg:#f6f5f8;--fg:#1d1f33;--muted:#5d6075;--card:#fff;--line:#dfdde6;--accent:#b0566a}
@media (prefers-color-scheme:dark){:root{--bg:#13152a;--fg:#ecebf3;--muted:#a3a5ba;--card:#1d2040;--line:#2e3258;--accent:#e39aab}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Hiragino Sans",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}.meta,.use,.small{color:var(--muted)}
.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;white-space:pre-wrap}
article{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:18px 0}h2{margin:0;font-size:17px;color:var(--accent)}
.row{display:flex;gap:18px;flex-wrap:wrap}video{width:300px;max-width:100%;border-radius:8px;background:#000;aspect-ratio:9/16}
.side{flex:1;min-width:260px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0 0 10px}dt{color:var(--muted)}dd{margin:0}
.stills{display:flex;gap:10px;flex-wrap:wrap}figure{margin:0;width:150px}figure img{width:100%;border-radius:6px;display:block}figcaption{font-size:12px;color:var(--muted)}
a{color:var(--accent)}</style></head><body><main><h1>${esc(p.title)}</h1><p class="meta">Private review pack — contains the talent's likeness; do not share outside the owner and the agency. Built ${esc(p.at)}.</p>
${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
${rows}
</main></body></html>
`;
}

const toJpg = (src: string, out: string) => exec('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', "scale='min(720,iw)':-2", '-q:v', '3', out]);

async function stillFor(a: Anchor, role: 'first' | 'last', shot: Shot, dir: string): Promise<PackStill | null> {
  const name = 'keyframe' in a ? a.keyframe : 'still' in a ? a.still : `${a.rendered} (rendered last frame)`;
  const src = 'keyframe' in a ? await pickOf(a.keyframe) : 'still' in a ? await stillFile(a.still) : await renderedLastFrame(a.rendered, false);
  if (!src) return null;
  const file = `stills/${shot.id}-${role}.jpg`;
  await toJpg(src, join(dir, file));
  const rec = 'keyframe' in a ? await loadRecord(a.keyframe) : null;
  const v = rec?.candidates.find((c) => c.file === rec.pick)?.verdict;
  return { role, label: name, file, ...(v ? { likeness: v.score, hair: v.hair } : {}) };
}

async function pickOf(name: string): Promise<string | undefined> {
  const pick = (await loadRecord(name))?.pick;
  return pick ? join(KEYFRAMES, pick) : undefined;
}

const readJson = async <T>(f: string): Promise<T | undefined> => (existsSync(f) ? (JSON.parse(await readFile(f, 'utf8')) as T) : undefined);

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const ids = arg('--only')?.split(',');
  const name = arg('--name');
  if (!ids || !name || !/^[a-z0-9-]+$/.test(name)) throw new Error('usage: media:pack -- --only id,id --name <kebab-name> [--title …] [--note file]');
  const dir = join(AGENCY, 'review', name);
  await mkdir(join(dir, 'stills'), { recursive: true });
  await mkdir(join(dir, 'clips'), { recursive: true });
  const state = (await readJson<Record<string, { attempts?: number }>>(join(OUT, 'state.json'))) ?? {};
  const clips: PackClip[] = [];
  for (const id of ids) {
    const shot = SHOTS.find((s) => s.id === id);
    if (!shot) throw new Error(`unknown shot ${id}`);
    const src = clipFile(id, false, true);
    if (!existsSync(src)) { console.log(`- ${id}: no final yet`); continue; }
    const video = `clips/${id}.mp4`, poster = `stills/${id}-poster.jpg`;
    await copyFile(src, join(dir, video));
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '3', join(dir, poster)]);
    let draft: string | undefined;
    if (existsSync(rawFile(id, true))) { draft = `clips/${id}.draft.mp4`; await copyFile(rawFile(id, true), join(dir, draft)); }
    const { first, last } = anchorsOf(shot);
    const stills = (await Promise.all([first && stillFor(first, 'first', shot, dir), last && stillFor(last, 'last', shot, dir)])).filter((s): s is PackStill => !!s);
    const retimed = src.includes('/retimed/');
    clips.push({
      id, use: shot.use, duration: shot.duration, video, draft, poster, stills, retimed, attempts: state[id]?.attempts ?? 1,
      check: await readJson<MotionReport>(join(OUT, 'check', `${id}${retimed ? '.retimed' : ''}.json`)) ?? await readJson<MotionReport>(join(OUT, 'check', `${id}.json`)),
      draftCheck: await readJson<MotionReport>(join(OUT, 'check', `${id}.draft.json`))
    });
    console.log(`+ ${id}`);
  }
  const note = arg('--note') ? await readFile(resolve(arg('--note')!), 'utf8') : undefined;
  const pack: Pack = { title: arg('--title') ?? name, at: new Date().toISOString(), note, clips };
  await writeFile(join(dir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  await writeFile(join(dir, 'index.html'), renderPack(pack));
  console.log(`review pack: ${dir}/index.html (private; never commit or publish)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
