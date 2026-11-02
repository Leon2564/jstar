/**
 * 思い出 → her confession (#55): the memory of his yes — his words and, if he chose to keep it, his voice. Only he
 * can play or delete the recording; it is fetched with his session and played from a blob URL, never a public link
 * (docs/compliance-jp.md §7.3). Server mode only: prototype mode keeps no recordings.
 */
import { useEffect, useRef, useState } from 'react';
import type { ConfessionMemoryT } from '@jstar/shared/contracts';
import { scriptLang } from '@jstar/shared/domain';
import { getStar } from '../data/cast';
import { dotSep, fmtDate, starName } from '../i18n';
import { useT } from '../lib/store';
import { confessionMemories, confessionVoice, forgetConfessionVoice } from '../services/api';

/**
 * His words as he said them (N-21): in another language than the page's, a quote labelled with the language he
 * said it in — 「あなたの答え（English）」 — never passed off as a translation.
 */
export function answerLine(text: string, t: ReturnType<typeof useT>): string {
  const said = scriptLang(text);
  if (!said || said === t.lang) return t('confession.memWords', { text });
  let name: string = said;
  try { name = new Intl.DisplayNames([t.lang], { type: 'language' }).of(said) ?? said; } catch { /* old browser: the code */ }
  return t('confession.memWordsIn', { text, lang: name });
}

export function ConfessionMemories({ onNotice }: { onNotice: (msg: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<ConfessionMemoryT[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const audio = useRef<{ el: HTMLAudioElement; url: string } | null>(null);

  useEffect(() => {
    let live = true;
    void confessionMemories().then((m) => { if (live) setItems(m); });
    return () => { live = false; };
  }, []);
  const stop = () => {
    audio.current?.el.pause();
    if (audio.current) URL.revokeObjectURL(audio.current.url);
    audio.current = null;
    setPlaying(null);
  };
  useEffect(() => stop, []);

  const play = async (id: string) => {
    stop();
    try {
      const url = URL.createObjectURL(await confessionVoice(id));
      const el = new Audio(url);
      audio.current = { el, url };
      el.onended = stop;
      setPlaying(id);
      await el.play();
    } catch {
      stop();
      onNotice(t('common.error'));
    }
  };
  const forget = async (id: string) => {
    if (confirm !== id) { setConfirm(id); return; }
    setConfirm(null);
    if (playing === id) stop();
    try {
      const m = await forgetConfessionVoice(id);
      setItems((all) => all.map((x) => (x.memoryId === id ? m : x)));
      onNotice(t('confession.removed'));
    } catch {
      onNotice(t('common.error'));
    }
  };

  if (!items.length) return null;
  return (
    <section className="pad" aria-labelledby="confession-mem" data-testid="confession-memories" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="confession-mem" className="serif" style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: '0.12em' }}>{t('confession.memTitle')}</h2>
      {items.map((m) => {
        const s = getStar(m.star);
        return (
          <article key={m.memoryId} className="panel" data-testid="confession-memory" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, minWidth: 0 }}>
            <span className="tiny muted">{starName(s, t.lang)}{dotSep(t.lang)}{fmtDate(m.createdAt, t.lang)}</span>
            <p className="serif" style={{ margin: 0, overflowWrap: 'anywhere' }} data-testid="confession-words">{answerLine(m.transcript, t)}</p>
            {m.audio ? (
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="btn btn-line" style={{ minHeight: 44, flex: '1 1 140px' }} aria-pressed={playing === m.memoryId}
                  onClick={() => (playing === m.memoryId ? stop() : void play(m.memoryId))}>{t(playing === m.memoryId ? 'confession.stop' : 'confession.play')}</button>
                <button type="button" className="btn btn-line" style={{ minHeight: 44, flex: '1 1 140px' }} data-testid="confession-forget"
                  onClick={() => void forget(m.memoryId)}>{t(confirm === m.memoryId ? 'confession.removeConfirm' : 'confession.remove')}</button>
              </span>
            ) : <span className="tiny muted">{t('confession.noAudio')}</span>}
          </article>
        );
      })}
    </section>
  );
}
