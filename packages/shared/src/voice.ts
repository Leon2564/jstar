/**
 * Voice input (#72), shared by the web app and the API. No zod here, so the web entry bundle can import it.
 *
 * `maxMs` and `silenceMs` bound one utterance on the web (hold to talk, or it stops by itself after that much quiet;
 * `noSpeechMs` of nothing gives up). `maxBytes` is what `POST /v1/asr` accepts — 30 s of 32 kbps Opus is ~120 KB,
 * AAC on iOS ~500 KB.
 */
export const VOICE_INPUT = { maxMs: 30_000, silenceMs: 1_200, noSpeechMs: 8_000, maxBytes: 1024 * 1024 } as const;

/** Languages the server recogniser is asked for (Whisper codes); the UI language picks one. */
export const ASR_LANGS = ['ja', 'zh', 'en', 'ko'] as const;
export type AsrLang = (typeof ASR_LANGS)[number];

/** VOICE_RULES.ttsMaxChars (rules.ts; kept here so this module needs nothing else): one TTS request's text. */
export const TTS_MAX_CHARS = 200;

/** One sentence she says in one breath (#73): longer ones are cut at a pause so her voice starts sooner. */
export const TTS_SENTENCE_CJK = 70;
export const TTS_SENTENCE_LATIN = 140;

/** Words that end in a full stop without ending the sentence (lower-case, dots inside kept). */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'no', 'vol', 'approx', 'cf', 'fig', 'inc', 'ltd', 'co', 'mt']);
const CLOSERS = '」』）)"\'”’]';
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isLower = (c: string | undefined) => c !== undefined && /[a-z]/.test(c);
const isAsciiAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);

/**
 * Where her text has sentence ends: after 。．！？♪ (and a closing quote) always; after ASCII ! ? unless a letter or
 * digit follows at once ("Yahoo!Japan"); after a full stop followed by a space or the end — not after an abbreviation
 * ("Mr.", "e.g."), a single initial, in a decimal, or when the next word starts in lower case; after an ellipsis (… or
 * ...) that ends the text or a quote, or is followed by a space and a word not in lower case ("asleep… Please", never
 * "I mean… you know"); and at line breaks.
 */
function sentenceEnds(t: string): number[] {
  const ends: number[] = [];
  const closeAfter = (j: number) => { while (j < t.length && CLOSERS.includes(t[j])) j++; return j; };
  const nextWord = (j: number) => { while (j < t.length && isSpace(t[j])) j++; return t[j]; };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\n') { let j = i; while (j < t.length && t[j] === '\n') j++; ends.push(j); i = j - 1; continue; }
    if ('。．！？♪'.includes(c)) {
      let j = i; while (j < t.length && '。．！？♪!?'.includes(t[j])) j++;
      j = closeAfter(j); ends.push(j); i = j - 1; continue;
    }
    if (c === '!' || c === '?') {
      let j = i; while (j < t.length && '!?！？'.includes(t[j])) j++;
      j = closeAfter(j);
      if (!isAsciiAlnum(t[j])) ends.push(j);
      i = j - 1; continue;
    }
    const ellipsis = c === '…' ? (() => { let j = i; while (t[j] === '…') j++; return j; })() : t.startsWith('...', i) ? (() => { let j = i; while (t[j] === '.') j++; return j; })() : 0;
    if (ellipsis) {
      let j = ellipsis;
      // A sentence end right after it ("…?", "...!") is that end's.
      if ('?!？！。'.includes(t[j] ?? '')) { i = j - 1; continue; }
      j = closeAfter(j);
      const atEnd = j >= t.length;
      if (atEnd || j > ellipsis || (isSpace(t[j]) && !isLower(nextWord(j)) && nextWord(j) !== undefined)) ends.push(j);
      i = j - 1; continue;
    }
    if (c === '.') {
      const j = closeAfter(i + 1);
      if (j < t.length && !isSpace(t[j])) continue; // 3.14, e.g, file.txt
      const word = /[A-Za-z.]*$/.exec(t.slice(0, i))![0].replace(/^\.+/, '');
      if (ABBREVIATIONS.has(word.toLowerCase()) || /^[A-Za-z]$/.test(word)) continue;
      if (j < t.length && isLower(nextWord(j))) continue;
      ends.push(j);
    }
  }
  return ends;
}

