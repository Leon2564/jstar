const DEFAULT_REACTIONS = ['a', 'b', 'c'] as const;
const COMPLETE_REACTIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;

/** The approved feedback set available for each talent. */
export const reactionKeysFor = (star: string): readonly string[] =>
  star === 'alice' || star === 'eimi' || star === 'mahiro' || star === 'nana' || star === 'unpai' ? COMPLETE_REACTIONS : DEFAULT_REACTIONS;

/** Approved feedback sets use one high-resolution landscape master in both layouts. */
export const usesLandscapeFeedback = (base: string): boolean => /^(alice|eimi|mahiro|nana|unpai)-(idle|react-[a-j])$/.test(base);
