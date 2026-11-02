/**
 * Her words on screen, shared by her room and the scene player: her language's quote marks, and her line cut into
 * pages of what fits her subtitle (a romance ADV's ▼; B rule: never more than three lines of subtitle).
 */

/**
 * Her words' quote marks (M5): 「」 in Japanese and Chinese, “ ” in English and Korean. A quote inside her words takes
 * the inner pair (L1): 『』, or ‘ ’.
 */
export function quoteMarks(lang: string): [string, string, string, string] {
  return lang === 'en' || lang === 'ko' ? ['“', '”', '‘', '’'] : ['「', '」', '『', '』'];
}

const PAIRS: Record<string, string> = { '「': '」', '『': '』', '“': '”', '"': '"' };

/**
 * Her line in her language's quotes. A line written whole in quotes (a book she reads out) keeps one pair, in this
 * language's marks; a line that only contains a quote (「……そうして彼女は窓を開けた。」……おしまい) is wrapped, and the quote
 * inside takes the inner pair — before L1 such a line was shown unwrapped, its closing 」 missing.
 */
export function quoteLine(text: string, lang: string): string {
  const t = text.trim();
  if (!t) return t;
  const [o, c, io, ic] = quoteMarks(lang);
  const close = PAIRS[t[0]];
  // Whole in one pair, with no other quote opened inside it.
  if (close && t.endsWith(close) && t.length > 1 && !/[「『“]/.test(t.slice(1, -1))) return `${o}${t.slice(1, -1)}${c}`;
  const inner = t.replace(/[「『“]/g, io).replace(/[」』”]/g, ic);
  return `${o}${inner}${c}`;
}

/** Where her sentences end in a line (。！？ and a closing 」, or ". "): pages and her last words cut there. */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(/[。！？!?]+[」』"'）)”’]*\s*|\.(?:\s+|$)|…+(?=$)/g)) ends.push(m.index + m[0].length);
  if (ends[ends.length - 1] !== text.length) ends.push(text.length);
  return ends;
}

/**
 * Her line in pages of what `fits` (three lines of her subtitle), at whole sentences; a sentence longer than a page is
 * cut where it stops fitting. The end of each page, in `text`.
 */
export function pageEnds(text: string, fits: (s: string) => boolean): number[] {
  const out: number[] = [];
  let start = 0, end = 0;
  for (const e of sentenceEnds(text)) {
    if (end > start && !fits(text.slice(start, e))) { out.push(end); start = end; }
    while (e - start > 1 && !fits(text.slice(start, e))) {
      let k = e - 1;
      while (k > start + 1 && !fits(text.slice(start, k))) k--;
      // L3: a Latin or Korean word is never cut in two across pages — back to the space before it.
      const sp = text.lastIndexOf(' ', k);
      if (sp > start + 4 && /\S/.test(text[k] ?? '') && /\S/.test(text[k - 1] ?? '') && /[A-Za-zÀ-ɏ가-힯]/.test(text[k - 1])) k = sp + 1;
      // P1: never a sentence's last character or two alone on the next page: a few more go with them.
      if (e - k < 3 && k - start > 4) k = e - 3;
      out.push(k); start = k;
    }
    end = e;
  }
  out.push(text.length);
  return out;
}

/** C-room N9: her words in zh-Hant pause with ，, never the Japanese 、 (her invitations, lines the model wrote). */
export const zhComma = (text: string, lang: string): string => (lang === 'zh-Hant' ? text.replace(/、/g, '，') : text);

/**
 * C-room N5: her inbox item's words in his language (`texts`, written in every language she has them in), else as the
 * server wrote them for his account's language — never another language's by default.
 */
export function itemText(payload: Record<string, unknown>, lang: string): string {
  const texts = payload.texts && typeof payload.texts === 'object' ? (payload.texts as Partial<Record<string, unknown>>) : null;
  const mine = texts?.[lang];
  const text = typeof mine === 'string' && mine.trim() ? mine : payload.text;
  return typeof text === 'string' ? zhComma(text, lang) : '';
}
