/**
 * Invisible Cloudflare Turnstile, loaded only when the API asks for it (403 `challenge_required`): sign-in mail,
 * a device's first trial message, and after two wrong lucky-card codes. Nothing is loaded for anyone else.
 */
type Turnstile = {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  remove(id: string): void;
};
declare global { interface Window { turnstile?: Turnstile } }

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let siteKey: string | null = null;
let loading: Promise<Turnstile | null> | null = null;
const INTERACTIVE_MS = 120_000;

export const setTurnstileKey = (key: string | null | undefined) => { siteKey = key || null; };
export const turnstileAvailable = () => !!siteKey;

function load(): Promise<Turnstile | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve(window.turnstile ?? null);
    s.onerror = () => { loading = null; resolve(null); };
    document.head.appendChild(s);
  });
  return loading;
}

/** A fresh single-use token, or null when Turnstile cannot run (blocked script, timeout). */
export async function turnstileToken(timeoutMs = 15_000): Promise<string | null> {
  if (!siteKey) return null;
  const ts = await load();
  if (!ts) return null;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647';
  document.body.appendChild(host);
  return new Promise((resolve) => {
    let id = '';
    let settled = false;
    const done = (token: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Remove on the next tick: removing inside Turnstile's own callback makes it throw on its follow-up reset.
      setTimeout(() => { try { if (id) ts.remove(id); } catch { /* already gone */ } host.remove(); }, 0);
      resolve(token);
    };
    let timer = setTimeout(() => done(null), timeoutMs);
    try {
      id = ts.render(host, {
        sitekey: siteKey, execution: 'execute', appearance: 'interaction-only',
        // Tokens are single use and requested per action: never let the widget refresh itself behind our back.
        'refresh-expired': 'never', 'refresh-timeout': 'never', retry: 'never',
        // A visible challenge needs the visitor: give them time to answer it.
        'before-interactive-callback': () => { clearTimeout(timer); timer = setTimeout(() => done(null), INTERACTIVE_MS); },
        callback: (token: string) => done(token), 'error-callback': () => done(null), 'timeout-callback': () => done(null)
      });
      ts.execute(id);
    } catch { done(null); }
  });
}
