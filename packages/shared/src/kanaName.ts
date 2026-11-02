/**
 * His name in her other languages (the persona service's apps/agent/app/names.py). U-10 (QA #10, 10/3): the name he
 * goes by is his: in Japanese and Traditional Chinese she says it as he stored it — 「ケンタ」, never 「Kenta」 or
 * 「Kentakun」 in a zh-Hant reply. English and Korean write a kana name in their script (Kenta / 켄타, N-55).
 */
const KANA = /[ぁ-ゖァ-ヺー]/;
const BASE: Record<string, [string, string]> = {
  ア: ['a', '아'], イ: ['i', '이'], ウ: ['u', '우'], エ: ['e', '에'], オ: ['o', '오'],
  カ: ['ka', '카'], キ: ['ki', '키'], ク: ['ku', '쿠'], ケ: ['ke', '케'], コ: ['ko', '코'],
  ガ: ['ga', '가'], ギ: ['gi', '기'], グ: ['gu', '구'], ゲ: ['ge', '게'], ゴ: ['go', '고'],
  サ: ['sa', '사'], シ: ['shi', '시'], ス: ['su', '스'], セ: ['se', '세'], ソ: ['so', '소'],
  ザ: ['za', '자'], ジ: ['ji', '지'], ズ: ['zu', '즈'], ゼ: ['ze', '제'], ゾ: ['zo', '조'],
  タ: ['ta', '타'], チ: ['chi', '치'], ツ: ['tsu', '츠'], テ: ['te', '테'], ト: ['to', '토'],
  ダ: ['da', '다'], ヂ: ['ji', '지'], ヅ: ['zu', '즈'], デ: ['de', '데'], ド: ['do', '도'],
  ナ: ['na', '나'], ニ: ['ni', '니'], ヌ: ['nu', '누'], ネ: ['ne', '네'], ノ: ['no', '노'],
  ハ: ['ha', '하'], ヒ: ['hi', '히'], フ: ['fu', '후'], ヘ: ['he', '헤'], ホ: ['ho', '호'],
  バ: ['ba', '바'], ビ: ['bi', '비'], ブ: ['bu', '부'], ベ: ['be', '베'], ボ: ['bo', '보'],
  パ: ['pa', '파'], ピ: ['pi', '피'], プ: ['pu', '푸'], ペ: ['pe', '페'], ポ: ['po', '포'],
  マ: ['ma', '마'], ミ: ['mi', '미'], ム: ['mu', '무'], メ: ['me', '메'], モ: ['mo', '모'],
  ヤ: ['ya', '야'], ユ: ['yu', '유'], ヨ: ['yo', '요'],
  ラ: ['ra', '라'], リ: ['ri', '리'], ル: ['ru', '루'], レ: ['re', '레'], ロ: ['ro', '로'],
  ワ: ['wa', '와'], ヲ: ['o', '오'], ヴ: ['vu', '부']
};
const YOON: Record<string, [string, string]> = { ャ: ['ya', '야'], ュ: ['yu', '유'], ョ: ['yo', '요'] };
const SMALL_VOWEL: Record<string, string> = { ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' };
const YOON_KO: Record<string, string> = { キ: '캬큐쿄', ギ: '갸규교', シ: '샤슈쇼', ジ: '자주조', チ: '차추초', ニ: '냐뉴뇨', ヒ: '햐휴효', ビ: '뱌뷰뵤', ピ: '퍄퓨표', ミ: '먀뮤묘', リ: '랴류료' };

const kata = (s: string) => [...s].map((c) => (c >= 'ぁ' && c <= 'ゖ' ? String.fromCharCode(c.charCodeAt(0) + 0x60) : c));
const addFinal = (syl: string, jong: number) => {
  const code = syl.charCodeAt(0) - 0xac00;
  return code < 0 || code % 28 ? syl : String.fromCharCode(0xac00 + code + jong);
};

export function kanaToLatin(name: string): string {
  const s = kata(name);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const nxt = s[i + 1] ?? '';
    if (c === 'ッ' && BASE[nxt]) out.push(BASE[nxt][0][0]);
    else if (c === 'ン') out.push('n');
    else if (c === 'ー') continue;
    else if (BASE[c] && YOON[nxt]) {
      const stem = BASE[c][0];
      out.push((stem.endsWith('i') && stem !== 'i' ? stem.slice(0, -1) : stem) + (['shi', 'chi', 'ji'].includes(stem) ? YOON[nxt][0].slice(1) : YOON[nxt][0]));
      i++;
    } else if (BASE[c] && SMALL_VOWEL[nxt]) { out.push(BASE[c][0].slice(0, -1) + SMALL_VOWEL[nxt]); i++; }
    else out.push(BASE[c]?.[0] ?? c);
  }
  const text = out.join('').replace(/ou|oo/g, 'o').replace(/uu/g, 'u');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function kanaToHangul(name: string): string {
  const s = kata(name);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const nxt = s[i + 1] ?? '';
    if (c === 'ン') { if (out.length) out[out.length - 1] = addFinal(out[out.length - 1], 4); }
    else if (c === 'ッ') { if (out.length) out[out.length - 1] = addFinal(out[out.length - 1], 19); }
    else if (c === 'ー') continue;
    else if (BASE[c] && YOON[nxt]) { const row = YOON_KO[c]; out.push(row ? row['ャュョ'.indexOf(nxt)] : BASE[c][1]); i++; }
    else out.push(BASE[c]?.[1] ?? c);
  }
  // Long vowels as Korean writes Japanese names: 쇼우타 → 쇼타, 유우키 → 유키.
  const kept: string[] = [];
  for (const syl of out) {
    const prev = kept[kept.length - 1] ?? '';
    const code = prev ? prev.charCodeAt(0) - 0xac00 : -1;
    if (syl === '우' && code >= 0 && code <= 11171 && [8, 12, 13, 17].includes(Math.floor(code / 28) % 21) && code % 28 === 0) continue;
    kept.push(syl);
  }
  return kept.join('');
}

/** His name as her line in `lang` writes it: as stored in ja and zh-Hant (U-10); a kana name in Latin (en) or Hangul (ko). */
export function nameIn(name: string | null | undefined, lang: string): string | null {
  if (!name) return null;
  if ((lang !== 'en' && lang !== 'ko') || !KANA.test(name)) return name;
  return lang === 'ko' ? kanaToHangul(name) : kanaToLatin(name);
}

/** Whether a name is (partly) written in kana. */
export const hasKana = (name: string): boolean => KANA.test(name);
