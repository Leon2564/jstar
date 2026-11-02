import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CAST } from '../../src/data/cast';
import { starFirst, starName } from '../../src/i18n';
import { zhHant } from '../../src/i18n/zhHant';

/** #171: in Traditional Chinese her name is written the Chinese way everywhere — never in kana. */
const KANA_NAMES = /まひろ|奈々|うんぱい|アリス|えいみ/;

function langValues(node: unknown, lang: string, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((v) => langValues(v, lang, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k === lang && typeof v === 'string') out.push(v); else langValues(v, lang, out); }
  return out;
}
const zhValues = (node: unknown) => langValues(node, 'zh-Hant');
const jsonFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? jsonFiles(p) : p.endsWith('.json') ? [p] : [];
});

describe('zh-Hant star names (#171)', () => {
  it('唯井真尋 / 八木奈奈 / Unpai / 七瀬愛麗絲 / 深田詠美, short 真尋 / 奈奈 / Unpai / 愛麗絲 / 詠美', () => {
    expect(CAST.map((s) => starName(s, 'zh-Hant'))).toEqual(['唯井真尋', '八木奈奈', 'Unpai', '七瀬愛麗絲', '深田詠美']);
    expect(CAST.map((s) => starFirst(s, 'zh-Hant'))).toEqual(['真尋', '奈奈', 'Unpai', '愛麗絲', '詠美']);
    // Japanese keeps hers, Korean writes them in Hangul (M10), English in romaji.
    expect(starName(CAST[0], 'ja')).toBe('唯井まひろ');
    expect(starName(CAST[0], 'en')).toBe('Mahiro Tadai');
  });

  it('no kana name in the zh-Hant dictionary, her lines or her scenes', () => {
    const dict = Object.values(zhHant as Record<string, string>).filter((v) => KANA_NAMES.test(v));
    expect(dict).toEqual([]);
    const root = join(__dirname, '../../../../packages/shared/src');
    const bad = jsonFiles(root).flatMap((f) => zhValues(JSON.parse(readFileSync(f, 'utf8'))).filter((v) => KANA_NAMES.test(v)).map((v) => `${f}: ${v}`));
    expect(bad).toEqual([]);
  });

  it('no kana at all in her zh-Hant, ko and en lines and scenes: no 「{name}くん」, 「さん」, 「キミ」 (#171)', () => {
    const root = join(__dirname, '../../../../packages/shared/src');
    // Japanese stays in ja (what she says, voiced); the others are subtitles in his language. Nothing needs a pass yet.
    const ALLOWED: string[] = [];
    const KANA = /[\u3040-\u30ff]/;
    const bad = jsonFiles(root).flatMap((f) => ['zh-Hant', 'ko', 'en'].flatMap((lang) =>
      langValues(JSON.parse(readFileSync(f, 'utf8')), lang).filter((v) => KANA.test(v) && !ALLOWED.includes(v)).map((v) => `${f} ${lang}: ${v}`)));
    expect(bad).toEqual([]);
  });

  it('no Japanese honorifics carried into en and ko: "-kun", "-san", "kimi", 「{name} 군」 (#171)', () => {
    const root = join(__dirname, '../../../../packages/shared/src');
    const rules: [string, RegExp][] = [['en', /-kun\b|-san\b|\bkimi\b/i], ['ko', /\{name\} 군|'군'|키미/]];
    const bad = jsonFiles(root).flatMap((f) => rules.flatMap(([lang, re]) =>
      langValues(JSON.parse(readFileSync(f, 'utf8')), lang).filter((v) => re.test(v)).map((v) => `${f} ${lang}: ${v}`)));
    expect(bad).toEqual([]);
  });
});

describe('ko star names (M10)', () => {
  it('Hangul as her persona says them: 타다이 마히로 / 야기 나나 / 운파이 / 나나세 앨리스 / 후카다 에이미', () => {
    expect(CAST.map((s) => starName(s, 'ko'))).toEqual(['타다이 마히로', '야기 나나', '운파이', '나나세 앨리스', '후카다 에이미']);
    expect(CAST.map((s) => starFirst(s, 'ko'))).toEqual(['마히로', '나나', '운파이', '앨리스', '에이미']);
  });
  it('no Latin talent name in a Korean line of her lines or her scenes', () => {
    const root = join(__dirname, '../../../../packages/shared/src');
    const bad = jsonFiles(root).flatMap((f) => langValues(JSON.parse(readFileSync(f, 'utf8')), 'ko').filter((v) => /Mahiro|Nana|Unpai|Alice|Eimi/.test(v)).map((v) => `${f}: ${v}`));
    expect(bad).toEqual([]);
  });
});
