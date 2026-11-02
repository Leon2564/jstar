import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0', '']).default('false').transform((v) => v === 'true' || v === '1');

/** SERIAL_HMAC_KEY: development only. Production uses the key tools/luckcards generated the printed codes with. */
const DEV_DEFAULTS = {
  JWT_SECRET: 'dev-secret-change-me',
  SERIAL_HMAC_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
  AGENT_API_KEY: 'change-me'
} as const;

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(8080),
  PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_ADMIN_ORIGIN: z.string().default('http://localhost:5174'),
  JWT_SECRET: z.string().min(8).default(DEV_DEFAULTS.JWT_SECRET),
  SESSION_TTL_HOURS: z.coerce.number().default(720),
  OTP_TTL_MINUTES: z.coerce.number().default(10),
  /** Hex HMAC-SHA256 key of the printed lucky-card codes (tools/luckcards/out/code-hmac.secret). Losing it voids every printed code. */
  SERIAL_HMAC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'SERIAL_HMAC_KEY must be 64 hex characters').default(DEV_DEFAULTS.SERIAL_HMAC_KEY),
  /** memory: tests and `npm run demo`. d1: Cloudflare D1 through the Worker at DB_URL (production). */
  DB: z.enum(['memory', 'd1']).default('memory'),
  DB_URL: z.string().default('http://db.internal'),
  AGENT_BASE_URL: z.string().default('http://localhost:8100'),
  AGENT_API_KEY: z.string().default(DEV_DEFAULTS.AGENT_API_KEY),
  /** Fixed OTP, seeded demo serial codes and a demo admin, payments credited instantly. Never in production. */
  DEMO_MODE: bool,
  /** Mail relay for sign-in codes (the Worker's Email Service binding). Required unless DEMO_MODE. */
  MAIL_URL: z.string().default(''),
  /** Turnstile check through the Worker; empty = challenges off. TURNSTILE_SITEKEY is public (sent to the web app). */
  TURNSTILE_URL: z.string().default(''),
  TURNSTILE_SITEKEY: z.string().default(''),
  /**
   * Web Push (#50). Both keys set = push on; either missing (or malformed) = push off: /v1/config sends no key, so
   * the web app never offers notifications, and nothing crashes. The public key is public; the private key is a
   * Worker secret. Generate a pair with `npx web-push generate-vapid-keys`; rotating it orphans every subscription.
   */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  /** Contact for the push services (mailto: or https:), sent inside every VAPID token. */
  VAPID_SUBJECT: z.string().default('mailto:noreply@jstarcards.ai'),
  /** Relay to the push services (the Worker: the container has no internet). Empty = call them directly (local dev). */
  PUSH_URL: z.string().default(''),
  /** Relay to Open-Meteo for the weather (#62; the Worker: the container has no internet). Empty = call it directly (local dev). */
  WEATHER_URL: z.string().default(''),
  /** Speech to text for voice input (#72): the Worker's Workers AI relay. Empty = off; browsers with their own recogniser still talk. */
  ASR_URL: z.string().default(''),
  /**
   * Her runtime voice (#73): the Worker's TTS relay (http://tts.internal), set only when the Worker has a vendor
   * configured. Empty = provider `none`: her lines stay subtitles. The vendor key never reaches the container.
   */
  TTS_URL: z.string().default(''),
  /** Local preview only: the API reuses the production Worker's Fish adapter without exposing its key to the web app. */
  TTS_PROVIDER: z.string().default(''),
  TTS_API_KEY: z.string().default(''),
  TTS_VOICES: z.string().default(''),
  FISH_API_KEY: z.string().default(''),
  FISH_TTS_MODEL: z.string().default(''),
  FISH_TTS_LATENCY: z.string().default(''),
  FISH_TTS_URL: z.string().default(''),
  FISH_TTS_TEMPERATURE: z.string().default(''),
  FISH_TTS_TOP_P: z.string().default(''),
  FISH_ZH_HINT: z.string().default(''),
  /** Vidu S live avatar. The API key stays server-side; the browser only receives a short-lived RTC token. */
  VIDU_LIVE_BASE_URL: z.string().default('https://api.vidu.com'),
  VIDU_API_TOKEN: z.string().default(''),
  /** Local/private manifest produced by tools/vidu/provision.mjs. */
  VIDU_EIMI_MANIFEST: z.string().default('assets/agency/eimi/vidu.json'),
  VIDU_EIMI_AVATAR_ID: z.string().default(''),
  VIDU_EIMI_VOICE: z.string().default(''),
  VIDU_MAHIRO_MANIFEST: z.string().default('assets/agency/mahiro/vidu.json'),
  VIDU_MAHIRO_AVATAR_ID: z.string().default(''),
  VIDU_MAHIRO_VOICE: z.string().default(''),
  VIDU_NANA_MANIFEST: z.string().default('assets/agency/nana/vidu.json'),
  VIDU_NANA_AVATAR_ID: z.string().default(''),
  VIDU_NANA_VOICE: z.string().default(''),
  VIDU_UNPAI_MANIFEST: z.string().default('assets/agency/unpai/vidu.json'),
  VIDU_UNPAI_AVATAR_ID: z.string().default(''),
  VIDU_UNPAI_VOICE: z.string().default(''),
  VIDU_ALICE_MANIFEST: z.string().default('assets/agency/alice/vidu.json'),
  VIDU_ALICE_AVATAR_ID: z.string().default(''),
  VIDU_ALICE_VOICE: z.string().default(''),
  /**
   * With TTS_URL: the talents with a cloned voice (comma-separated, from the Worker's TTS_VOICES). Unset with a relay =
   * all five (the relay still answers `no_voice` for one without).
   */
  TTS_STARS: z.string().optional(),
  /**
   * His memory files (#51): the Worker's relay to the private R2 bucket `MEMORY` (http://memory.internal), called with
   * AGENT_API_KEY. Empty = no store: recordings stay base64 in D1 (local dev, tests, a deploy without the bucket).
   */
  MEMORY_URL: z.string().default(''),
  /** Origin the links in his export point at (the API's public origin). Empty = the origin the request came in on. */
  PUBLIC_API_ORIGIN: z.string().default(''),
  /** Comma-separated addresses that are made admins when they sign in by e-mail. */
  ADMIN_EMAILS: z.string().default(''),
  /** Only when the API sits behind a proxy that overwrites X-Forwarded-For; otherwise clients could spoof their IP past the rate limits. */
  TRUST_PROXY: bool
});