/** Cuts a sentence longer than `limit` at its last pause (、，,;:) before the limit, else a space, else the limit. */
function cutLong(p: string, limit: number): string[] {
  const out: string[] = [];
  let rest = p.trim();
  while ([...rest].length > limit) {
    const chars = [...rest];
    const head = chars.slice(0, limit).join('');
    let at = Math.max(...['、', '，', ',', ';', '；', ':', '：'].map((m) => head.lastIndexOf(m)));
    if (at > head.length / 3) at += 1;
    else { const sp = head.lastIndexOf(' '); at = sp > head.length / 3 ? sp : head.length; }
    // Punctuation that closes what came before stays with it (never a piece of its own).
    while (at < rest.length && /[、，,;；:：。！？!?」』）)…]/.test(rest[at])) at++;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Her next piece may be at most this many times as long as everything before it (#73, gaps): while she says what came
 * before, the next piece is synthesized (≈ 0.3–0.4 s per second of audio), so a much longer one would arrive late and
 * leave a silence (QA: 0.94 s and 1.28 s, then 10 s). A longer piece is cut at a pause or a space; with neither (a
 * long Japanese run), at the limit itself — a silence is worse than a cut there. The first piece is her first breath.
 */
const RAMP = 2.5;
/** The least a later piece may hold: about two seconds of her voice (Japanese ≈ 7 characters a second, English ≈ 15). */
const RAMP_MIN = 16;
const RAMP_MIN_LATIN = 40;

/** Cuts `p` at its last pause before `limit` (past its first third), else a space (past half); else leaves it. */
function cutSoft(p: string, limit: number): [string, string] | null {
  const head = [...p].slice(0, limit).join('');
  let at = Math.max(...['、', '，', ',', ';', '；', ':', '：'].map((m) => head.lastIndexOf(m)));
  if (at >= head.length / 3) at += 1;
  else { const sp = head.lastIndexOf(' '); at = sp >= head.length / 2 ? sp : -1; }
  return at > 0 ? [head.slice(0, at).trim(), p.slice(at).trim()] : null;
}

/**
 * Her first breath (#73, time to first sound): the first piece is synthesized before she can start, so it is short —
 * at most FIRST_CJK / FIRST_LATIN characters (about 2–2.5 s of her voice). A longer first sentence is cut at its first
 * pause (，、,;:) inside that budget (not before FIRST_MIN_* characters, so it is more than a sigh), else at the budget
 * (Latin: at the last space before it, never inside a word).
 */
export const FIRST_CJK = 16;
export const FIRST_LATIN = 40;
const FIRST_MIN_CJK = 4;
const FIRST_MIN_LATIN = 10;
const PAUSES = ['、', '，', ',', ';', '；', ':', '：'];

export function firstBreath(p: string): [string, string] | null {
  const isLatin = latin(p);
  const budget = isLatin ? FIRST_LATIN : FIRST_CJK;
  const chars = [...p.trim()];
  if (chars.length <= budget) return null;
  // A pause right at the budget's edge still counts (「……そんなこと言われたら、」).
  const head = chars.slice(0, budget + 1).join('');
  const least = isLatin ? FIRST_MIN_LATIN : FIRST_MIN_CJK;
  let at = -1;
  for (let i = least - 1; i < head.length; i++) if (PAUSES.includes(head[i])) { at = i + 1; break; }
  if (at < 0 && isLatin) { const sp = head.lastIndexOf(' '); at = sp >= least ? sp : -1; }
  if (at < 0) at = chars.slice(0, budget).join('').length;
  const all = p.trim();
  // Punctuation that closes what came before stays with it.
  while (at < all.length && /[、，,;；:：。！？!?」』）)…]/.test(all[at])) at++;
  const rest = all.slice(at).trim();
  return rest ? [all.slice(0, at).trim(), rest] : null;
}

/** No pause or space to cut at: at `limit` characters (CJK), with closing punctuation kept on the first part. */
function hardCut(p: string, limit: number): [string, string] | null {
  if (latin(p)) return null;
  const all = p.trim();
  let at = [...all].slice(0, limit).join('').length;
  while (at < all.length && /[、，,;；:：。！？!?」』）)…]/.test(all[at])) at++;
  return at < all.length ? [all.slice(0, at), all.slice(at).trim()] : null;
}

function ramp(pieces: string[]): string[] {
  const out: string[] = [];
  let said = 0;
  for (let p of pieces) {
    if (!out.length) {
      const first = firstBreath(p);
      if (first) { out.push(first[0]); said = [...first[0]].length; p = first[1]; }
    }
    while (out.length) {
      const allowed = Math.max(latin(p) ? RAMP_MIN_LATIN : RAMP_MIN, RAMP * said);
      // A quarter over is still in time; and a cut that would leave a scrap ("properly.") is not made.
      if ([...p].length <= allowed * 1.25) break;
      const cut = cutSoft(p, allowed) ?? hardCut(p, allowed);
      if (!cut || !cut[1] || [...cut[1]].length < (latin(p) ? 16 : 6)) break;
      out.push(cut[0]);
      said += [...cut[0]].length;
      p = cut[1];
    }
    out.push(p);
    said += [...p].length;
  }
  return out;
}

/** A sentence in Latin script (her English), where a longer breath is natural. */
const latin = (p: string) => {
  const letters = [...p].filter((c) => /\p{L}/u.test(c));
  return letters.length > 0 && letters.filter((c) => /[A-Za-z\u00C0-\u024F]/.test(c)).length / letters.length > 0.5;
};

/**
 * Her line in the pieces she says one at a time (#73) — the web app asks for them one by one, and the API cuts the
 * line it signed the same way to find the sentence asked for (this one function on both sides): whole sentences, very
 * short ones joined to the next, a long one cut at a pause (TTS_SENTENCE_CJK / TTS_SENTENCE_LATIN), a piece much
 * longer than what came before it cut at a pause too (so it is ready in time: RAMP), the first one short (firstBreath:
 * she starts sooner), none longer than one TTS request
 * may carry (`max`).
 */
export function splitSentences(text: string, max: number = TTS_MAX_CHARS, minLen = 6): string[] {
  // Pieces keep their own spacing until the end, so joined pieces read as written.
  const parts: string[] = [];
  let from = 0;
  for (const end of sentenceEnds(text)) { if (text.slice(from, end).trim()) parts.push(text.slice(from, end)); from = end; }
  if (text.slice(from).trim()) parts.push(text.slice(from));
  const len = (p: string) => [...p.trim()].length;
  const limit = (p: string) => Math.min(max, latin(p) ? TTS_SENTENCE_LATIN : TTS_SENTENCE_CJK);
  // "……っ。" alone is too short to sound like anything: it goes with what follows.
  const merged: string[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && len(last) < minLen && len(last) + len(p) <= limit(last + p)) merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return ramp(merged.flatMap((p) => cutLong(p, limit(p))).filter((p) => p));
}
