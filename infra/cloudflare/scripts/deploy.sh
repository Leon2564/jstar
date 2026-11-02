#!/usr/bin/env bash
# One deploy for every environment, run by the deploy workflows on the self-hosted Mac runner, or by hand as the
# fallback. Nothing is built for Docker here: the API and agent images were built once (images.yml) and are
# referenced by the hash of their sources (image-tags.sh), so v1 and production run the very same images.
#
#   deploy.sh v1                # main → v1.jstarcards.ai
#   deploy.sh test              # any ref → test.jstarcards.ai
#   deploy.sh nest              # release/v1.1 → nest.jstarcards.ai (Nest, the v1.1 review site: STAGE=review)
#   deploy.sh prod              # a v* tag → jstarcards.ai + admin (then a GitHub Release)
#   deploy.sh prod --rollback   # a v* tag that was live before: no gates, no migrations
#
# DEPLOY_ROOT=<checkout> deploys another checkout with this script (a rollback to a tag older than the script).
#
# Gates (the Free plan cannot protect branches, so they are checked here):
#   - the commit's `ci` check passed (ci.yml);
#   - production only: this commit is live on an acceptance site with the same web build: v1 (commit status
#     deploy/v1, the main line) or Nest (deploy/nest, the release line; STAGE=review runs as production does).
# Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, gh (GH_TOKEN in Actions), jq, and the secrets file of the
# environment at the repo root (.env.worker[-v1|-test|-nest].local; prod also .env.admin.local).
# Writes the deploy record to .release/<env>/ (release-manifest.json, rendered configs, SHA256SUMS, SBOM).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "${DEPLOY_ROOT:-$here/../../..}"
root=$PWD
env=${1:?usage: deploy.sh <v1|test|nest|prod> [--rollback]}
rollback=0; [ "${2:-}" = "--rollback" ] && rollback=1

case "$env" in
# stage: the Worker's STAGE (src/stage.ts): demo = STAGE=test, review = STAGE=review, production = unset.
  v1)   config=wrangler.v1.jsonc;   db=jstar-v1;   host=v1.jstarcards.ai;   apps="jstar-v1-api jstar-v1-agent";     secrets=.env.worker-v1.local;   stage=demo ;;
  test) config=wrangler.test.jsonc; db=jstar-test; host=test.jstarcards.ai; apps="jstar-test-api jstar-test-agent"; secrets=.env.worker-test.local; stage=demo ;;
  nest) config=wrangler.nest.jsonc; db=jstar-nest; host=nest.jstarcards.ai; apps="jstar-nest-api jstar-nest-agent"; secrets=.env.worker-nest.local; stage=review ;;
  prod) config=wrangler.jsonc;      db=jstar;      host=jstarcards.ai;      apps="jstar-web-api jstar-web-agent";   secrets=.env.worker.local;      stage=production ;;
  *) echo "unknown environment: $env"; exit 2 ;;
esac
[ $rollback = 0 ] || [ "$env" = prod ] || { echo "--rollback is for production only"; exit 2; }

log() { printf '\n▶ %s\n' "$*"; }
fail() { echo "::error::$*"; exit 1; }
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
[ -f "$secrets" ] || fail "missing $secrets"
[ "$env" != prod ] || [ -f .env.admin.local ] || fail "missing .env.admin.local"
# Review challenges bots with Turnstile as production does; without the secret the smoke test would fail after the deploy.
[ "$stage" != review ] || grep -q '^TURNSTILE_SECRET=.' "$secrets" || fail "$secrets has no TURNSTILE_SECRET"
git diff --quiet HEAD -- . ':!.release' || fail "the working tree has uncommitted changes: deploy a commit, not a working copy"

