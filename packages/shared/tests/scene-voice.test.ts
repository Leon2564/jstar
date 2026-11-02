import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAR_IDS, type StarId } from '../src/domain';
import { LINES } from '../src/lines';
import { LINE_PLACEHOLDERS } from '../src/lines/schema';
import { CONFESSION_SCENES } from '../src/scenes/confession';
import { SCENES } from '../src/scenes';
import type { SceneScript, SceneText } from '../src/scenes/schema';
import { SYSTEM_LINES, SYSTEM_SCENES } from '../src/scenes/system';
import { VARIANT_SCENE_FILES } from '../src/scenes/variantScenes';

/**
 * Her recorded voice for the v1.1 scenes and system lines (#83, tools/voice/make_scene_jobs.py). Each recording is
 * keyed by (star, Japanese text), so an edited line can never play the old recording: after a native-review edit
 * (#84), `python3 tools/voice/make_scene_jobs.py link` drops the stale `voice` (subtitle only) until the line is
 * synthesised again (tools/voice/README.md).
 */
const PUBLIC = join(__dirname, '../../../apps/web/public');
const expected = (star: StarId, ja: string) =>
  `/voice/scene/${star}/${createHash('sha256').update(`${star}:${ja}`).digest('hex').slice(0, 12)}.mp3`;
const hasPlaceholder = (ja: string) => LINE_PLACEHOLDERS.some((p) => ja.includes(p));

/** A text's `unnamed` version (said without his name, recorded ahead), with its own voice. */
const unnamedOf = (star: StarId, at: string, t: SceneText) =>
  t.unnamed ? [{ star, at: `${at}.unnamed`, ja: t.unnamed.ja, voice: t.unnamed.voice }] : [];

/** Every line step's voice, and every voiced variant and `unnamed` version, as (star, where, ja, voice). */
function stepVoices(scripts: SceneScript[]) {
  return scripts.flatMap((s) => s.steps.flatMap((st) => st.type !== 'line' ? [] : [
    { star: s.meta.star, at: `${s.meta.id}#${st.id}`, ja: st.text.ja, voice: st.voice },
    ...unnamedOf(s.meta.star, `${s.meta.id}#${st.id}`, st.text),
    ...(st.variants ?? []).flatMap((v) => [
      { star: s.meta.star, at: `${s.meta.id}#${st.id}~${v.when}`, ja: v.text.ja, voice: v.text.voice },
      ...unnamedOf(s.meta.star, `${s.meta.id}#${st.id}~${v.when}`, v.text)
    ])
  ]));
}

/** Every three-language text in a line file, with where it sits. */
function texts(node: unknown, at = ''): { at: string; t: SceneText }[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => texts(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('ja' in o) return [{ at, t: o as SceneText }];
    return Object.entries(o).flatMap(([k, v]) => texts(v, `${at}.${k}`));
  }
  return [];
}

const withUnnamed = (star: StarId, prefix: string) => ({ at, t }: { at: string; t: SceneText }) =>
  [{ star, at: `${prefix}${at}`, ja: t.ja, voice: t.voice }, ...unnamedOf(star, `${prefix}${at}`, t)];
const lineTexts = [
  ...STAR_IDS.flatMap((star) => texts(LINES[star]).flatMap(withUnnamed(star, `lines/${star}`))),
  ...STAR_IDS.flatMap((star) => texts(SYSTEM_LINES.talents[star]).flatMap(withUnnamed(star, `lines/system.talents.${star}`)))
];
const steps = stepVoices([...SCENES, ...CONFESSION_SCENES, ...SYSTEM_SCENES]);

/**
 * Texts in her line files that she never says aloud (make_scene_jobs.py NOT_SPOKEN): the written confession message,
 * a promise as the home card shows it, reading titles, his bargaining words and the danmaku comment she quotes.
 */
const NOT_SPOKEN = [
  /^\.confession\.inbox/, /^\.promises\[\d+\]\.promise(\.unnamed)?$/, /^\.readings\[\d+\]\.title/,
  /^\.bargain\.ask/, /^\.bargain\.branches\[\d+\]\.offer/, /^\.danmaku\[\d+\]\.quote/
];
/** Everything she says from a recording: the line steps that are not her free talk or runtime voice, and her lines. */
const spoken = [
  ...stepVoices([...SCENES, ...VARIANT_SCENE_FILES].map((s) => ({
    ...s, steps: s.steps.filter((st) => st.type !== 'line' || (!st.agent && !st.tts))
  }))),
  ...lineTexts.filter((v) => {
    const own = `lines/${v.star}.`;
    return !v.at.startsWith(own) || !NOT_SPOKEN.some((rx) => rx.test(v.at.slice(own.length - 1)));
  })
].filter((v) => !hasPlaceholder(v.ja));

describe('her voice for the scenes and system lines (#83)', () => {
  it('every recording a script or line file names exists, and is the recording of that very text', () => {
    const voiced = [...steps, ...lineTexts].filter((v) => v.voice?.startsWith('/voice/scene/'));
    expect(voiced.length).toBeGreaterThan(0);
    expect(voiced.some((v) => v.at.endsWith('.unnamed')), 'the unnamed versions are recorded too').toBe(true);
    for (const v of voiced) {
      expect(v.voice, `${v.at}: stale — run tools/voice/make_scene_jobs.py link`).toBe(expected(v.star, v.ja));
      expect(existsSync(join(PUBLIC, v.voice!)), `${v.at}: ${v.voice} missing`).toBe(true);
    }
  });

  it('every line she says aloud has a recording: none falls back to a subtitle unnoticed', () => {
    // A new or edited line fails here until it is recorded: tools/voice/make_scene_jobs.py jobs … master, then link.
    expect(spoken.length).toBeGreaterThan(600);
    const missing = spoken.filter((v) => !v.voice).map((v) => `${v.at}: ${v.ja}`);
    expect(missing, 'unrecorded — run tools/voice/make_scene_jobs.py jobs (tools/voice/README.md)').toEqual([]);
  });

  it('a line with a runtime placeholder is never pre-recorded (runtime TTS, #73)', () => {
    for (const v of [...steps, ...lineTexts]) if (hasPlaceholder(v.ja)) expect(v.voice, v.at).toBeUndefined();
  });

  it('the confession and system scenes play the voice of the line they are built from', () => {
    const byText = new Map(lineTexts.filter((v) => v.voice).map((v) => [`${v.star}:${v.ja}`, v.voice]));
    for (const v of stepVoices([...CONFESSION_SCENES, ...SYSTEM_SCENES])) expect(v.voice, v.at).toBe(byText.get(`${v.star}:${v.ja}`));
  });

  it('only her words carry a voice: never his choices, titles or the scene text of another step', () => {
    for (const s of [...SCENES, ...CONFESSION_SCENES, ...SYSTEM_SCENES]) {
      for (const st of s.steps) {
        if (st.type === 'line') continue;
        expect(JSON.stringify(st), `${s.meta.id}#${st.id}`).not.toMatch(/"voice":/);
      }
      expect(JSON.stringify(s.meta), s.meta.id).not.toMatch(/"voice":/);
    }
    expect(JSON.stringify({ ...SYSTEM_LINES, talents: null })).not.toMatch(/"voice":/);
    for (const star of STAR_IDS) {
      const d = LINES[star] as { danmaku?: { quote?: unknown }[] };
      for (const t of d.danmaku ?? []) expect(JSON.stringify(t.quote ?? null), `${star} danmaku quote`).not.toMatch(/"voice":/);
    }
  });
});
