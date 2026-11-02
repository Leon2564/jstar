/**
 * The mic next to every text box where he talks to her (chat, scenes). See lib/voice.ts for how it listens.
 * The text box itself is the live preview: while he talks it shows his words, and typing into it takes over.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { canWaitForVoice, handsFreeOn, setHandsFree, waitForVoice } from '../lib/handsFree';
import type { Key } from '../i18n';
import { createVoice, serverEngine, voiceEngines, type VoiceController, type VoiceNotice, type VoiceSnapshot } from '../lib/voice';
import { useT } from '../lib/store';
import { asrOn, transcribeClip } from '../services/api';
import { Icon } from './ui';

export interface Voice extends VoiceSnapshot { available: boolean; listening: boolean; ctl: VoiceController }

/**
 * `keep`: he asked for this recording to be kept (her confession, #55). The recording recogniser then goes first —
 * it is the one that has a clip to keep — and hands the clip over as it sends it to be heard. Where it cannot run,
 * the browser's own recogniser still hears him and nothing is kept.
 */
const engines = (keep?: { current?: (clip: Blob) => void }) => {
  const list = voiceEngines(asrOn() ? serverEngine(keep ? (clip, lang) => { keep.current?.(clip); return transcribeClip(clip, lang); } : transcribeClip) : null);
  return keep ? [...list.filter((e) => e.kind === 'server'), ...list.filter((e) => e.kind !== 'server')] : list;
};

/**
 * `onStart`: he began to talk (stop her). `onFinal`: what he said. `onNotice`: a message for him when it did not
 * work; after a refused or missing microphone, `field` gets the focus so he can type instead.
 */
export function useVoice({ onStart, onFinal, onNotice, field, keep, auto }: {
  onStart?: () => void; onFinal: (text: string) => void; onNotice?: (msg: string) => void; field?: React.RefObject<HTMLInputElement | null>;
  keep?: (clip: Blob) => void;
  /** Hands-free (#72): set while listening was started by his voice, not his hand — then "didn't catch that" is not said. */
  auto?: React.MutableRefObject<boolean>;
}): Voice {
  const t = useT();
  const latest = useRef({ onStart, onFinal, onNotice, field, t, auto });
  latest.current = { onStart, onFinal, onNotice, field, t, auto };
  const [snap, setSnap] = useState<VoiceSnapshot>({ phase: 'idle', text: '', blocked: false });
  const keepRef = useRef(keep);
  keepRef.current = keep;
  const keeping = !!keep;
  const [options, setOptions] = useState(() => engines(keeping ? keepRef : undefined));
  // Only a change of his choice re-picks the recognisers: a new list replaces the controller, which must not happen
  // under a press.
  const kept = useRef(keeping);
  useEffect(() => {
    if (kept.current === keeping) return;
    kept.current = keeping;
    setOptions(engines(keeping ? keepRef : undefined));
  }, [keeping]);
  const ctl = useMemo(() => createVoice({
    lang: t.lang,
    engines: options,
    onStart: () => latest.current.onStart?.(),
    onFinal: (text) => { if (latest.current.auto) latest.current.auto.current = false; latest.current.onFinal(text); },
    onChange: setSnap,
    onNotice: (n: VoiceNotice) => {
      const cur = latest.current;
      // A noise that woke hands-free listening was not him talking: it just waits again, without a word.
      const woken = !!cur.auto?.current;
      if (cur.auto) cur.auto.current = false;
      if (woken && n === 'noSpeech') return;
      cur.onNotice?.(cur.t(`voice.${n}` as Key));
      if (n === 'denied' || n === 'noMic') cur.field?.current?.focus({ preventScroll: true });
      // A recogniser that turned out to be unusable here is dropped (and with none left, the mic goes).
      if (n === 'failed') setOptions(engines(keepRef.current ? keepRef : undefined));
    }
  }), [t.lang, options]);
  useEffect(() => () => ctl.dispose(), [ctl]);
  return { ...snap, available: options.length > 0, listening: snap.phase !== 'idle', ctl };
}

/**
 * Hold to talk (let go to send), or tap to start and tap again to stop; Enter / Space toggle it for keyboards and
 * switch access. Hidden where the browser can do neither speech recognition nor recording.
 */
export function MicButton({ voice, className, disabled }: { voice: Voice; className: string; disabled?: boolean }) {
  const t = useT();
  if (!voice.available) return null;
  const on = voice.listening;
  return (
    <button type="button" className={className} disabled={disabled} data-testid="mic" data-phase={voice.phase}
      aria-label={t(on ? 'voice.stop' : 'voice.start')} aria-pressed={on}
      onPointerDown={(e) => {
        if (e.button > 0) return;
        // The release still lands here when the finger slides off the button.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        voice.ctl.press();
      }}
      onPointerUp={() => voice.ctl.release()}
      onPointerCancel={() => voice.ctl.release()}
      // Pointer presses are handled above; a click without a pointer (detail 0) is a keyboard or switch.
      onClick={(e) => { if (e.detail === 0) voice.ctl.toggle(); }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', ...(on ? { background: 'var(--rose)', color: 'var(--navy-deep)', opacity: 1 } : {}) } as React.CSSProperties}>
      <Icon name="mic" size={18} />
    </button>
  );
}

/**
 * Hands-free (#72, optional): while `armed` (her line is over, nothing is on its way) and he turned it on, the mic waits
 * for his voice and starts listening by itself; the ordinary input then stops on silence and sends. A refused mic
 * turns it off again. `auto` is the flag useVoice reads (see there). Returns whether it is on, and the switch.
 */
export function useHandsFree(voice: Voice, armed: boolean, auto: React.MutableRefObject<boolean>, notify?: (msg: string) => void): [boolean, (on: boolean) => void, boolean] {
  const t = useT();
  const [on, setOn] = useState(handsFreeOn);
  const possible = voice.available && canWaitForVoice();
  const ctl = voice.ctl;
  const latest = useRef({ notify, t });
  latest.current = { notify, t };
  useEffect(() => {
    if (!on || !armed || !possible || voice.phase !== 'idle' || voice.blocked) return undefined;
    return waitForVoice(() => { auto.current = true; ctl.toggle(); }, (e) => {
      setOn(false);
      setHandsFree(false);
      latest.current.notify?.(latest.current.t(e === 'denied' ? 'voice.denied' : 'voice.failed'));
    });
  }, [on, armed, possible, voice.phase, voice.blocked, ctl, auto]);
  const set = (next: boolean) => { setOn(next); setHandsFree(next); };
  return [on && possible, set, possible];
}

/** The hands-free switch, next to the mic. Hidden where the browser cannot listen by itself. */
export function HandsFreeToggle({ on, set, possible, className }: { on: boolean; set: (on: boolean) => void; possible: boolean; className: string }) {
  const t = useT();
  if (!possible) return null;
  return (
    <button type="button" className={className} aria-pressed={on} data-testid="hands-free" aria-label={t('voice.handsFree')} title={t(on ? 'voice.handsFreeOn' : 'voice.handsFree')}
      onClick={() => set(!on)} style={on ? { background: 'var(--rose)', color: 'var(--navy-deep)', opacity: 1 } : { opacity: 0.75 }}>
      <Icon name="ear" size={18} />
    </button>
  );
}
