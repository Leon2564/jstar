/**
 * Card art for Star Genesis · First Five (docs/catalog-spec.md).
 *
 *   npm run media:cards -- bake --ids s1-mahiro-26,s1-alice-26 --models gemini31,gpt2     model bake-off
 *   npm run media:cards -- run [--tier SSR] [--only mahiro] [--ids …] [--model gemini31]  generate → judge → publish
 *     (default model: image.cardArt in config/models.json)
 *   npm run media:cards -- publish <id> <candidate.png>                                  manual pick
 *   npm run media:cards -- review                                                        review.html + contact sheets
 *
 * Each card: 2 candidates from the talent's references (head crops from her agency clips) and the
 * catalog scene → each candidate judged (judge.ts line-up, 1–5) → best one at or above PASS is
 * confirmed with a second, re-shuffled line-up → published as card.webp / card-sm.webp / lock.webp.
 * Below the threshold it regenerates (up to 2 more rounds, feeding the judge's feature notes back
 * into the prompt) and is never shipped. Out of credit (HTTP 402 / key limit) stops cleanly.
 *
 * Candidates and judge notes: tools/media/cards/candidates/<id>/ (gitignored).
 * Committed record: tools/media/cards/results.json (prompt, model, scores per published card).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build, ROOT, type Card, type Tier } from './catalog';
import { STARS, type Star } from './manifest';
import { PASS, judge, modesty, type Verdict } from './judge';
import { IMAGE } from './models';
import { OutOfCredit, chat, images } from './openrouter';
import { REFS, type Ref } from './refs';

const exec = promisify(execFile);
export const CARDS_DIR = resolve(import.meta.dirname, '../cards');
const CANDS = join(CARDS_DIR, 'candidates');
const OUT_DIR = join(CARDS_DIR, 'out');
const RESULTS = join(CARDS_DIR, 'results.json');
const PUBLIC = join(ROOT, 'apps/web/public/cards');

/** Face and hair notes per talent, written from her agency clips (refs) — text backs up the images. */
export const LOOK: Record<Star, string> = {
  mahiro: 'a soft, rounded oval face with full cheeks and a short, gently rounded chin (not a long face); large round dark eyes with clear double eyelids and prominent puffy under-eye fullness (aegyo-sal); straight soft brows; a small soft nose; full pink lips with a defined cupid\'s bow; a sweet, warm smile. Hair: dark chocolate-brown, softly wavy, collarbone length, with thin, airy wispy bangs',
  nana: 'a small, soft oval face with a delicate chin; large clear eyes with gentle double eyelids and soft under-eye fullness; thin straight brows mostly hidden by bangs; a small straight nose; small, full lips; calm, gentle expression. Hair: very dark brown, long, with thin, airy straight bangs across the forehead',
  unpai: 'a soft oval face with a small pointed chin; large bright double-lidded eyes with a soft pink eye-makeup tone and under-eye fullness; a small refined nose; small full lips; a bright, playful smile. Hair: soft caramel / honey brown with a light warm tint — NOT bright orange, not ginger, not red — long and wavy, with wispy bangs and face-framing strands',
  alice: 'an oval face with a softly tapered, defined chin; large bright double-lidded eyes with under-eye fullness; a slim straight nose; full glossy lips; a shy, sincere smile. Hair: deep burgundy / wine-red, loosely tied back with long face-framing strands and wispy curtain bangs',
  eimi: 'a slim oval face with defined cheekbones and a neat chin; striking almond-shaped, slightly upturned eyes with sharp winged liner; defined brows; a small straight nose; full, well-shaped lips; a confident, knowing smile. Hair: jet-black, a sleek chin-length bob with side-swept bangs'
};

const TIER_FEEL: Record<Tier, string> = {
  N: 'An everyday, candid moment; framed from the waist or chest up so the setting reads clearly.',
  R: 'An outing; framed from the waist up with the location clearly visible behind her.',
  SR: 'A special date with cinematic light; framed from the chest up, the location beautifully out of focus.',
  SSR: 'An intimate close-up: framed tightly from the collarbones up, her face large and sharp, eye contact with the lens.',
  UR: 'Her signature portrait: framed from the chest up, the full signature scene around her, the most beautiful light of the set.'
};

