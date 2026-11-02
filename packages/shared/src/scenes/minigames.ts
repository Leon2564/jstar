/**
 * The five scenes' mini-games (#66–#70): what each one decides and where the scene goes from there.
 *
 * - rps (まひろ #66): her hand is uniformly random and drawn on the server (engine.ts `decideRps`, the API's crypto
 *   rng), stored on the run; the browser only sends his hand.
 * - praise (奈々 #67): he says what he thought of her reading; the judge grades it generic or specific (with a reason
 *   tag). Specific → `win`; generic → `lose`, which the script turns into a second chance and then a gentle ending.
 * - ogiri (えいみ #70): a prompt from her bank is shown, he answers, the judge scores 1–`scale` with one remark in
 *   her voice. Affinity + score × MINIGAME_RULES.ogiriAffinityPerPoint; `win` at or over `config.passScore`.
 * - bargain (アリス #69): his last try in his own words is read against her tree — asking nicely, a bribe, or the
 *   alternative she can accept (`win`: the piano). Anything else gets her counter-offer (`lose`).
 * - danmaku (うんぱい #68): each comment is read out in one of her reaction templates, quoting it. A comment that
 *   crosses the line is never read back: she answers with an `over-line` template, which quotes nothing.
 *
 * The judge is the persona service (`POST /v1/scene/judge`, apps/agent/app/minigames.py), which runs the content
 * boundary first. Its answer is only ever a label or a number; this module turns it into the result, her lines and
 * the reward. Every failure has a safe reading (`judgeAnswer` with no call): praise is generic, ōgiri scores the
 * middle of the scale, bargaining gets the counter-offer, and a comment is acknowledged without being read back.
 *
 * Pure and zod-free, like the engine: the API runs it, and the shared tests play every branch through it.
 */
import { localText } from '../domain';
import { MINIGAME_RULES } from '../rules';
import type { EffectBody, MinigameStep, RpsHand, SceneScript, SceneText } from './schema';

export type GameOutcome = 'win' | 'lose' | 'draw';

export const JUDGED_MINIGAMES = ['praise', 'ogiri', 'bargain', 'danmaku'] as const;
export type JudgedMinigame = (typeof JUDGED_MINIGAMES)[number];
export const isJudged = (kind: string): kind is JudgedMinigame => (JUDGED_MINIGAMES as readonly string[]).includes(kind);

export const PRAISE_TIERS = ['generic', 'specific'] as const;
/** The judge's reason tag (for evals and metrics; never shown). `over_line`: the content boundary stopped it. */
export const PRAISE_REASONS = ['detail', 'quote', 'delivery', 'feeling', 'generic', 'off_topic', 'over_line'] as const;
/** アリス's tree (#69): asking nicely, a bribe, the alternative she can accept, anything else, or over the line. */
export const BARGAIN_MOVES = ['please', 'bribe', 'alternative', 'other', 'over_line'] as const;
/** What a comment is: lines/schema.ts DANMAKU_KINDS minus what the stream itself sends (`gift`, `quiet`). */
export const DANMAKU_LABELS = ['greet', 'praise', 'question', 'request', 'tease', 'over-line'] as const;

export type PraiseTier = (typeof PRAISE_TIERS)[number];
export type PraiseReason = (typeof PRAISE_REASONS)[number];
export type BargainMove = (typeof BARGAIN_MOVES)[number];
export type DanmakuLabel = (typeof DANMAKU_LABELS)[number];

/** What the judge said about his answer: a label or a number, never anything the engine would follow blindly. */
export type MinigameCall =
  | { kind: 'praise'; tier: PraiseTier; reason: PraiseReason }
  | { kind: 'ogiri'; score: number; comment: string | null }
  | { kind: 'bargain'; move: BargainMove }
  | { kind: 'danmaku'; label: DanmakuLabel };

export interface RpsGame { kind: 'rps'; mine: RpsHand; hers: RpsHand; result: GameOutcome }
export interface PraiseGame { kind: 'praise'; tier: PraiseTier; reason: PraiseReason; score: number; attempt: number; result: GameOutcome }
export interface OgiriGame { kind: 'ogiri'; score: number; of: number; pass: number | null; result: GameOutcome }
export interface BargainGame { kind: 'bargain'; move: BargainMove; result: GameOutcome }
/** `read`: his comment was quoted back (false when it crossed the line or could not be judged). */
export interface DanmakuGame { kind: 'danmaku'; label: DanmakuLabel | null; read: boolean; result: GameOutcome }
/** The last decided mini-game of a run (`RunState.last`), as the player shows it. */
export type GameResult = RpsGame | PraiseGame | OgiriGame | BargainGame | DanmakuGame;
export type JudgedResult = PraiseGame | OgiriGame | BargainGame | DanmakuGame;

