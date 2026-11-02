import type { SceneStep, ChoiceStep, InputStep, MinigameStep } from './schema';

/** Steps that wait for him. */
export const isInteractive = (s: SceneStep): s is ChoiceStep | InputStep | MinigameStep =>
  s.type === 'choice' || s.type === 'input' || s.type === 'minigame';

/** Every step a step can lead to. */
export function targetsOf(s: SceneStep, fallthrough: string | undefined): string[] {
  switch (s.type) {
    case 'end': return [];
    case 'choice': return [...s.options.map((o) => o.next), ...(s.onTimeout ? [s.onTimeout] : [])];
    case 'input': return [s.next, ...(s.onTimeout ? [s.onTimeout] : []), ...(s.jumps ?? []).map((j) => j.to), ...Object.values(s.outcomes ?? {})];
    case 'minigame': return [s.next, ...Object.values(s.outcomes ?? {}).filter((x): x is string => !!x)];
    default: return s.next ? [s.next] : fallthrough ? [fallthrough] : [];
  }
}
