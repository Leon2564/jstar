/**
 * QA #5: her lines for being touched in pure view (@jstar/shared/touch.json) are a JSON asset, fetched the first time
 * he touches her — not a module, so they stay out of the JS bundle (like the scene catalogue, data/media.ts).
 */
import TOUCH_URL from '@jstar/shared/touch.json?url';
import type { TouchLines } from '@jstar/shared/touch';

let loader: () => Promise<TouchLines> = async () => {
  const res = await fetch(TOUCH_URL);
  if (!res.ok) throw new Error(`touch_${res.status}`);
  return (await res.json()) as TouchLines;
};
let loaded: Promise<TouchLines> | null = null;

/** Her touch lines; null when they cannot be had (offline): she then reacts without a line. */
export function touchLines(): Promise<TouchLines | null> {
  loaded ??= loader();
  return loaded.catch(() => { loaded = null; return null; });
}

/** Tests: jsdom has no server for the asset. */
export function setTouchLoader(next: () => Promise<TouchLines>) { loader = next; loaded = null; }