/** A judged answer as the engine plays it. */
export interface Judged {
  result: JudgedResult;
  /** Her lines in reaction, played before the scene goes on (a filled danmaku template, her ōgiri remark, her answer to a bargain). */
  reply: SceneText[];
  /** What the answer itself grants (ōgiri: score × rate), paid like a choice's reward. */
  effect: EffectBody | null;
  /** The persona service decided, or its failure was read safely. */
  source: 'agent' | 'fallback';
}

/** Her lines the games need, from her line file (lines/<star>.json); the API passes them, the engine never loads them. */
export interface GameTables {
  /** アリス's bargaining tree (`bargain.branches`). */
  bargain?: { branches: { id: string; reply: SceneText[] }[] } | null;
  /** Her in-character refusals (`refuse`, kind `line`), for a bargain that crossed the line. */
  refusals?: SceneText[];
  /** うんぱい's reactions (`danmaku`): the quoting part, if the kind quotes him, and what she says after it. */
  danmaku?: { id: string; kind: string; quote?: SceneText; text: SceneText }[] | null;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

// ---------------------------------------------------------------- the script's config

export interface PraiseConfig { scores: Record<PraiseTier, number>; attempt: number }
export function praiseConfig(step: MinigameStep): PraiseConfig {
  const c = step.config as { scores?: Record<string, unknown>; attempt?: unknown };
  const d = MINIGAME_RULES.praiseScores;
  return {
    scores: { generic: int(c.scores?.generic, 0, 100) ?? d.generic, specific: int(c.scores?.specific, 0, 100) ?? d.specific },
    attempt: int(c.attempt, 1, 5) ?? 1
  };
}

export interface OgiriConfig { of: number; pass: number | null; round: number; bank: string | null }
export function ogiriConfig(step: MinigameStep): OgiriConfig {
  const c = step.config as { scale?: unknown; passScore?: unknown; round?: unknown; bank?: unknown };
  const of = int(c.scale, 2, 100) ?? MINIGAME_RULES.ogiriScale;
  return { of, pass: int(c.passScore, 1, of), round: int(c.round, 1, 20) ?? 1, bank: typeof c.bank === 'string' ? c.bank : null };
}

/** Which branch of her tree answers each move (`config.moves`: move → branch id). */
export function bargainMoves(step: MinigameStep): Partial<Record<BargainMove, string>> {
  const m = (step.config as { moves?: Record<string, unknown> }).moves ?? {};
  const out: Partial<Record<BargainMove, string>> = {};
  for (const move of BARGAIN_MOVES) if (typeof m[move] === 'string') out[move] = m[move] as string;
  return out;
}

// ---------------------------------------------------------------- reading the judge

/**
 * The persona service's answer (`{ label, score?, reason?, comment? }`), read defensively: anything malformed, of
 * another kind or out of range is null, and null is read safely by `judgeAnswer`.
 */
export function readMinigameCall(kind: JudgedMinigame, raw: unknown, scale: number = MINIGAME_RULES.ogiriScale): MinigameCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== undefined && r.kind !== kind) return null;
  const label = typeof r.label === 'string' ? r.label.trim().toLowerCase().replace(/[\s-]/g, '_') : null;
  const over = label === 'over_line';
  switch (kind) {
    case 'praise': {
      const tier = over ? 'generic' : oneOf(PRAISE_TIERS, label);
      if (!tier) return null;
      const reason = over ? 'over_line' : oneOf(PRAISE_REASONS, r.reason) ?? (tier === 'specific' ? 'detail' : 'generic');
      return { kind, tier, reason };
    }
    case 'ogiri': {
      if (over) return { kind, score: 1, comment: null };
      const score = num(r.score);
      if (score === null || score < 1 || score > scale) return null;
      const comment = typeof r.comment === 'string' && r.comment.trim() ? r.comment.trim().replace(/\s+/g, ' ').slice(0, 80) : null;
      return { kind, score: Math.round(score), comment };
    }
    case 'bargain': {
      const move = oneOf(BARGAIN_MOVES, label);
      return move ? { kind, move } : null;
    }
    case 'danmaku': {
      const l = oneOf(DANMAKU_LABELS, over ? 'over-line' : label);
      return l ? { kind, label: l } : null;
    }
  }
}

// ---------------------------------------------------------------- うんぱい's reactions

