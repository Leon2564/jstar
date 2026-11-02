/**
 * Memory cards and promises in the language of the moment (N-09, N-20, N-25). A card keeps its title as it was made —
 * in the language the app had then — and these find the written text it came from, in every language:
 * her scenes' memories, her confession, her promises (her proposals and the ones her scenes end on). Words she said
 * in free chat (a model's) are not written anywhere, and stay as she said them.
 */
import { localText, type LocalText, type StarId } from './domain';
import { confessionOf } from './confession';
// Only her promises from the lines (named JSON imports): the web's memories chunk must not carry all her lines.
import { promises as mahiro } from './lines/mahiro.json';
import { promises as nana } from './lines/nana.json';
import { promises as unpai } from './lines/unpai.json';
import { promises as alice } from './lines/alice.json';
import { promises as eimi } from './lines/eimi.json';
import { CONFESSION_MEMORY_TITLE } from './scenes/confession';
import { SCENES, sceneById, scenesFor } from './scenes';
import { systemSceneOf } from './scenes/systemIds';
import { memories as SYSTEM_MEMORIES } from './lines/system.json';

const PROMISE_MAX = 40;
const clip = (text: string, max: number) => [...text.trim()].slice(0, max).join('');
const same = (t: LocalText, text: string, max: number) => Object.values(t).some((v) => typeof v === 'string' && clip(v, max) === text);

let stock: Map<StarId, LocalText[]> | null = null;
function stockPromises(star: StarId): LocalText[] {
  if (!stock) {
    stock = new Map();
    const add = (s: StarId, t: LocalText) => stock!.set(s, [...(stock!.get(s) ?? []), t]);
    const written: Record<StarId, { promise: LocalText }[]> = { mahiro, nana, unpai, alice, eimi };
    for (const [s, list] of Object.entries(written) as [StarId, { promise: LocalText }[]][]) for (const l of list) add(s, l.promise);
    const walk = (s: StarId, v: unknown): void => {
      if (Array.isArray(v)) { v.forEach((x) => walk(s, x)); return; }
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      const text = (o.promise as { text?: LocalText } | undefined)?.text;
      if (text && typeof text.ja === 'string') add(s, text);
      Object.values(o).forEach((x) => walk(s, x));
    };
    for (const script of SCENES) walk(script.meta.star as StarId, script.steps);
  }
  return stock.get(star) ?? [];
}

/** One of her written promises, in `lang` (`max`: the length it was kept at); anything else as it is. */
export function promiseTextIn(star: StarId, text: string, lang: string, max = PROMISE_MAX): string {
  const hit = stockPromises(star).find((t) => same(t, text, max));
  return hit ? clip(localText(hit, lang), max) : text;
}

export type MemoryKindT = 'chat' | 'scene' | 'promise' | 'confession';
export interface MemoryRef { star: StarId; title: string; kind?: MemoryKindT | null; sceneId?: string | null; still?: string | null }

/** The words of a text only — a scene text also carries its recording (`voice`) and a nameless take (`unnamed`). */
const words = (t: LocalText): LocalText => {
  const { ja, en, ko } = t;
  return { ja, 'zh-Hant': t['zh-Hant'], en, ...(ko ? { ko } : {}) };
};

/** Every memory a scene can make, in all its languages (her scenes, her variant and system scenes, her confession). */
function sceneMemories(sceneId: string): LocalText[] {
  if (confessionOf(sceneId)) return [CONFESSION_MEMORY_TITLE];
  const sys = systemSceneOf(sceneId);
  if (sys) return sys.kind in SYSTEM_MEMORIES ? [SYSTEM_MEMORIES[sys.kind as keyof typeof SYSTEM_MEMORIES]] : [];
  const script = sceneById(sceneId);
  return (script?.steps ?? []).flatMap((s) => (s.type === 'effect' && s.memory ? [words(s.memory.title as LocalText)] : []));
}

/** Every written memory of hers: to find a card that came without its scene (an older card, N-34). */
function allMemories(star: StarId): LocalText[] {
  return [
    CONFESSION_MEMORY_TITLE, ...Object.values(SYSTEM_MEMORIES),
    ...scenesFor(star).flatMap((s) => sceneMemories(s.meta.id))
  ];
}

/**
 * A memory card's title in `lang` (N-20, N-25, N-34). Keyed by its scene first: a scene with one memory gives its
 * title whatever language the card was made in; otherwise the card's words are matched, in any language. A written
 * promise of hers reads in `lang` too; a chat card (a model's title) and her free-chat promises stay as they are.
 */
export function memoryTitleIn(m: MemoryRef, lang: string): string {
  const clip40 = (t: LocalText) => clip(localText(t, lang), 40);
  if (m.kind === 'promise') return promiseTextIn(m.star, m.title, lang, 40);
  if (m.sceneId) {
    const own = sceneMemories(m.sceneId);
    if (own.length === 1) return clip40(own[0]);
    const hit = own.find((t) => same(t, m.title, 40));
    if (hit) return clip40(hit);
  }
  if (m.kind === 'chat') return m.title;
  const hit = allMemories(m.star).find((t) => same(t, m.title, 40));
  return hit ? clip40(hit) : promiseTextIn(m.star, m.title, lang, 40);
}

/**
 * A card's picture as a media id or family (N-25, N-34): its own still when this build has it, else the opening shot
 * of the scene it belongs to, else her home poster — every card has one. `has` says whether this build has a clip.
 */
export function memoryStillFor(m: MemoryRef, has: (id: string) => boolean = () => true): string {
  if (m.still && has(m.still)) return m.still;
  const script = m.sceneId ? sceneById(m.sceneId) : undefined;
  const first = script?.steps.find((s) => s.type === 'clip');
  const opening = (first && first.type === 'clip' ? first.media : undefined) ?? script?.meta.idle;
  return opening && has(opening) ? opening : `${m.star}-hero`;
}
