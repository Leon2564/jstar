/**
 * Which clip each of her recorded lines plays over (docs/lipsync.md § 6): the render jobs of the scene batch (C).
 *
 *   npx tsx tools/lipsync/plan.ts > tools/lipsync/out/plan.json
 *
 * Walks every scene the player can run (the bundled scenes, her system scenes, her confession), as the player plays
 * them: the graph from the first step, the clip on stage carried along each path, and at each `line` with a recording
 * the clip the stage shows while she says it — `clipOf(shot, portrait, speaking = true)` in apps/web/src/scene/player.tsx,
 * so on her wide and close shots her talk loops (stage.tsx `baseLoop`). Both orientations. A pending clip is resolved
 * the way the test site plays it (`previewScript`), a clip's card variants count too.
 *
 * Output: { jobs: [{ voice, clip, star, lines }], missing: [...] } — one job per (recording, clip id), `voice` the
 * public path (/voice/scene/<star>/<id>.mp3), `clip` a media.gen / media.scene.gen id with its orientation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, previewScript, targetsOf } from '../../packages/shared/src/scenes/index';
import { SYSTEM_SCENES } from '../../packages/shared/src/scenes/system';
import { CONFESSION_SCENES } from '../../packages/shared/src/scenes/confession';
import type { SceneScript, SceneStep } from '../../packages/shared/src/scenes/schema';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ids = new Set<string>([
  ...Object.keys(JSON.parse(readFileSync(join(REPO, 'apps/web/src/data/media.scene.gen.json'), 'utf8'))),
  ...[...readFileSync(join(REPO, 'apps/web/src/data/media.gen.ts'), 'utf8').matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
]);
const STAR = /^(mahiro|nana|unpai|alice|eimi)-(hero|breath)(?:-(?:9x16|16x9))?$/;

/** apps/web/src/components/stage.tsx mediaFor + scene/stage.tsx clipEntry. */
const clipId = (media: string | undefined, portrait: boolean): string | undefined => {
  if (!media) return undefined;
  if (ids.has(media)) return media;
  const want = `${media}-${portrait ? '9x16' : '16x9'}`, other = `${media}-${portrait ? '16x9' : '9x16'}`;
  return ids.has(want) ? want : ids.has(other) ? other : undefined;
};
/** scene/stage.tsx baseLoop with speaking = true. */
const talking = (media: string | undefined, portrait: boolean): string | undefined => {
  const m = media ? STAR.exec(media) : null;
  if (!m) return media;
  const want = m[2] === 'hero' ? `${m[1]}-talk` : `${m[1]}-talkclose`;
  return clipId(want, portrait) ? want : media;
};

/** Every recording a line step can play (its own, or its text's / unnamed version's). */
function voices(step: SceneStep): string[] {
  const out = new Set<string>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) if (k === 'voice' && typeof v === 'string') out.add(v); else walk(v);
  };
  walk(step);
  return [...out];
}

const jobs = new Map<string, { voice: string; clip: string; star: string; lines: string[] }>();
const lineVoices = new Set<string>();
const missing: string[] = [];
const scripts: SceneScript[] = [...SCENES, ...SYSTEM_SCENES, ...CONFESSION_SCENES].map(previewScript);
for (const script of scripts) {
  const steps = script.steps;
  const at = new Map(steps.map((s, i) => [s.id, i]));
  const seen = new Set<string>();
  const queue: { i: number; media: (string | undefined)[] }[] = [{ i: 0, media: [script.meta.idle] }];
  while (queue.length) {
    const { i, media } = queue.shift()!;
    const s = steps[i];
    if (!s) continue;
    let cur = media;
    if (s.type === 'clip') cur = [s.media, ...((s as { variants?: { media: string }[] }).variants ?? []).map((v) => v.media)];
    const key = `${i}|${cur.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.type === 'line') {
      for (const v of voices(s)) {
        lineVoices.add(v);
        for (const portrait of [true, false]) {
          for (const m of cur) {
            const clip = clipId(talking(m, portrait), portrait);
            if (!clip) { missing.push(`${script.meta.id}/${s.id}: ${m}`); continue; }
            const k = `${v}|${clip}`;
            const j = jobs.get(k) ?? { voice: v, clip, star: script.meta.star, lines: [] };
            if (!j.lines.includes(`${script.meta.id}/${s.id}`)) j.lines.push(`${script.meta.id}/${s.id}`);
            jobs.set(k, j);
          }
        }
      }
    }
    for (const t of targetsOf(s, steps[i + 1]?.id)) { const n = at.get(t); if (n !== undefined) queue.push({ i: n, media: cur }); }
  }
}

const files = readdirSync(join(REPO, 'apps/web/public/voice/scene')).flatMap((star) =>
  readdirSync(join(REPO, 'apps/web/public/voice/scene', star)).map((f) => `/voice/scene/${star}/${f}`));
const unplayed = files.filter((f) => !lineVoices.has(f));
const list = [...jobs.values()].sort((a, b) => a.clip.localeCompare(b.clip) || a.voice.localeCompare(b.voice));
console.log(JSON.stringify({
  recordings: files.length, played: [...lineVoices].filter((v) => v.startsWith('/voice/scene/')).length,
  unplayed, clips: [...new Set(list.map((j) => j.clip))].sort(), missing: [...new Set(missing)], jobs: list
}, null, 1));
