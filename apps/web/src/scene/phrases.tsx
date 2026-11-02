/**
 * Japanese titles and lines break between phrases, never inside a word (N-22, L3): 「おかえりと、｜罰ゲーム」, not 「罰ゲ｜ーム」.
 * Words come from Intl.Segmenter; a phrase is a content word with what follows it (particles, kana endings,
 * punctuation), so a break is offered only after a particle or a mark. The CSS keeps every other place whole
 * (`word-break: keep-all`, and `auto-phrase` where the browser has it); a phrase wider than the line still wraps.
 */
import { Fragment } from 'react';

const PARTICLE = new Set(['の', 'が', 'を', 'に', 'へ', 'と', 'で', 'や', 'も', 'は', 'から', 'まで', 'より', 'だけ', 'ね', 'よ', 'な', 'て', 'って']);
const MARK = /^[、。・！？!?…\u3000\s「」『』（）()]+$/;

export function jaPhrases(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Seg) return [text];
  const out: string[] = [];
  let last = '';
  for (const { segment } of new Seg('ja', { granularity: 'word' }).segment(text)) {
    // A new phrase after a mark, or where a content word follows a particle.
    const opens = out.length > 0 && !MARK.test(segment) && !PARTICLE.has(segment) && (MARK.test(last) || PARTICLE.has(last));
    if (!out.length || opens) out.push(segment); else out[out.length - 1] += segment;
    last = segment;
  }
  return out;
}

type Seg = new (l: string, o: { granularity: 'word' }) => { segment(s: string): Iterable<{ segment: string }> };
/**
 * L3: Chinese breaks between words, never inside one (「聽｜聽看」 is one word): Intl.Segmenter's words, a mark staying
 * with the word before it. Without a segmenter, the line as it is.
 */
export function zhWords(text: string): string[] {
  const S = (Intl as unknown as { Segmenter?: Seg }).Segmenter;
  if (!S) return [text];
  const out: string[] = [];
  for (const { segment } of new S('zh-Hant', { granularity: 'word' }).segment(text)) {
    if (out.length && (MARK.test(segment) || /^[」』）)]/.test(segment) || /[「『（(]$/.test(out[out.length - 1]))) out[out.length - 1] += segment; else out.push(segment);
  }
  return out;
}

/** Where a line may break: its phrases in Japanese, its words in Chinese; any other language as one piece. */
export const phrasesOf = (text: string, lang: string): string[] => (lang === 'ja' ? jaPhrases(text) : lang === 'zh-Hant' ? zhWords(text) : [text]);

/** A line as phrases with a break opportunity (<wbr>) between them (the CSS keeps everything else whole). */
export function Phrased({ text, lang }: { text: string; lang: string }) {
  const parts = phrasesOf(text, lang);
  return <>{parts.map((p, i) => <Fragment key={i}>{i > 0 && <wbr />}{p}</Fragment>)}</>;
}