/** His comment as she reads it: one line, no brackets of its own (hers go around it), cut at MINIGAME_RULES.danmakuQuoteChars. */
export function quoteComment(text: string): string {
  const flat = text.replace(/[『』「」“”"]/g, '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  const max = MINIGAME_RULES.danmakuQuoteChars;
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

const mapText = (t: SceneText, f: (s: string) => string): SceneText =>
  ({ ja: f(t.ja), 'zh-Hant': f(t['zh-Hant']), en: f(t.en), ...(t.ko ? { ko: f(t.ko) } : {}) });
const fill = (t: SceneText, quote: string): SceneText => mapText(t, (s) => s.split('{danmaku}').join(quote));

/**
 * Her reaction to one comment, as the lines she says: the template's quote with his comment in it (only her runtime
 * voice can say that, #73; otherwise a subtitle), then its recorded `text` (#83). `label` null = it could not be
 * judged: acknowledged without being read back (the `text` alone), since nobody checked it. Over the line: a template
 * that quotes nothing. `n` rotates through the templates of a kind. Empty when she has no template for it.
 */
export function danmakuReply(templates: GameTables['danmaku'], label: DanmakuLabel | null, text: string, n = 0): SceneText[] {
  const all = templates ?? [];
  const of = (kind: string) => all.filter((t) => t.kind === kind);
  const pick = <T>(list: T[]): T | undefined => list[((n % list.length) + list.length) % list.length];
  if (label === 'over-line') { const t = pick(of('over-line')); return t ? [t.text] : []; }
  if (label === null) { const t = pick(of('greet')); return t ? [t.text] : []; }
  const t = pick(of(label)) ?? pick(of('greet'));
  if (!t) return [];
  return t.quote ? [fill(t.quote, quoteComment(text)), t.text] : [t.text];
}

// ---------------------------------------------------------------- the verdict

/** Stable, small hash (template rotation): the same comment gets the same reaction on a retry. */
function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h;
}

/**
 * His answer to a judged mini-game, decided: the result the engine stores, her lines in reaction, and what it grants.
 * `call` null (the judge was down, slow or answered nonsense) is read safely — see the module comment.
 */
export function judgeAnswer(step: MinigameStep, text: string, call: MinigameCall | null, tables: GameTables = {}): Judged {
  const c = call && call.kind === step.kind ? call : null;
  const source = c ? 'agent' : 'fallback';
  switch (step.kind) {
    case 'praise': {
      const cfg = praiseConfig(step);
      const tier = c?.kind === 'praise' ? c.tier : 'generic';
      const reason = c?.kind === 'praise' ? c.reason : 'generic';
      return {
        result: { kind: 'praise', tier, reason, score: cfg.scores[tier], attempt: cfg.attempt, result: tier === 'specific' ? 'win' : 'lose' },
        reply: [], effect: null, source
      };
    }
    case 'ogiri': {
      const cfg = ogiriConfig(step);
      const score = c?.kind === 'ogiri' ? Math.min(cfg.of, Math.max(1, c.score)) : Math.max(1, Math.round(cfg.of * MINIGAME_RULES.ogiriFallbackShare));
      const affinity = Math.round(score * MINIGAME_RULES.ogiriAffinityPerPoint);
      const comment = c?.kind === 'ogiri' ? c.comment : null;
      return {
        result: { kind: 'ogiri', score, of: cfg.of, pass: cfg.pass, result: cfg.pass === null ? 'draw' : score >= cfg.pass ? 'win' : 'lose' },
        reply: comment ? [{ ja: comment, 'zh-Hant': comment, en: comment, ko: comment }] : [],
        effect: affinity > 0 ? { affinity } : null,
        source
      };
    }
    case 'bargain': {
      const move = c?.kind === 'bargain' ? c.move : 'other';
      const branch = bargainMoves(step)[move];
      const reply = move === 'over_line' ? (tables.refusals ?? []).slice(0, 1)
        : move === 'please' || move === 'bribe' ? tables.bargain?.branches.find((b) => b.id === branch)?.reply ?? [] : [];
      return { result: { kind: 'bargain', move, result: move === 'alternative' ? 'win' : 'lose' }, reply, effect: null, source };
    }
    case 'danmaku': {
      const label = c?.kind === 'danmaku' ? c.label : null;
      const n = int((step.config as { comment?: unknown }).comment, 0, 99) ?? 0;
      return {
        result: { kind: 'danmaku', label, read: label !== null && label !== 'over-line', result: label === 'over-line' ? 'lose' : 'win' },
        reply: danmakuReply(tables.danmaku, label, text, n + hash(text)), effect: null, source
      };
    }
    default:
      throw new Error(`not a judged mini-game: ${step.kind}`);
  }
}

// ---------------------------------------------------------------- what the judge needs to know

/** An ōgiri prompt from her bank, not one already asked in this run. */
export function pickPrompt<P extends { id: string }>(bank: readonly P[], used: readonly string[], rng: () => number = Math.random): P | null {
  const fresh = bank.filter((p) => !used.includes(p.id));
  const from = fresh.length ? fresh : bank;
  if (!from.length) return null;
  return from[Math.min(from.length - 1, Math.floor(rng() * from.length))];
}

/**
 * What she said before the step now waiting, oldest first, up to `maxChars` (the most recent kept): the reading 奈々's
 * praise is about. Built from the run's `path`, so a second attempt still sees the reading.
 */
export function heardBefore(script: SceneScript, path: readonly string[], lang: string, maxChars = 1500): string {
  const byId = new Map(script.steps.map((s) => [s.id, s]));
  const lines = path.flatMap((id) => {
    const s = byId.get(id);
    return s?.type === 'line' ? [localText(s.text, lang)] : [];
  });
  const out: string[] = [];
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && n + lines[i].length <= maxChars; i--) { out.unshift(lines[i]); n += lines[i].length + 1; }
  return out.join('\n');
}
