import { describe, expect, it } from 'vitest';
import { STAR_IDS } from '../src/domain';
import { LINES } from '../src/lines';
import { LINE_PLACEHOLDERS, zStarLines, type StarLines } from '../src/lines/schema';
import { SCENES } from '../src/scenes';
import { SYSTEM_LINES } from '../src/scenes/system';
import { CITIES, WORLD } from '../src/world';

const LANGS = ['ja', 'zh-Hant', 'en', 'ko'] as const;
type Text = Record<(typeof LANGS)[number], string> & { unnamed?: Text };

/** Every text under a node (a `{name}` text's `unnamed` right after it), with where it sits. */
function texts(node: unknown, at = ''): { at: string; t: Text }[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => texts(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('ja' in o) return [{ at, t: o as Text }, ...(o.unnamed ? texts(o.unnamed, `${at}.unnamed`) : [])];
    return Object.entries(o).flatMap(([k, v]) => texts(v, `${at}.${k}`));
  }
  return [];
}
/** Everything she says or shows from the line files and the scripts. */
const everything = () => [
  ...STAR_IDS.flatMap((s) => texts(LINES[s]).map((x) => ({ ...x, at: `${s}${x.at}` }))),
  ...texts(SYSTEM_LINES).map((x) => ({ ...x, at: `system${x.at}` })),
  ...SCENES.flatMap((s) => texts(s).map((x) => ({ ...x, at: `${s.meta.id}${x.at}` })))
];
const placeholders = (s: string) => (s.match(/\{[^}]*\}/g) ?? []).sort();
const jaChars = (s: string) => s.replace(/[\s\u3000]/g, '').length;

