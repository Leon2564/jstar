/**
 * His memories as assets (#51, docs/compliance-jp.md §7.6): the memory cards (chat, scene, confession, promise), the
 * recording of his yes (#55) and, later, a scene's still. They are his: kept safely, exportable at any time, gone
 * when he leaves. No zod here, so the web can import it without the validator.
 */

/** Where a memory card came from: a chat (every few messages), a scene's ending, his yes to her confession, a promise kept. */
export const MEMORY_KINDS = ['chat', 'scene', 'confession', 'promise'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * 待确认 (#84, 法务): how long a kept recording stays and how long an export's links live are the owner's and the
 * lawyer's to decide. Until then nothing is deleted on a timer: a recording stays until he deletes it or leaves.
 */
export const MEMORY_RULES = {
  /**
   * memoryRetentionDays 待确认: days a kept recording (and, later, a scene still) is kept after he chose to keep it;
   * the memory card and his words stay. null = no deletion on a timer (the default until #84 decides).
   */
  retentionDays: null as number | null,
  /** Exports per JST day (the issue's acceptance: a second request the same day answers 429). */
  exportsPerDay: 1,
  /** exportLinkHours 待确认: how long the signed links to his files inside an export work. */
  linkTtlMs: 24 * 3_600_000,
  /** Newest chat messages exported per talent (the whole history of an ordinary account fits well within it). */
  exportChatPerTalent: 2000,
  /** Largest file the memory store accepts (the relay refuses bigger ones too): a recording is at most 768 KB. */
  maxFileBytes: 5 * 1024 * 1024
};

/** The file name an export is saved under: `jstar-memories-2026-11-02.json`. */
export const exportFileName = (day: string) => `jstar-memories-${day}.json`;

/**
 * Where the site serves a scene card's still (#51): the poster of the clip on screen when it was made, its portrait
 * take for a family (`mahiro-hero` → `mahiro-hero-9x16`), as on a phone. Clips made at high quality — her newer loops
 * and reactions (#24, #80), the scenes' own clips (#80), her variant footage (#81) and the system scenes' and her
 * confession's clips (#55, #71) — have `poster-hq.jpg`; her
 * older catalogue clips `poster.jpg` (apps/web/src/data/media.gen.ts, media.scene.gen.ts; the web unit test checks
 * every clip a script uses agrees).
 */
export function stillPosterPath(still: string): string {
  const id = /-\d+x\d+$/.test(still) ? still : `${still}-9x16`;
  const hq = /^(mahiro|nana|unpai|alice|eimi)-(scene|variant|herohd|idle|talk|talkclose|enter|react|sys|confession)-/.test(id);
  return `/media/${id}/${hq ? 'poster-hq.jpg' : 'poster.jpg'}`;
}
