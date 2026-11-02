# Cloudflare deployment

## Standalone frontend + R2

The public frontend can be deployed independently with `wrangler.leon.jsonc`. The Worker serves the Vite application while the `jstar-media` R2 binding serves videos, card art, voice, audio, gifts and icons from their existing same-origin paths.

```bash
# Build the web application, then keep large runtime assets out of Workers Assets.
npm run build -w @jstar/web
node infra/cloudflare/scripts/prepare-leon.mjs

# Resumable upload of current runtime resources to R2.
node infra/cloudflare/scripts/upload-leon-r2.mjs

# Publish the Worker.
cd infra/cloudflare
wrangler deploy -c wrangler.leon.jsonc
```

Current deployment: <https://jstar-leon.lionellong.workers.dev/>

| Host | Worker | Serves |
|---|---|---|
| `jstarcards.ai` (`www` → 301) | `jstar-web` | `apps/web/dist`; `/v1/*` and `/health` → API container |
| `admin.jstarcards.ai` | `jstar-admin` | `apps/admin/dist`; `/v1/*` → `jstar-web` `AdminGateway` |
| `v1.` / `test.jstarcards.ai` | `jstar-v1` / `jstar-test` | the same Worker in demo mode (`STAGE=test`), own D1 and containers |
| `nest.jstarcards.ai` | `jstar-nest` | the same Worker in review mode (`STAGE=review`), own D1, R2, containers and secrets |

- **Containers** (Workers Paid): `Api` from `infra/api.Dockerfile`, `Agent` from `infra/agent.Dockerfile`, one instance each.
  The API reaches the agent at `http://agent.internal`, which the Worker answers (`outboundByHost`); the API container has no internet.
- **Data is in D1** (database `jstar`, binding `DB`). The API container has no binding of its own: it sends SQL to
  `http://db.internal`, which the Worker answers with `DB.batch` (one transaction per request). Schema:
  `apps/api/migrations`, applied by the deploy workflow before the new version goes live. Containers can sleep or be redeployed without losing anything.
- **Lucky-card codes** (tools/luckcards) live in D1 as HMAC hashes; the key is the Worker secret `SERIAL_HMAC_KEY`.
  The printed QR codes `/lucky` and `/r/<code>` redirect to the redeem page. Import a print batch (hashes only, idempotent):
  `node tools/luckcards/scripts/code-gen/d1-sql.mjs <hashed.csv> > codes.sql && npx wrangler d1 execute jstar --remote -c infra/cloudflare/wrangler.jsonc --file codes.sql`.
- **The API still runs with `DEMO_MODE=true`**: anyone can sign in to any e-mail with the fixed code `123456`.
  Turn it off (real OTP e-mail) before lucky cards go on sale.
