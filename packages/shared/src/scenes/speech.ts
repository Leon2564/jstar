/**
 * What she says for a line step, and how (#73 runtime voice, #83 recordings). A line with `{name}` (#56) can only be
 * voiced at runtime; its `text.unnamed` is the same moment without his name, recorded ahead, so when the runtime voice
 * is off the moment still has her voice. No zod, like the engine.
 */
import { localText } from '../domain';
import type { LineStep, SceneText } from './schema';

/** Placeholders her runtime voice fills (lines/schema.ts LINE_PLACEHOLDERS): such a text cannot be recorded ahead. */
export const needsRuntimeVoice = (t: Pick<SceneText, 'ja'>): boolean => /\{(name|danmaku)\}/.test(t.ja);

export interface SpokenLine {
  /** The subtitle, in his language, with his name filled in. */
  text: string;
  /** Her recording to play, when there is one. */
  voice?: string;
  /** Speak `text` with her runtime voice (#73). */
  runtime: boolean;
}

/**
 * The line as she says it now. `runtimeVoice`: her runtime voice is on for him and can speak (his account, sound on,
 * voice time left). A recorded line plays its recording; a line only the runtime voice can say (her free-talk reply,
 * a `tts` line, one with his name) is spoken at runtime when it can be — otherwise a `{name}` line says its `unnamed`
 * version once that is recorded (until then his name stays in the subtitle), and anything else is a subtitle.
 */
export function lineToSay(step: Pick<LineStep, 'text' | 'voice' | 'tts' | 'agent'>, o: { lang: string; name: string; runtimeVoice: boolean; you?: string }): SpokenLine {
  // No name of his known (round 10): never one made up — her line without it when there is one, else 「きみ」/you.
  const fill = (t: SceneText) => localText(t, o.lang).split('{name}').join(o.name || o.you || '');
  const named = needsRuntimeVoice(step.text);
  if (!o.name && named && step.text.unnamed) {
    const alt = step.text.unnamed;
    return { text: localText(alt, o.lang), ...(alt.voice ? { voice: alt.voice } : {}), runtime: false };
  }
  if (step.voice) return { text: fill(step.text), voice: step.voice, runtime: false };
  if (o.runtimeVoice && (step.tts || step.agent || named)) return { text: fill(step.text), runtime: true };
  const alt = named ? step.text.unnamed : undefined;
  if (alt?.voice) return { text: localText(alt, o.lang), voice: alt.voice, runtime: false };
  return { text: fill(step.text), ...(step.text.voice ? { voice: step.text.voice } : {}), runtime: false };
}