repo=${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
sha=$(git rev-parse HEAD)
short=${sha:0:7}
subject=$(git log -1 --format=%s)
release_tag=$(git tag --points-at HEAD --list 'v*' | sort -V | tail -1)
version=${release_tag:-$short}
out=$root/.release/$env
rm -rf "$out"; mkdir -p "$out"
wr() { (cd infra/cloudflare && npx wrangler "$@"); }

# ── Gates ─────────────────────────────────────────────────────────────────────────────────────────────────
log "gates for $short ($subject)"
if [ $rollback = 1 ]; then
  [ -n "$release_tag" ] || fail "rollback: HEAD is not a v* tag"
  echo "::warning::rollback to $release_tag: gates skipped, database left as it is"
else
  ci=$(gh api "repos/$repo/commits/$sha/check-runs?check_name=ci" -q '[.check_runs[] | select(.conclusion == "success")] | length')
  [ "$ci" -gt 0 ] || fail "the ci check has not passed on $short: no deploy"
  echo "ci passed"
  if [ "$env" = prod ]; then
    [ -n "$release_tag" ] || fail "production deploys a v* tag"
    v1=$(gh api "repos/$repo/commits/$sha/status" -q '[.statuses[] | select((.context == "deploy/v1" or .context == "deploy/nest") and .state == "success")][0] | if . then "\(.context): \(.description)" else "" end')
    [ -n "$v1" ] || fail "$short has not been deployed to v1.jstarcards.ai or nest.jstarcards.ai: accept it there first"
    echo "accepted on $v1"
  fi
fi

# ── Images (built once by images.yml) ─────────────────────────────────────────────────────────────────────
log "images"
eval "$(DEPLOY_ROOT=$root "$here/image-tags.sh")"
have_image() {
  local name=${1##*/}; name=${name%:*}; local tag=${1##*:}
  wr containers images list --json 2>/dev/null | jq -e --arg n "$name" --arg t "$tag" '.[] | select(.name == $n) | .tags | index($t)' >/dev/null
}
for image in "$API_IMAGE" "$AGENT_IMAGE"; do
  for i in $(seq 1 30); do
    have_image "$image" && break
    [ "$i" -lt 30 ] || fail "$image is not in the registry: images.yml builds it when the container sources change"
    echo "waiting for images.yml to push $image ($i)"; sleep 30
  done
  echo "$image"
done

# ── Build web (and admin) ─────────────────────────────────────────────────────────────────────────────────
log "build"
npm run build:web -w @jstar/edge >"$out/build-web.log" 2>&1 || { tail -30 "$out/build-web.log"; fail "web build failed"; }
(cd apps/web/dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) >"$out/web-dist.SHA256SUMS"
web_hash=$(shasum -a 256 <"$out/web-dist.SHA256SUMS" | cut -c1-16)
echo "web $web_hash ($(wc -l <"$out/web-dist.SHA256SUMS" | tr -d ' ') files)"
if [ "$env" = prod ] && [ $rollback = 0 ]; then
  # The build is reproducible from the commit; a different hash means production would not get what v1 showed.
  [[ "$v1" == *"web $web_hash"* ]] || fail "web build $web_hash differs from the one accepted ($v1)"
  npm run build:admin -w @jstar/edge >"$out/build-admin.log" 2>&1 || { tail -30 "$out/build-admin.log"; fail "admin build failed"; }
  tar -czf "$out/admin-dist.tgz" -C apps/admin dist
fi

# ── Config with the image references ──────────────────────────────────────────────────────────────────────
rendered=infra/cloudflare/${config%.jsonc}.rendered.jsonc
sed -e "s#\"image\": \"../api.Dockerfile\", \"image_build_context\": \"../..\"#\"image\": \"$API_IMAGE\"#" \
    -e "s#\"image\": \"../agent.Dockerfile\", \"image_build_context\": \"../..\"#\"image\": \"$AGENT_IMAGE\"#" \
    "infra/cloudflare/$config" >"$rendered"
! grep -q 'Dockerfile' "$rendered" || fail "$config: container images were not replaced"
cp "$rendered" "$out/"

# ── Database ──────────────────────────────────────────────────────────────────────────────────────────────
log "database $db"
bookmark=$(wr d1 time-travel info "$db" --json -c "$config" 2>/dev/null | jq -r '.bookmark // empty' || true)
echo "time-travel bookmark before deploy: ${bookmark:-unavailable}"
if [ $rollback = 0 ]; then
  wr d1 migrations apply "$db" --remote -c "$config"
  # Review: no demo data, even where the site ran in demo mode before (idempotent; never on the demo sites).
  [ "$stage" != review ] || wr d1 execute "$db" --remote -c "$config" --file review-stage.sql
fi
last_migration=$(ls apps/api/migrations/*.sql | tail -1 | xargs basename)

# ── Deploy ────────────────────────────────────────────────────────────────────────────────────────────────
log "deploy $host ($version)"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
message=$(printf '%s %s' "$short" "$subject" | cut -c1-100)
wr deploy -c "${rendered#infra/cloudflare/}" --secrets-file "$root/$secrets" --containers-rollout=immediate \
  --tag "$version" --message "$message" --var "VERSION:$version" --var "COMMIT:$sha" | tee "$out/deploy.log"
worker_version=$(grep -oE 'Current Version ID: [0-9a-f-]+' "$out/deploy.log" | awk '{print $4}')
if [ "$env" = prod ]; then
  wr deploy -c admin.wrangler.jsonc --secrets-file "$root/.env.admin.local" --tag "$version" --message "$message" | tee "$out/deploy-admin.log"
fi

# The containers restart from the new Worker only after their new version is live, or they come back on the old image.
"$here/wait-rollout.sh" "$since" $apps

log "restart containers"
for i in $(seq 1 6); do
  if [ "$env" = prod ]; then
    pass=$(sed -n 's/^ADMIN_PASSWORD=//p' .env.admin.local)
    curl -fsS -X POST -u "admin:$pass" https://admin.jstarcards.ai/v1/ops/restart && break
  else
    key=$(sed -n 's/^AGENT_API_KEY=//p' "$secrets")
    curl -fsS -X POST -H "authorization: Bearer $key" "https://$host/v1/ops/restart" && break
  fi
  [ "$i" -lt 6 ] || fail "restart failed"
  echo "waiting for $host ($i)"; sleep 10
done

# ── Smoke test ────────────────────────────────────────────────────────────────────────────────────────────
log "smoke test"
for i in $(seq 1 30); do
  curl -fsS "https://$host/health" && break
  [ "$i" -lt 30 ] || fail "the API container did not come up"
  echo " waiting for the API container ($i)"; sleep 10
done
echo
curl -fsS -o /dev/null "https://$host/"
test "$(curl -s -o /dev/null -w '%{http_code}' "https://$host/v1/admin/cards")" = 404
if [ "$stage" = demo ]; then
  curl -fsS "https://$host/v1/config" | grep -q '"demo":true'
else
  # Production and review: production mode, real sign-in codes by e-mail, no demo data or endpoints.
  curl -fsS "https://$host/health" | grep -q '"env":"production"'
  curl -fsS "https://$host/v1/config" | grep -q '"demo":false'
  curl -fsS "https://$host/v1/config" | grep -q '"turnstile":"0x'
  test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$host/v1/inbox/demo")" = 404
  # The QR codes printed on the lucky cards land on the redeem page.
  curl -s -o /dev/null -w '%{redirect_url}' "https://$host/lucky" | grep -q '/#/serial$'
  # A new device's first trial message needs a Turnstile token: without one the API must ask for it.
  curl -s -X POST "https://$host/v1/chat/trial" -H 'content-type: application/json' \
    -H "x-device-id: smoke-${GITHUB_RUN_ID:-local-$short}" -d '{"star":"mahiro","text":"hello","lang":"en"}' | grep -q '"challenge_required"'
fi
if [ "$env" = prod ]; then
  test "$(curl -s -o /dev/null -w '%{http_code}' https://admin.jstarcards.ai/)" = 401
else
  # Only production is in search results.
  curl -fsS -o /dev/null -D - "https://$host/" | grep -qi '^x-robots-tag: noindex'
fi
echo "smoke test passed"

# ── Record ────────────────────────────────────────────────────────────────────────────────────────────────
log "record"
digest_of() {
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers/applications" |
    jq -r --arg n "$1" '.result[] | select(.name == $n) | .id' | while read -r id; do
      curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers/applications/$id" | jq -r '.result.configuration.image'
    done
}
read -r api_app agent_app <<<"$apps"
jq -n --arg env "$env" --arg host "$host" --arg version "$version" --arg commit "$sha" --arg subject "$subject" \
  --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg api "$API_IMAGE" --arg agent "$AGENT_IMAGE" \
  --arg api_running "$(digest_of "$api_app")" --arg agent_running "$(digest_of "$agent_app")" \
  --arg web "$web_hash" --arg db "$db" --arg migration "$last_migration" --arg bookmark "$bookmark" \
  --arg worker_version "$worker_version" --argjson rollback "$rollback" --arg run "${GITHUB_RUN_ID:-local}" '{
    env: $env, host: $host, version: $version, commit: $commit, subject: $subject, deployed_at: $deployed_at,
    rollback: ($rollback == 1), run: $run, worker_version: $worker_version,
    images: { api: { ref: $api, running: $api_running }, agent: { ref: $agent, running: $agent_running } },
    web: { sha256: $web, files: "web-dist.SHA256SUMS" },
    database: { name: $db, last_migration: $migration, bookmark_before_deploy: $bookmark }
  }' >"$out/release-manifest.json"
cat "$out/release-manifest.json"
npm sbom --sbom-format cyclonedx --package-lock-only >"$out/sbom.cdx.json" 2>/dev/null || echo "::warning::SBOM not generated"
(cd "$out" && shasum -a 256 release-manifest.json ./*.rendered.jsonc web-dist.SHA256SUMS sbom.cdx.json ./*.tgz 2>/dev/null >SHA256SUMS || true)

# What v1 showed is what production may take: the prod gate reads this status.
gh api -X POST "repos/$repo/statuses/$sha" -f state=success -f context="deploy/$env" \
  -f target_url="https://$host" -f description="$version web $web_hash api ${API_IMAGE##*:} agent ${AGENT_IMAGE##*:}" >/dev/null

if [ "$env" = prod ] && [ $rollback = 0 ]; then
  log "GitHub Release $release_tag"
  (cd "$out" && gh release create "$release_tag" --repo "$repo" --verify-tag --generate-notes --title "$release_tag" \
    release-manifest.json SHA256SUMS web-dist.SHA256SUMS sbom.cdx.json admin-dist.tgz ./*.rendered.jsonc)
fi
echo "deployed $version to $host"