/** The catalog scene without her name: the prompt identifies her only through the reference images. */
export const anonScene = (scene: string) => scene
  .replace(/\b(Mahiro|Nana|Unpai|Alice|Eimi)'s signature:\s*/g, 'Her signature scene: ')
  .replace(/\bof (Mahiro|Nana|Unpai|Alice|Eimi)\b/g, 'of the woman')
  .replace(/^(Mahiro|Nana|Unpai|Alice|Eimi)\b/, 'The woman')
  .replace(/\b(Mahiro|Nana|Unpai|Alice|Eimi)\b/g, 'she');

export function promptFor(card: Card, refCount: number, notes: string[] = []): string {
  return [
    `Reference images 1 to ${refCount} are photos of the same real Japanese woman in her twenties. Create a NEW photorealistic photograph of this exact woman.`,
    `Identity: keep her face an exact likeness of the references — ${LOOK[card.star]}. Do not idealize, slim, reshape or "beautify" her face; keep her eye size and shape, under-eye fullness, nose, lips and face length exactly as in the references. She must be instantly recognizable as the same person.`,
    'Ignore the clothing and accessories in the references (lace headbands, bows, chokers are costume, not part of her look).',
    `Scene: ${anonScene(card.scene)}.`,
    `${TIER_FEEL[card.tier]} Vertical 3:4 portrait, first-person point of view as if she is with you; she is looking into the lens unless the scene says otherwise.`,
    'Look: a Japanese photobook still, 85mm lens, shallow depth of field, natural light that fits the scene with a gentle rose-pink warmth, natural skin texture, subtle film grain, true-to-life colours.',
    notes.length ? `Correct these differences seen in an earlier attempt: ${notes.join('; ')}.` : '',
    'Constraints: exactly one person; no brand names or logos on clothing or equipment; she is an adult, fully and modestly clothed in a complete outfit (a top with trousers or a skirt reaching the knee, or a full-length dress) with a neckline that fully covers her chest — no low or V necklines, no bare thighs, nothing suggestive; natural hands; no text, no logo, no watermark, no frame or border.'
  ].filter(Boolean).join('\n');
}

/** Generation references: three frontals (different moments/expressions) and two three-quarter views. */
export async function genRefs(star: Star): Promise<string[]> {
  const { refs } = JSON.parse(await readFile(join(REFS, star, 'refs.json'), 'utf8')) as { refs: Ref[] };
  const fronts = refs.filter((r) => r.view === 'front');
  const picks: Ref[] = [];
  for (const r of fronts) if (picks.length < 3 && picks.every((p) => Math.abs(p.t - r.t) > 4 || p.source !== r.source)) picks.push(r);
  const threeQ = refs.filter((r) => r.view === 'left34' || r.view === 'right34').sort((a, b) => b.quality - a.quality);
  const left = threeQ.find((r) => r.view === 'left34'), right = threeQ.find((r) => r.view === 'right34');
  for (const r of [left, right, ...threeQ]) if (r && picks.length < 5 && !picks.includes(r)) picks.push(r);
  return picks.map((r) => join(REFS, star, r.file));
}

export async function refBuffers(star: Star): Promise<Buffer[]> {
  const cache = join(OUT_DIR, 'refs');
  await mkdir(cache, { recursive: true });
  return Promise.all((await genRefs(star)).map(async (f) => {
    const out = join(cache, `${star}-${basename(f)}`);
    if (!existsSync(out)) await exec('ffmpeg', ['-v', 'error', '-i', f, '-vf', "scale='min(768,iw)':-2", '-q:v', '3', '-y', out]);
    return readFile(out);
  }));
}

export interface ModelSpec { key: string; id: string; api: 'chat' | 'images'; size?: string; quality?: string }
export const MODELS: Record<string, ModelSpec> = {
  gemini31: { key: 'gemini31', id: 'google/gemini-3.1-flash-image', api: 'chat', size: '2K' },
  gemini25: { key: 'gemini25', id: 'google/gemini-2.5-flash-image', api: 'chat' },
  gemini3pro: { key: 'gemini3pro', id: 'google/gemini-3-pro-image', api: 'chat', size: '2K' },
  gpt2: { key: 'gpt2', id: 'openai/gpt-image-2', api: 'images', quality: 'medium' },
  seedream: { key: 'seedream', id: 'bytedance-seed/seedream-4.5', api: 'chat', size: '2K' }
};
/** The card-art model in config/models.json: its entry in the bake-off table above, or a spec built from the config. */
export const DEFAULT_MODEL: ModelSpec = Object.values(MODELS).find((m) => m.id === IMAGE.cardArt.model)
  ?? { key: 'config', id: IMAGE.cardArt.model, api: IMAGE.cardArt.api as ModelSpec['api'], quality: IMAGE.cardArt.quality };

async function generateOne(card: Card, model: ModelSpec, prompt: string, refs: Buffer[]): Promise<{ png: Buffer; cost: number }> {
  if (model.api === 'images') {
    const r = await images({ model: model.id, prompt, refs, aspect: '3:4', quality: model.quality, purpose: 'card art', id: card.id });
    return { png: r.images[0], cost: r.cost };
  }
  const parts = [
    { type: 'text' as const, text: prompt },
    ...refs.flatMap((b, i) => [{ type: 'text' as const, text: `Reference image ${i + 1}:` }, { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` } }])
  ];
  const r = await chat({ model: model.id, parts, purpose: 'card art', id: card.id, imageOut: { aspect: '3:4', size: model.size } });
  if (!r.images[0]) throw new Error(`${model.id}: no image returned (${r.text.slice(0, 160).replace(/\s+/g, ' ')})`);
  return { png: r.images[0], cost: r.cost };
}

export interface Candidate { file: string; model: string; round: number; prompt: string; genCost: number; verdict: Verdict; confirm?: Verdict; final?: number }
interface CardState { id: string; candidates: Candidate[]; published?: string; finalScore?: number; status: 'pending' | 'published' | 'failed' }

async function loadState(id: string): Promise<CardState> {
  const f = join(CANDS, id, 'state.json');
  return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { id, candidates: [], status: 'pending' };
}
const saveState = async (s: CardState) => { await mkdir(join(CANDS, s.id), { recursive: true }); await writeFile(join(CANDS, s.id, 'state.json'), JSON.stringify(s, null, 2)); };

/** Candidates are ranked by likeness, then hair, then fewer feature notes. */
const rank = (c: Candidate) => c.verdict.score * 10 + (c.verdict.hair ?? 3) + (c.verdict.quality ?? 3) - c.verdict.issues.length * 0.1 - (c.verdict.modest === false ? 100 : 0);

/** 63:88 centre crop (into apps/web/public/cards unless `root` says otherwise) → card.webp 1080×1508 q82, card-sm.webp 360×503 q78, lock.webp blurred and darkened. */
export async function publish(id: string, src: string, root = PUBLIC) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const tmp = join(OUT_DIR, 'tmp', id);
  await mkdir(tmp, { recursive: true });
  const [w, h] = (await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src])).stdout.trim().split(',').map(Number);
  const cw = Math.min(w, Math.round((h * 63) / 88)), ch = Math.min(h, Math.round((w * 88) / 63));
  // Horizontally centred; vertically biased to the top so a portrait keeps her head room.
  const crop = `crop=${cw}:${ch}:${Math.round((w - cw) / 2)}:${Math.round((h - ch) * 0.3)}`;
  const variants: [string, string, string][] = [
    ['card', `${crop},scale=1080:1508:flags=lanczos`, '82'],
    ['card-sm', `${crop},scale=360:503:flags=lanczos`, '78'],
    ['lock', `${crop},scale=360:503:flags=lanczos,gblur=sigma=18,eq=brightness=-0.18:saturation=0.7`, '60']
  ];
  for (const [name, vf, q] of variants) {
    const png = join(tmp, `${name}.png`);
    await exec('ffmpeg', ['-v', 'error', '-i', src, '-vf', vf, '-y', png]);
    await exec('cwebp', ['-quiet', '-q', q, '-metadata', 'none', png, '-o', join(dir, `${name}.webp`)]);
  }
  await rm(tmp, { recursive: true, force: true });
}

async function loadResults(): Promise<Record<string, unknown>> {
  return existsSync(RESULTS) ? JSON.parse(await readFile(RESULTS, 'utf8')) : {};
}
let resultsLock = Promise.resolve();
async function recordResult(id: string, entry: Record<string, unknown>) {
  resultsLock = resultsLock.then(async () => {
    const all = await loadResults();
    all[id] = entry;
    const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(RESULTS, `${JSON.stringify(sorted, null, 2)}\n`);
  });
  return resultsLock;
}

async function generateCandidates(card: Card, model: ModelSpec, round: number, n: number, notes: string[], log: (m: string) => void): Promise<Candidate[]> {
  const refs = await refBuffers(card.star);
  const prompt = promptFor(card, refs.length, notes);
  const out: Candidate[] = [];
  for (let k = 0; k < n; k++) {
    try {
      const { png, cost } = await generateOne(card, model, prompt, refs);
      const file = join(CANDS, card.id, `r${round}-${model.key}-${k + 1}.png`);
      await mkdir(join(CANDS, card.id), { recursive: true });
      await writeFile(file, png);
      const verdict = await judge(card.star, file, { id: card.id });
      out.push({ file: basename(file), model: model.id, round, prompt, genCost: cost, verdict });
      log(`  ${card.id} r${round} ${model.key}#${k + 1}: likeness ${verdict.score} (raw ${verdict.raw}${verdict.top ? '' : ', not top'}) hair ${verdict.hair ?? '?'}${verdict.modest === false ? ' [wardrobe ✗]' : ''} $${(cost + verdict.cost).toFixed(3)}${verdict.issues.length ? ` — ${verdict.issues.join('; ')}` : ''}`);
    } catch (e) {
      if (e instanceof OutOfCredit) throw e;
      log(`  ! ${card.id} r${round} ${model.key}#${k + 1}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return out;
}

/** Confirm the best passing, not-yet-confirmed candidates; publish the first whose two line-ups average ≥ PASS. */
async function tryPublish(card: Card, state: CardState, log: (m: string) => void): Promise<boolean> {
  for (const c of [...state.candidates].sort((a, b) => rank(b) - rank(a))) {
    if (c.verdict.score < PASS || (c.verdict.hair ?? 5) < 3 || c.verdict.modest === false) break;
    if (c.verdict.modest === undefined) {
      const m = await modesty(join(CANDS, card.id, c.file), card.id);
      c.verdict.modest = m.modest; c.verdict.quality = m.quality;
      await saveState(state);
      if (!m.modest) { log(`  ${card.id} ${c.file}: wardrobe check failed — ${m.reason}`); continue; }
    }
    if (!c.confirm) {
      c.confirm = await judge(card.star, join(CANDS, card.id, c.file), { id: card.id, detail: false, seed: 4242 });
      c.final = Math.round(((c.verdict.score + c.confirm.score) / 2) * 10) / 10;
      await saveState(state);
      log(`  ${card.id} confirm ${c.file}: ${c.confirm.score} → final ${c.final}`);
    }
    if ((c.final ?? 0) >= PASS) {
      await publish(card.id, join(CANDS, card.id, c.file));
      state.published = c.file; state.finalScore = c.final; state.status = 'published';
      await saveState(state);
      await recordResult(card.id, { star: card.star, tier: card.tier, likeness: c.final, lineup: [c.verdict.lineup, c.confirm.lineup], hair: c.verdict.hair, quality: c.verdict.quality, notes: c.verdict.issues, model: c.model, round: c.round, candidates: state.candidates.length, pick: c.file, prompt: c.prompt });
      log(`✓ ${card.id} published ${c.file} (likeness ${c.final})`);
      return true;
    }
  }
  return false;
}

export async function runCard(card: Card, model: ModelSpec, log: (m: string) => void, opts: { perRound?: number; rounds?: number } = {}): Promise<CardState> {
  const state = await loadState(card.id);
  if (state.status === 'published' && existsSync(join(PUBLIC, card.id, 'card.webp'))) { log(`= ${card.id} already published (${state.finalScore})`); return state; }
  const rounds = opts.rounds ?? 3, perRound = opts.perRound ?? 2;
  if (state.candidates.length && (await tryPublish(card, state, log))) return state;
  const done = state.candidates.reduce((m, c) => Math.max(m, c.round), 0);
  // Feed the feature notes of the last round back into the next prompt.
  let notes = [...new Set(state.candidates.filter((c) => c.round === done).flatMap((c) => c.verdict.issues))].slice(0, 4);
  for (let round = done + 1; round <= rounds; round++) {
    state.candidates.push(...(await generateCandidates(card, model, round, perRound, notes, log)));
    await saveState(state);
    if (await tryPublish(card, state, log)) return state;
    notes = [...new Set(state.candidates.filter((c) => c.round === round).flatMap((c) => c.verdict.issues))].slice(0, 4);
  }
  state.status = 'failed';
  await saveState(state);
  const best = [...state.candidates].sort((a, b) => rank(b) - rank(a))[0];
  await recordResult(card.id, { star: card.star, tier: card.tier, likeness: best?.final ?? best?.verdict.score ?? null, status: 'below threshold — not shipped', model: model.id, candidates: state.candidates.length, notes: best?.verdict.issues ?? [] });
  log(`✗ ${card.id} below threshold after ${rounds} rounds (best ${best?.verdict.score ?? '-'})`);
  return state;
}

/** Bake-off: the same cards through each model, one candidate per round, all judged the same way. */
async function bake(ids: string[], modelKeys: string[], perModel: number, log: (m: string) => void) {
  const cards = (await build()).filter((c) => ids.includes(c.id));
  const rows: { model: string; id: string; score: number; hair?: number; cost: number; genCost: number; file: string }[] = [];
  for (const key of modelKeys) {
    const model = MODELS[key];
    for (const card of cards) {
      const bakeCard = { ...card, id: `${card.id}` };
      const refs = await refBuffers(card.star);
      const prompt = promptFor(card, refs.length);
      for (let k = 0; k < perModel; k++) {
        try {
          const { png, cost } = await generateOne(bakeCard, model, prompt, refs);
          const dir = join(CANDS, '_bake', card.id);
          await mkdir(dir, { recursive: true });
          const file = join(dir, `${key}-${k + 1}.png`);
          await writeFile(file, png);
          const v = await judge(card.star, file, { id: card.id });
          const dims = (await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).stdout.trim();
          rows.push({ model: key, id: card.id, score: v.score, hair: v.hair, cost: cost + v.cost, genCost: cost, file: basename(file) });
          log(`  ${key} ${card.id}#${k + 1}: likeness ${v.score} (${JSON.stringify(v.lineup)}) hair ${v.hair} gen $${cost.toFixed(3)} ${dims} ${v.issues.join('; ')}`);
        } catch (e) {
          if (e instanceof OutOfCredit) throw e;
          log(`  ! ${key} ${card.id}: ${(e as Error).message.slice(0, 240)}`);
        }
      }
    }
  }
  const summary = modelKeys.map((k) => {
    const r = rows.filter((x) => x.model === k);
    const mean = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);
    return { model: MODELS[k].id, n: r.length, likeness: mean(r.map((x) => x.score)), hair: mean(r.map((x) => x.hair ?? 0)), genCostPerImage: mean(r.map((x) => x.genCost)) };
  });
  console.table(summary);
  await writeFile(join(CANDS, '_bake', 'bake.json'), JSON.stringify({ at: new Date().toISOString(), rows, summary }, null, 2));
}

/** One page with every card: art (or placeholder), tier, titles, line, likeness and judge notes. */
async function review() {
  const cards = await build();
  const results = (await loadResults()) as Record<string, { likeness?: number | null; model?: string; notes?: string[]; status?: string; hair?: number; candidates?: number }>;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rel = '../../../apps/web/public/cards';
  const tiles = cards.map((c) => {
    const r = results[c.id];
    const has = existsSync(join(PUBLIC, c.id, 'card-sm.webp'));
    const score = r?.likeness ?? null;
    const cls = !has ? 'todo' : score !== null && score >= PASS ? 'pass' : 'fail';
    return `<figure class="${cls}" data-star="${c.star}" data-tier="${c.tier}">
  ${has ? `<img loading="lazy" src="${rel}/${c.id}/card-sm.webp" alt="${esc(c.scene)}">` : `<div class="ph">${r?.status ? esc(r.status) : 'not generated yet'}</div>`}
  <figcaption><b>${c.id.slice(3)}</b> <span class="tier t-${c.tier}">${c.tier}</span> <span class="score">${score ?? '–'}</span><br>
  ${esc(c.title.ja)} · ${esc(c.title.en)}<br><i>${esc(c.line.ja)}</i>${r?.notes?.length ? `<br><small>${esc(r.notes.join('; '))}</small>` : ''}${r?.model ? `<br><small>${esc(r.model.split('/')[1] ?? r.model)} · ${r.candidates ?? '?'} cand. · hair ${r.hair ?? '–'}</small>` : ''}</figcaption>
</figure>`;
  }).join('\n');
  const stats = STARS.map((s) => {
    const sc = cards.filter((c) => c.star === s).map((c) => results[c.id]).filter((r) => r?.likeness != null && !r.status).map((r) => r!.likeness as number);
    return `<li><b>${s}</b>: ${sc.length}/30 published${sc.length ? `, likeness mean ${(sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(2)}, min ${Math.min(...sc)}` : ''}</li>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Card Review · S1</title>
<style>
:root{--bg:#0f1126;--fg:#f3eef2;--muted:#a9a3b8;--pass:#4caf7d;--fail:#e0626f;--todo:#555a78;--card:#1a1d3a}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,"Hiragino Sans",sans-serif}
header{padding:16px;position:sticky;top:0;background:var(--bg);z-index:1;border-bottom:1px solid #2a2e55}
h1{font-size:18px;margin:0 0 6px} ul{margin:4px 0;padding-left:18px;color:var(--muted)} label{margin-right:10px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;padding:16px}
figure{margin:0;background:var(--card);border-radius:10px;overflow:hidden;border:2px solid var(--todo)}
figure.pass{border-color:var(--pass)} figure.fail{border-color:var(--fail)}
img,.ph{display:block;width:100%;aspect-ratio:360/503;object-fit:cover}
.ph{display:grid;place-items:center;color:var(--muted);text-align:center;padding:8px;box-sizing:border-box}
figcaption{padding:8px} small{color:var(--muted)} .score{float:right;font-weight:700}
.tier{font-size:11px;padding:1px 5px;border-radius:4px;background:#333a6a} .t-SSR{background:#8a5a1a}.t-UR{background:#a0294a}.t-SR{background:#5b3b8a}
</style></head><body>
<header><h1>Star Genesis · First Five — card review (local, not deployed)</h1>
<div>Likeness 1–5 from the blind line-up judge (tools/media/src/judge.ts); pass ≥ ${PASS}. Green = published, red = below threshold (not shipped), grey = not generated yet.</div>
<ul>${stats}</ul>
<div><label>Talent <select id="s"><option value="">all</option>${STARS.map((s) => `<option>${s}</option>`).join('')}</select></label>
<label>Tier <select id="t"><option value="">all</option>${['N', 'R', 'SR', 'SSR', 'UR'].map((t) => `<option>${t}</option>`).join('')}</select></label></div></header>
<main>${tiles}</main>
<script>
const s=document.getElementById('s'),t=document.getElementById('t');
function f(){for(const el of document.querySelectorAll('figure'))el.style.display=(!s.value||el.dataset.star===s.value)&&(!t.value||el.dataset.tier===t.value)?'':'none'}
s.onchange=t.onchange=f;
</script></body></html>`;
  await writeFile(join(CARDS_DIR, 'review.html'), html);
  // Contact sheet per talent (gitignored out dir).
  await mkdir(OUT_DIR, { recursive: true });
  for (const star of STARS) {
    const files = cards.filter((c) => c.star === star).map((c) => join(PUBLIC, c.id, 'card-sm.webp')).filter((f) => existsSync(f));
    if (!files.length) continue;
    const pngs: string[] = [];
    for (const f of files) { const p = join(OUT_DIR, 'tmp', `${basename(resolve(f, '..'))}.png`); await mkdir(join(OUT_DIR, 'tmp'), { recursive: true }); await exec('dwebp', ['-quiet', f, '-o', p]); pngs.push(p); }
    const cols = Math.min(6, pngs.length), rows = Math.ceil(pngs.length / cols);
    const inputs = pngs.flatMap((p) => ['-i', p]);
    const layout = pngs.map((_, i) => `${(i % cols) * 360}_${Math.floor(i / cols) * 503}`).join('|');
    await exec('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', `${pngs.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${pngs.length}:layout=${layout}:fill=black${pngs.length === 1 ? '' : ''}`, '-frames:v', '1', '-q:v', '3', '-y', join(OUT_DIR, `contact-${star}.jpg`)]).catch(async () => {
      if (pngs.length === 1) await exec('ffmpeg', ['-v', 'error', '-i', pngs[0], '-q:v', '3', '-y', join(OUT_DIR, `contact-${star}.jpg`)]);
    });
    void rows;
  }
  await rm(join(OUT_DIR, 'tmp'), { recursive: true, force: true });
  console.log(`review: ${join(CARDS_DIR, 'review.html').replace(`${ROOT}/`, '')}; contact sheets: ${OUT_DIR.replace(`${ROOT}/`, '')}/contact-<star>.jpg`);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  const cmd = args[0];
  if (cmd === 'bake') return bake(arg('--ids')!.split(','), arg('--models')!.split(','), Number(arg('--n') ?? 1), log);
  if (cmd === 'review') return review();
  if (cmd === 'audit') {
    // Re-check published cards' wardrobe with the strict checker; flagged cards are withdrawn for regeneration.
    for (const c of await build()) {
      const f = join(PUBLIC, c.id, 'card.webp');
      if (!existsSync(f)) continue;
      const png = join(OUT_DIR, `audit-${c.id}.png`);
      await mkdir(OUT_DIR, { recursive: true });
      await exec('dwebp', ['-quiet', f, '-o', png]);
      const m = await modesty(png, c.id);
      await rm(png, { force: true });
      if (!m.modest || m.quality < 3) {
        log(`✗ ${c.id}: modest=${m.modest} quality=${m.quality} — ${m.reason}${args.includes('--withdraw') ? ' (withdrawn)' : ''}`);
        if (args.includes('--withdraw')) {
          await rm(join(PUBLIC, c.id), { recursive: true, force: true });
          const st = await loadState(c.id);
          for (const cand of st.candidates) if (cand.file === st.published) cand.verdict.modest = false;
          st.status = 'pending'; delete st.published; delete st.finalScore;
          await saveState(st);
        }
      } else log(`  ${c.id}: ok (quality ${m.quality})`);
    }
    return;
  }
  if (cmd === 'publish') { await publish(args[1], resolve(args[2])); log(`published ${args[1]}`); return; }
  if (cmd === 'run') {
    const model = arg('--model') ? MODELS[arg('--model')!] : DEFAULT_MODEL;
    if (!model) throw new Error(`unknown --model ${arg('--model')}; known: ${Object.keys(MODELS).join(', ')}`);
    let cards = await build();
    if (arg('--ids')) cards = cards.filter((c) => arg('--ids')!.split(',').includes(c.id));
    // --tier UR,SSR,SR also sets the order of work, so partial results are the most useful ones.
    if (arg('--tier')) { const order = arg('--tier')!.split(','); cards = cards.filter((c) => order.includes(c.tier)).sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier)); }
    if (arg('--only')) cards = cards.filter((c) => arg('--only')!.split(',').includes(c.star));
    if (arg('--first')) { const n = Number(arg('--first')); cards = STARS.flatMap((s) => cards.filter((c) => c.star === s).slice(0, n)); }
    const queue = [...cards];
    let stopped = false;
    const workers = Number(arg('--concurrency') ?? 2);
    await Promise.all(Array.from({ length: workers }, async () => {
      for (let c = queue.shift(); c && !stopped; c = queue.shift()) {
        try { await runCard(c, model, log, { perRound: Number(arg('--n') ?? 2), rounds: Number(arg('--rounds') ?? 3) }); }
        catch (e) {
          if (e instanceof OutOfCredit) { stopped = true; log(`■ out of credit: ${(e as Error).message}. Stopping cleanly.`); }
          else log(`! ${c.id}: ${(e as Error).message.slice(0, 300)}`);
        }
      }
    }));
    await review();
    const results = await loadResults();
    const done = cards.filter((c) => existsSync(join(PUBLIC, c.id, 'card.webp'))).length;
    log(`${done}/${cards.length} published in this selection${stopped ? ' — stopped: out of credit' : ''}. Results: ${Object.keys(results).length} recorded.`);
    if (stopped) process.exitCode = 3;
    return;
  }
  console.error('usage: cards.ts bake|run|publish|review …');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}


