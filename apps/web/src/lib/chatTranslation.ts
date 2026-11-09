import { useEffect, useState } from 'react';
import type { Lang } from '../i18n';
import type { Msg } from './state';

const cache = new Map<string, string>();
const pending = new Set<string>();
const keyOf = (lang: Lang, text: string) => `${lang}\u0000${text}`;
const isTest = () => import.meta.env.MODE === 'test' || !!(window as unknown as { __E2E__?: boolean }).__E2E__;

async function translate(texts: string[], lang: Lang): Promise<string[] | null> {
  try {
    const response = await fetch('/v1/agent/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang, texts })
    });
    if (!response.ok) return null;
    const data = await response.json() as { texts?: unknown };
    return Array.isArray(data.texts) && data.texts.length === texts.length
      && data.texts.every((text) => typeof text === 'string' && text.trim()) ? data.texts as string[] : null;
  } catch {
    return null;
  }
}

/** Display translations follow the selected locale; stored lines remain the originals used for speech and history. */
export function useChatTranslations(messages: Msg[], lang: Lang): (text: string) => string {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (isTest()) return;
    const texts = [...new Set(messages.filter((m) => m.from === 'her' && m.kind !== 'memory').map((m) => m.text))]
      .filter((text) => text.trim() && !(lang === 'ja' && /[\u3040-\u30ff]/.test(text)))
      .filter((text) => !cache.has(keyOf(lang, text)) && !pending.has(keyOf(lang, text)));
    const batches: string[][] = [];
    for (const text of texts) {
      const batch = batches[batches.length - 1];
      if (!batch || batch.length === 16 || batch.join('').length + text.length > 4000) batches.push([text]);
      else batch.push(text);
    }
    for (const batch of batches) {
      for (const text of batch) pending.add(keyOf(lang, text));
      void translate(batch, lang).then((translated) => {
        batch.forEach((text, index) => {
          const key = keyOf(lang, text);
          cache.set(key, translated?.[index] || text);
          pending.delete(key);
        });
        while (cache.size > 1000) cache.delete(cache.keys().next().value!);
        refresh((value) => value + 1);
      });
    }
  }, [messages, lang]);
  return (text: string) => {
    if (isTest() || (lang === 'ja' && /[\u3040-\u30ff]/.test(text))) return text;
    return cache.get(keyOf(lang, text)) ?? '…';
  };
}
