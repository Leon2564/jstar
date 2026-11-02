export type StarId = 'mahiro' | 'nana' | 'unpai' | 'alice' | 'eimi';

export interface Star {
  id: StarId;
  name: string;
  first: string;
  romaji: string;
  romajiFirst: string;
  /** Her names in Traditional Chinese, as her persona speaks them (唯井真尋 / 真尋; the owner reviews in zh-Hant). */
  zhName: string;
  zhFirst: string;
  /** Her names in Hangul (M10), family name first as her persona says them (apps/agent/app/personas: 후카다 에이미). */
  koName: string;
  koFirst: string;
  /** Placeholder tone shown until real footage is supplied. */
  tint: string;
}

export const CAST: Star[] = [
  { id: 'mahiro', name: '唯井まひろ', first: 'まひろ', romaji: 'Mahiro Tadai', romajiFirst: 'Mahiro', zhName: '唯井真尋', zhFirst: '真尋', koName: '타다이 마히로', koFirst: '마히로', tint: '#E7DCE3' },
  { id: 'nana', name: '八木奈々', first: '奈々', romaji: 'Nana Yagi', romajiFirst: 'Nana', zhName: '八木奈奈', zhFirst: '奈奈', koName: '야기 나나', koFirst: '나나', tint: '#DFDCEA' },
  { id: 'unpai', name: 'うんぱい', first: 'うんぱい', romaji: 'Unpai', romajiFirst: 'Unpai', zhName: 'Unpai', zhFirst: 'Unpai', koName: '운파이', koFirst: '운파이', tint: '#EADBE0' },
  { id: 'alice', name: '七瀬アリス', first: 'アリス', romaji: 'Alice Nanase', romajiFirst: 'Alice', zhName: '七瀬愛麗絲', zhFirst: '愛麗絲', koName: '나나세 앨리스', koFirst: '앨리스', tint: '#E3DAE6' },
  { id: 'eimi', name: '深田えいみ', first: 'えいみ', romaji: 'Eimi Fukada', romajiFirst: 'Eimi', zhName: '深田詠美', zhFirst: '詠美', koName: '후카다 에이미', koFirst: '에이미', tint: '#DCDDE9' }
];

export const STAR_IDS: StarId[] = CAST.map((s) => s.id);

export function getStar(id: string | null | undefined): Star {
  return CAST.find((s) => s.id === id) ?? CAST[0];
}

export function isStarId(v: unknown): v is StarId {
  return typeof v === 'string' && (STAR_IDS as string[]).includes(v);
}