describe('her system lines (#82)', () => {
  it('each talent has one file that passes the schema, and all are reviewed (#84, owner 2026-09-28)', () => {
    expect(Object.keys(LINES).sort()).toEqual([...STAR_IDS].sort());
    for (const star of STAR_IDS) {
      const parsed = zStarLines.safeParse(LINES[star]);
      expect(parsed.success, `${star}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(LINES[star].star).toBe(star);
      expect(LINES[star].draft).toBe(false);
    }
  });

  it('has the set #82 asks for, per talent', () => {
    for (const star of STAR_IDS) {
      const l = LINES[star];
      expect(l.confession.confess.length, star).toBeGreaterThan(0);
      expect([l.confession.accept, l.confession.notYet, l.confession.decline].every((a) => a.length > 0)).toBe(true);
      // Eight recorded morning lines (#82, #83) and three text-only ones for the rest of his day (before dawn, day, evening).
      expect(l.wakeup).toHaveLength(11);
      expect(l.goodnight.whisper).toHaveLength(5);
      expect([l.weather.firstSnow, l.weather.rainyNight, l.weather.typhoon].map((a) => a.length)).toEqual([3, 3, 3]);
      expect(l.promises).toHaveLength(5);
      expect(Object.keys(l.callName)).toEqual(['familiar', 'lover']);
      expect(l.refuse).toHaveLength(5);
      expect(l.refuse.some((r) => r.kind === 'line') && l.refuse.some((r) => r.kind === 'bargain'), star).toBe(true);
      expect(l.variantInvite).toHaveLength(3);
    }
  });

  it('wake-up lines rotate by day and weather, with one for any morning; ids are unique', () => {
    for (const star of STAR_IDS) {
      const w = LINES[star].wakeup;
      expect(new Set(w.map((x) => x.id)).size, star).toBe(w.length);
      // Every part of his day has a line of hers (before dawn, day and evening have their own).
      for (const part of ['dawn', 'day', 'evening'] as const) expect(w.some((x) => x.when.hours?.includes(part)), `${star} ${part}`).toBe(true);
      for (const days of ['weekday', 'weekend'] as const) expect(w.some((x) => x.when.days === days), `${star} ${days}`).toBe(true);
      for (const weather of ['rain', 'snow', 'clear'] as const) expect(w.some((x) => x.when.weather === weather), `${star} ${weather}`).toBe(true);
      expect(w.some((x) => !x.when.days && !x.when.weather && !x.when.hours), star).toBe(true);
      expect(new Set(LINES[star].promises.map((p) => p.id)).size).toBe(5);
    }
  });

  it('call-name changes land on the names world.ts gives each stage (#56)', () => {
    for (const star of STAR_IDS) {
      expect(LINES[star].callName.familiar.to, star).toBe(WORLD[star].callNames.familiar);
      expect(LINES[star].callName.lover.to, star).toBe(WORLD[star].callNames.lover);
    }
  });

  it('each talent\'s own piece is hers alone', () => {
    const own: Record<string, keyof StarLines> = { nana: 'readings', eimi: 'ogiri', unpai: 'danmaku', alice: 'bargain' };
    for (const star of STAR_IDS) {
      for (const key of ['readings', 'ogiri', 'danmaku', 'bargain'] as const) {
        expect(LINES[star][key] !== undefined, `${star}.${key}`).toBe(own[star] === key);
      }
    }
  });

  it('奈々: two original stories of about 300 characters and one poem', () => {
    const r = LINES.nana.readings!;
    const stories = r.filter((x) => x.kind === 'story');
    expect(stories).toHaveLength(2);
    expect(r.filter((x) => x.kind === 'poem')).toHaveLength(1);
    for (const s of stories) {
      const n = jaChars(s.paragraphs.map((p) => p.ja).join(''));
      expect(n, s.id).toBeGreaterThanOrEqual(250);
      expect(n, s.id).toBeLessThanOrEqual(350);
    }
  });

  it('えいみ: thirty different ōgiri prompts; うんぱい: twenty reaction templates; アリス: three bargains', () => {
    const o = LINES.eimi.ogiri!;
    expect(o).toHaveLength(30);
    expect(new Set(o.map((x) => x.id)).size).toBe(30);
    expect(new Set(o.map((x) => x.text.ja)).size).toBe(30);

    const d = LINES.unpai.danmaku!;
    expect(d).toHaveLength(20);
    expect(new Set(d.map((x) => x.id)).size).toBe(20);
    // A comment that crosses the line is never read back out; ordinary ones are quoted (#68: 回应引用弹幕内容) in a
    // part of their own, and what she says after it is recorded once (#83), so it never quotes him.
    for (const x of d) {
      const quoting = !(x.kind === 'over-line' || x.kind === 'gift' || x.kind === 'quiet');
      expect(!!x.quote, x.id).toBe(quoting);
      if (x.quote) for (const l of LANGS) expect(x.quote[l], `${x.id} ${l}`).toContain('{danmaku}');
      for (const l of LANGS) expect(x.text[l], `${x.id} ${l}`).not.toContain('{danmaku}');
    }

    const b = LINES.alice.bargain!;
    expect(b.branches.map((x) => x.id)).toEqual(['please', 'icecream', 'piano']);
    expect(b.branches.filter((x) => x.leadsTo === 'piano').map((x) => x.id)).toEqual(['piano']);
  });

  it('placeholders are known, agree across languages, and appear only where the runtime fills them', () => {
    for (const star of STAR_IDS) {
      for (const { at, t } of texts(LINES[star])) {
        const [ja, ...rest] = LANGS.map((l) => placeholders(t[l]));
        for (const p of ja) expect(LINE_PLACEHOLDERS as readonly string[], `${star}${at}`).toContain(p);
        for (const other of rest) expect(other, `${star}${at}`).toEqual(ja);
        if (ja.includes('{name}')) expect(at, star).toMatch(/^\.(confession\.accept|callName)/);
        if (ja.includes('{danmaku}')) expect(at, star).toMatch(/^\.danmaku\[\d+\]\.quote$/);
      }
    }
    for (const s of SCENES) for (const { at, t } of texts(s)) expect(placeholders(t.ja), `${s.meta.id}${at}`).toEqual([]);
  });

  it('every {name} line has an unnamed version to record (#83), the same moment without his name', () => {
    let n = 0;
    for (const { at, t } of everything()) {
      if (at.endsWith('.unnamed')) continue;
      const named = t.ja.includes('{name}');
      expect(!!t.unnamed, at).toBe(named);
      if (!t.unnamed) continue;
      n++;
      for (const l of LANGS) expect(t.unnamed[l], `${at}.unnamed [${l}]`).not.toMatch(/\{[^}]*\}/);
    }
    expect(n).toBe(28);
  });

  it('Korean is written for every text she says or shows (owner, 2026-09-28)', () => {
    const all = everything();
    expect(all.length).toBeGreaterThan(900);
    for (const { at, t } of all) {
      expect(t.ko?.trim().length ?? 0, `${at} has no ko`).toBeGreaterThan(0);
      expect(t.ko, at).toMatch(/[\uac00-\ud7a3]|^[\s\p{P}{}a-z]*$/u);
    }
  });

  it('never names a city (the lines are shared, whatever her hometown) nor states an age', () => {
    const cities = Object.values(CITIES).flatMap((c) => [c.city.ja, c.city['zh-Hant'], c.city.en, c.city.ko!, c.prefecture.ja]);
    for (const { at, t } of everything()) {
      for (const l of LANGS) {
        for (const c of cities) expect(t[l].includes(c), `${at} [${l}] names ${c}`).toBe(false);
        expect(t[l], `${at} [${l}]`).not.toMatch(/\d+\s*(歳|才|歲|살|years? old)/);
      }
    }
  });

  it('subtitles in zh-Hant use traditional characters', () => {
    // Simplified-only forms of common characters; any of them means a zh-Hans subtitle slipped in.
    const simplified = /[这们说个时过还没让对给听读书梦来会样发见觉经间里后点头爱亲欢话认问应现实开关门电车东边岁带钟吗么]/;
    for (const { at, t } of everything()) expect(t['zh-Hant'], at).not.toMatch(simplified);
  });

  it('no urgency or sales wording in her words (景品表示法): no "only now", "this month", cards or draws', () => {
    const urgent = /今だけ|今月|期間限定|残りわずか|急いで|ガチャ|カード|引いて|現在限定|本月|限時|抽卡|limited time|this month|right now|hurry|gacha|draw|card|지금만|이번 달|한정/i;
    for (const star of STAR_IDS) for (const { at, t } of texts(LINES[star].variantInvite)) for (const l of LANGS) expect(t[l], `${star}.variantInvite${at} [${l}]`).not.toMatch(urgent);
  });
});

describe('her woken lines on a plain visit (N-66)', () => {
  it('never say his voice or an alarm woke her unless one did', async () => {
    const { wokenLine, WOKEN_BY_HIM, LINES } = await import('../src/lines');
    const days = Array.from({ length: 9 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const) {
      for (const day of days) expect(wokenLine(star, day).ja, `${star} ${day}`).not.toMatch(WOKEN_BY_HIM);
    }
    // When he did wake her, every line is hers to say (unpai's 「きみの声で起きた」 among them).
    const unpai = new Set(days.map((d) => wokenLine('unpai', d, true).ja));
    expect([...unpai].some((l) => WOKEN_BY_HIM.test(l))).toBe(true);
    expect(LINES.unpai.woken.some((l) => WOKEN_BY_HIM.test(l.ja))).toBe(true);
  });
});