- **Cron tick (every 5 minutes, `triggers.crons`)**: the Worker's `scheduled` handler calls the API container's
  `POST /v1/ops/tick` with `Authorization: Bearer $AGENT_API_KEY` (no new secret), which wakes the container if it
  sleeps and runs the jobs in `apps/api/src/jobs` (delivers her inbox, #49). Each tick is logged as `{"event":"tick"}`
  in the Workers logs. As a side effect the API container no longer reaches its 8 h sleep.
  Every other `/v1/ops/*` path answers 404 from the internet and through the admin console; only the deploy workflows' `/v1/ops/restart` is served.
- **`/v1/admin/*` is refused on `jstarcards.ai`**. Only the admin Worker can reach it, through the `AdminGateway` service binding.
- **`jstarcards.ai` is public.**
- **`admin.jstarcards.ai` asks for a password** (HTTP Basic, user `admin`, password `ADMIN_PASSWORD`).
  The console sends its API session as `X-Admin-Session` (built with `VITE_SESSION_HEADER`), because `Authorization` carries the password.
- `workers_dev` and `preview_urls` are off, so the custom domains are the only way in.

## Stages (`STAGE`, `src/stage.ts`)

| `STAGE` | Sites | Sign-in | Bots | Demo codes, data, endpoints, drafts | Search | `?geo=` preview |
|---|---|---|---|---|---|---|
| unset (production) | jstarcards.ai | a real one-time code by e-mail (`EMAIL` binding) | Turnstile | none | indexed | no |
| `review` | nest.jstarcards.ai | a real one-time code by e-mail (`EMAIL` binding) | Turnstile | none | `noindex` | no |
| `test` (demo) | v1, test | fixed code `123456`, nothing mailed | none | yes | `noindex` | yes |

**Review** is production behaviour on a site of its own, where the owner reviews a release before it goes further: the
API gets exactly the production settings (`NODE_ENV=production`, `DEMO_MODE=false`, `MAIL_URL`, Turnstile), so
`/v1/config` answers `"demo":false`, the demo menu and demo endpoints are gone, drafts do not play, and the birthday/age
gate and geo rules are production's. There are no reviewer or admin shortcuts; `ADMIN_EMAILS` is unset on Nest, so nobody
there is an admin (set it as a Worker secret to change that). The deploy script still restarts the containers on the
site's own host (`/v1/ops/restart` with the `AGENT_API_KEY` bearer), as on the demo sites.

- **Mail:** `send_email` binding `EMAIL` in `wrangler.nest.jsonc`, from `noreply@jstarcards.ai` like production.
- **Turnstile:** the invisible widget "jstarcards.ai" (`0x4AAAAAAFDnZKGvQloJEt0Y`) lists `jstarcards.ai`,
  `www.jstarcards.ai` and `nest.jstarcards.ai`; Nest's `TURNSTILE_SECRET` is that widget's secret (GitHub secret
  `NEST_TURNSTILE_SECRET`, written by `deploy-nest.yml`; `deploy.sh nest` refuses to run without it). Each Worker accepts
  only tokens solved on its own host: production the apex and www, any other site its `WEB_HOST`.
- **No demo data:** `deploy.sh nest` applies `review-stage.sql` after the migrations (voids the demo lucky codes and
  closes the demo admin that Nest's earlier demo mode seeded; idempotent, never run on the demo sites).
- **Review codes:** `scripts/nest-review-codes.sh [count]` makes lucky codes valid on Nest only (keyed with Nest's
  `SERIAL_HMAC_KEY`): each gives six cards (the first SR or better) and the 30-day monthly pass. Hashes go to `jstar-nest`
  only; the plain codes are appended to `.nest-review-codes.secret` at the repo root (gitignored, mode 600). From a
  worktree, `SECRETS_ROOT=<main checkout>` points it at the files there.
- **Smoke test** (`deploy.sh`): production and review both check `"env":"production"`, `"demo":false`, a Turnstile site
  key in `/v1/config`, 404 from a demo endpoint, the `/lucky` redirect and a `challenge_required` on a new device's first
  trial message; every site but production must send `x-robots-tag: noindex`.

## Local development

`npm run demo` at the repo root: no Docker needed, anywhere. The container images are built on the Mac by `scripts/build-images.sh` (Images workflow, or by hand), which reproduces the final stage of `infra/*.Dockerfile` on pinned bases without Docker.
There is no cron locally: run a tick by hand with `curl -X POST http://localhost:8080/v1/ops/tick` (demo mode needs no key).
A signed-in demo account can queue a message from her to itself with `POST /v1/inbox/demo {"star","text","inMinutes"}`.

## Build once, deploy everywhere

| Step | Where | What |
|---|---|---|
| `ci` check | Mac runner (`ci.yml`) | `scripts/ci-local.sh` on every PR and push |
| Images | self-hosted Mac (`images.yml` → `scripts/build-images.sh`) | only when the API or agent sources change: `jstar-api:<hash>` / `jstar-agent:<hash>`, the hash of their git trees (`scripts/image-tags.sh`) |
| v1 | Mac runner (`deploy-v1.yml`) | every main commit whose `ci` passed → v1.jstarcards.ai |
| test | Mac runner (`deploy-test.yml`) | on demand, any ref → test.jstarcards.ai |
| nest | Mac runner (`deploy-nest.yml`) | on demand, `--ref release/v1.1` → nest.jstarcards.ai (review) |
| production | Mac runner (`deploy.yml`) | a `v*` tag, only with the owner's OK → jstarcards.ai + admin, then a GitHub Release |

All of them deploy with `scripts/deploy.sh <v1|test|nest|prod>`. It:

1. Checks the gates. The commit's `ci` passed. For production, the commit is also live on an acceptance site: v1
   (commit status `deploy/v1`, the main line) or Nest (`deploy/nest`, the release line), with the same web build.
2. Uses the images already in the registry. Nothing is built with Docker, so the script also runs on a laptop.
3. Builds the web. The build is reproducible: production refuses a web hash different from the one v1 got.
4. Records a D1 Time Travel bookmark, then applies migrations.
5. Deploys with the version tag and commit (`VERSION` / `COMMIT` vars), waits for the container rollout, restarts the containers, and runs the smoke test.
6. Writes the record to `.release/<env>/`: `release-manifest.json` (commit, image refs and running digests, web hash, migration, bookmark, Worker version), the rendered config, `SHA256SUMS`, and an SBOM. A production tag attaches them to a GitHub Release.

**Rollback:** run the Deploy workflow with `rollback_to=v0.5.0`. It redeploys that tag's sources and images with no gates and no migrations (migrations only ever add). For the database, `wrangler d1 time-travel restore jstar --bookmark <bookmark_before_deploy>` from the release manifest. If a tag's images are gone, `wrangler rollback` returns the Worker to an earlier version.

**Fallback without Actions:** with the secrets files at the repo root, `infra/cloudflare/scripts/deploy.sh v1` runs the same deploy locally. The gates still apply.

**Adopting an image a deploy already built** (e.g. before the images workflow can run):
`scripts/retag-image.sh jstar-v1-api@sha256:… jstar-api:<hash>`. Only do this when `image-tags.sh` gives the same hash for the commit that built it.

Repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts, Containers, D1, Workers Routes: Edit), `CLOUDFLARE_ACCOUNT_ID`, `JWT_SECRET`, `SERIAL_HMAC_KEY`, `AGENT_API_KEY`, `ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, `ADMIN_EMAILS`, `TURNSTILE_SECRET`, plus `V1_*` / `TEST_*` / `NEST_*` for the acceptance sites (`NEST_TURNSTILE_SECRET` included).

Optional: `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (Web Push, #50; the test site uses `TEST_VAPID_PUBLIC_KEY` +
`TEST_VAPID_PRIVATE_KEY`) and `VAPID_SUBJECT` (contact for the push services, default `mailto:noreply@jstarcards.ai`).
Make a pair with `npx web-push generate-vapid-keys`. Without them push is off and the web app never offers it. Changing
a pair later silently orphans every existing subscription, so set it once. The API container reaches the push services
through the Worker (`http://push.internal`), which only forwards to FCM, Mozilla, Apple and Windows push hosts.

Weather (#62) needs no secret: Open-Meteo is free and keyless. The API container asks through the Worker
(`http://weather.internal`), which only forwards `GET /v1/forecast`, `/v1/search` and `/v1/get` to Open-Meteo. Its free
tier is for non-commercial use; production use needs its paid plan (an `apikey` parameter), see #84.

Voice input (#72) uses the `ai` binding (Workers AI on the same account; no secret). Browsers without speech
recognition of their own record a clip; the API container sends it through the Worker (`http://asr.internal`) to
`@cf/openai/whisper-large-v3-turbo`. The audio is never stored or logged. Without the binding `ASR_URL` stays unset and
the web app simply offers no recording fallback.

Her runtime voice (#73) is off until a talent has a cloned voice (docs/tts.md). Three vendors are implemented in
`src/tts.ts`: Fish Audio S2.1-Pro (`fish`, secret `FISH_API_KEY`; in use), Alibaba Cloud Model Studio Qwen3-TTS-VC
(`qwen`, secret `DASHSCOPE_API_KEY`, international region) and BytePlus Seed Speech Voice Replication 2.0 (`byteplus`,
secret `BYTEPLUS_VOICE_API_KEY`). Set the secret(s), the var
`TTS_PROVIDER` (the default vendor) and the var `TTS_VOICES` (JSON from `npm run voice:enroll` / `voice:pilot`: each
talent's voice id, or `{"provider": …, "voice": …}` for a talent on the other vendor), deploy, and restart the
containers. The API container asks through the Worker (`http://tts.internal`); `TTS_URL` and `TTS_STARS` are set only
when some talent has a voice whose vendor has its key. A talent without one has no runtime voice — she stays in
subtitles; a generic or preset voice never speaks as her. Every member hears it (`VOICE_RULES.ttsRoles`), and only lines the API signed as hers (docs/tts.md).

Her lip-sync (#73, docs/lipsync.md, `src/lipsync.ts`): her recorded lines rendered onto their clips live in the R2
bucket `jstar-lipsync` (binding `LIPSYNC_MEDIA`, shared by every site; filled by `tools/lipsync/publish.py`) and are
served at `/lipsync/v1/…` with byte ranges. Her runtime voice is rendered per sentence by the Modal service
`jstar-lipsync` (infra/lipsync): var `LIPSYNC_URL` (in wrangler.test / nest), secret `LIPSYNC_SECRET` (the value in the
repo-root `.env.lipsync.local`, also the Modal secret `jstar-lipsync-auth`), var `LIPSYNC_STARS` (`*` or a list;
unset = nobody). `LIPSYNC=off` is the kill switch (each site's value is in its wrangler config). Each render is logged as `event:
lipsync` with its GPU time and estimated cost.
The two routes that use the GPU, `POST /v1/lipsync` (render) and `POST /v1/lipsync/warm`, answer only a signed-in
member: the Worker verifies the same Bearer session the API does (HS256 under `JWT_SECRET`, account present and not
banned in D1), 401 otherwise. They are rate-limited per account and per IP by the `ratelimits` bindings in each
config (`LIPSYNC_LIMITS` in `src/lipsync.ts`: warm 1/min per account and 10/min per IP; render 8 per 10 s per
account and 120/min per IP), 429 past them. The rendered recorded lines (`GET /lipsync/v1/…`) stay public.

His memory files (#51: the recording of his yes, scene stills later) live in a private R2 bucket bound as `MEMORY`:
`jstar-test-memory` for the test site (`wrangler.test.jsonc`), `jstar-memory` for production (`wrangler.jsonc`).
**Create the bucket before the first deploy that carries the binding**, or that deploy fails:
`npx wrangler r2 bucket create jstar-test-memory` / `npx wrangler r2 bucket create jstar-memory` (no public access, no
custom domain, no CORS: nothing but the Worker ever reads it). The deploy token needs R2 access (Workers R2 Storage: Edit)
alongside its other permissions. The API container reaches the bucket through the Worker (`http://memory.internal`,
`src/memory.ts`), which requires `Authorization: Bearer $AGENT_API_KEY` and only puts, gets or deletes one key
(`<userId>/…`) or erases one user's prefix on account deletion; it never lists. Without the binding `MEMORY_URL` stays
unset and the API keeps recordings base64 in D1 as before; once the bucket is bound it moves those over by itself.

Custom domains fail to attach while other DNS records exist for the same hostname
(the original `jstarcards.ai` records are saved in `dns-backup/`).

## Region notice (GEO_BLOCK)

Launch markets are Japan and Taiwan. With the `GEO_BLOCK` var set to `"on"` in `wrangler.jsonc`, visitors from Korea, the EU, the US and mainland China get the notice page (API: 451 `region_unavailable`). It stays `"off"` through the beta; flip it and tag a release on launch day. On the test site, `?geo=KR` (any country code) previews what that visitor sees.
