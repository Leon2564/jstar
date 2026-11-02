/**
 * Which kind of site a Worker is (the `STAGE` var in wrangler*.jsonc), and what that means for the API container.
 *
 * - unset → **production** (jstarcards.ai): real sign-in codes by e-mail, Turnstile, no demo codes or endpoints.
 * - `review` → **review** (nest.jstarcards.ai, where the owner reviews a release): the API runs exactly as in
 *   production (real codes mailed through the EMAIL binding, Turnstile, no demo data, endpoints or drafts, geo rules as
 *   production) on its own database, and the site stays out of search results. No reviewer or admin shortcuts.
 * - `test` → **demo** (test / v1.jstarcards.ai): the fixed code 123456, demo lucky codes, nothing mailed, no bot checks,
 *   drafts visible, `?geo=` previews.
 *
 * No Workers imports here, so the API's tests run these very functions (apps/api/tests/stage.test.ts).
 */

export type Stage = 'production' | 'review' | 'test';

export interface StageEnv {
  STAGE?: string;
  /** The host a non-production Worker serves (v1, test or nest.jstarcards.ai). */
  WEB_HOST?: string;
  ADMIN_EMAILS?: string;
  TURNSTILE_SECRET?: string;
}

export const APEX = 'jstarcards.ai';
/** The test site (wrangler.test.jsonc), the default host of a `test` Worker without WEB_HOST. */
export const TEST_HOST = `test.${APEX}`;
/** Host the API container sends mail through; answered by the Worker with the send_email binding. */
export const MAIL_HOST = 'mail.internal';
/** Host the API container verifies Turnstile tokens through; answered by the Worker, which holds the secret. */
export const TURNSTILE_HOST = 'turnstile.internal';
/** Invisible Turnstile widget "jstarcards.ai" (public site key); its domains are jstarcards.ai, www and nest. */
export const TURNSTILE_SITEKEY = '0x4AAAAAAFDnZKGvQloJEt0Y';

export function stageOf(env: Pick<StageEnv, 'STAGE'>): Stage {
  if (env.STAGE === 'test') return 'test';
  if (env.STAGE === 'review') return 'review';
  return 'production';
}

/** Demo mode: only the test stage. Review is production behaviour on a separate site. */
export const isDemoStage = (env: Pick<StageEnv, 'STAGE'>): boolean => stageOf(env) === 'test';

/** The origin the site is served on: WEB_HOST when set, otherwise the test host (demo) or the apex. */
export const webOrigin = (env: Pick<StageEnv, 'STAGE' | 'WEB_HOST'>): string => `https://${env.WEB_HOST ?? (isDemoStage(env) ? TEST_HOST : APEX)}`;

/**
 * The API container's mode settings. Demo: fixed code, demo codes, nothing mailed. Production and review: real codes
 * by e-mail (MAIL_URL is required by the API's own production check), admins by address, Turnstile whenever the
 * widget secret is set.
 */
export function apiModeVars(env: StageEnv): Record<string, string> {
  if (isDemoStage(env)) return { NODE_ENV: 'development', DEMO_MODE: 'true' };
  return {
    NODE_ENV: 'production',
    DEMO_MODE: 'false',
    MAIL_URL: `http://${MAIL_HOST}`,
    ADMIN_EMAILS: env.ADMIN_EMAILS ?? '',
    ...(env.TURNSTILE_SECRET ? { TURNSTILE_URL: `http://${TURNSTILE_HOST}`, TURNSTILE_SITEKEY } : {})
  };
}

/**
 * Whether a Turnstile token solved on `hostname` (siteverify's answer) counts on this Worker: a site accepts only
 * tokens from its own host, so a token solved on one site cannot be spent on another. Production is the apex and www;
 * any other Worker is its WEB_HOST. siteverify leaves the hostname out for test keys, which are accepted as before.
 */
export function turnstileHostOk(hostname: string | undefined, env: Pick<StageEnv, 'WEB_HOST'>): boolean {
  if (!hostname) return true;
  return env.WEB_HOST ? hostname === env.WEB_HOST : hostname === APEX || hostname === `www.${APEX}`;
}

/** Search engines stay out of every site but production. */
export const noindex = (env: Pick<StageEnv, 'STAGE'>): boolean => stageOf(env) !== 'production';

/**
 * `POST /v1/ops/restart` on the site's own host (with the AGENT_API_KEY bearer): the deploy script restarts the
 * containers there on every non-production site. Production restarts through the admin Worker only.
 */
export const restartOnHost = (env: Pick<StageEnv, 'STAGE'>): boolean => stageOf(env) !== 'production';

/** `?geo=KR` previews the region notice on the demo sites only; review applies the geo rules as production does. */
export const geoPreview = (env: Pick<StageEnv, 'STAGE'>): boolean => isDemoStage(env);