export type Env = z.infer<typeof Env>;

/**
 * Refuses to boot production with anything that only makes sense on a laptop. A persistent database with the
 * development code key is refused in any mode: every printed code would be rejected as not found.
 */
export function assertProductionSafe(e: Env): void {
  if (e.DB === 'd1' && e.SERIAL_HMAC_KEY === DEV_DEFAULTS.SERIAL_HMAC_KEY) throw new Error('unsafe config: SERIAL_HMAC_KEY is the development default while DB=d1');
  if (e.NODE_ENV !== 'production') return;
  const problems = [
    ...Object.entries(DEV_DEFAULTS).filter(([k, v]) => e[k as keyof typeof DEV_DEFAULTS] === v).map(([k]) => `${k} is the development default`),
    ...(e.DEMO_MODE ? ['DEMO_MODE must be off'] : []),
    ...(e.MAIL_URL ? [] : ['MAIL_URL is required to send sign-in codes'])
  ];
  if (problems.length) throw new Error(`unsafe production config: ${problems.join('; ')}`);
}

/** Parses settings the way the API does at boot (the tests check what the Worker gives each stage). */
export const parseEnv = (source: Record<string, string | undefined>): Env => Env.parse(source);

export const env: Env = parseEnv(process.env);
assertProductionSafe(env);
