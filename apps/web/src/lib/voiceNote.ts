import { useEffect, useState } from 'react';
import { http } from '../services/http';

/**
 * #13: her message as a voice note in her runtime voice — her line as signed for him, asked for when he plays it (never
 * before: nothing is synthesized for a note he does not play). Null when it is not his to hear, or offline. (Only
 * shown where the server offers her runtime voice, so never asked for in prototype mode.)
 */
const signed = new Map<string, { line: string; sig: string }>();
export async function noteVoice(id: string): Promise<{ line: string; sig: string } | null> {
  const had = signed.get(id);
  if (had) return had;
  const r = await http.inboxVoice(id).catch(() => null);
  if (r?.mode !== 'voice') return null;
  const note = { line: r.line, sig: r.sig };
  signed.set(id, note);
  return note;
}

/**
 * Her voice note's length as A2 ② shows it, 「0:06」 (#165), read from the file once its header is in (he is about to
 * play it; the browser keeps it). '' until then, and for a file that does not load: no time rather than a wrong one.
 */
export function useNoteTime(src: string | null): string {
  const [t, setT] = useState<string[]>([]);
  useEffect(() => {
    if (!src) return;
    const a = new Audio(src);
    a.onloadedmetadata = () => {
      const s = Math.max(1, Math.round(a.duration));
      if (s < 6e3) setT([src, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`]);
    };
  }, [src]);
  // A late answer about the last note names its own file, so it never shows on this one.
  return t[0] === src ? t[1] : '';
}
