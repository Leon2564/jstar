#!/usr/bin/env bash
# Review lucky codes for Nest (nest.jstarcards.ai): a batch of codes that works like a printed lucky card (six draws,
# the first SR or better) but gives the monthly pass (30 days), so the owner can try the pass perks there.
#
#   infra/cloudflare/scripts/nest-review-codes.sh [count]     # default 20
#
# Codes come from the lucky-card generator (tools/luckcards) keyed with Nest's own SERIAL_HMAC_KEY
# (.env.worker-nest.local), so they are valid on Nest only. Only their hashes go to Nest's database (jstar-nest, never
# any other); the plain codes are appended to .nest-review-codes.secret at the repo root (gitignored as *.secret,
# mode 600). Each run is a new batch; the codes of earlier runs stay valid. Needs CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID, jq. From a worktree, SECRETS_ROOT=<main checkout> reads and writes the files there.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../../.."
count=${1:-20}
[[ "$count" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "count: 1–999"; exit 2; }
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
root=${SECRETS_ROOT:-$PWD}
secrets=$root/.env.worker-nest.local
codes_file=$root/.nest-review-codes.secret
key=$(sed -n 's/^SERIAL_HMAC_KEY=//p' "$secrets")
[[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "$secrets has no SERIAL_HMAC_KEY"; exit 1; }
git -C "$root" check-ignore -q "$codes_file" || { echo "$codes_file is not gitignored: refusing to write plain codes there"; exit 1; }

# RULES.passDays and RULES.lucky.drawsPerCode (packages/shared/src/rules.ts).
pass_days=30
draws=6
batch=nest-review-$(date -u +%Y%m%d%H%M)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
umask 077
printf '%s\n' "$key" >"$tmp/key.secret"
gen=tools/luckcards/scripts/code-gen
node "$gen/generate.mjs" --count "$count" --batch "$batch" --out "$tmp/out" --secret-file "$tmp/key.secret" --qr-base https://nest.jstarcards.ai/r >/dev/null
plain=$tmp/out/print/codes-$batch-PLAINTEXT.csv
hashed=$tmp/out/db/codes-$batch-hashed.csv
node "$gen/verify.mjs" "$plain" "$hashed" "$tmp/key.secret"
node "$gen/d1-sql.mjs" "$hashed" --trial-days "$pass_days" --draws "$draws" |
  sed "s/'Lucky cards $batch'/'Nest review codes ($pass_days-day pass)'/" >"$tmp/seed.sql"

# The plain codes are kept before the hashes go in, so a failure below never leaves codes nobody can read.
touch "$codes_file"; chmod 600 "$codes_file"
{
  echo "# $batch · $(date -u +%Y-%m-%dT%H:%M:%SZ) · nest.jstarcards.ai only · each: $draws cards + $pass_days-day monthly pass · single use"
  tail -n +2 "$plain" | cut -d, -f1,3 | tr ',' ' '
} >>"$codes_file"

d1() { (cd infra/cloudflare && npx wrangler d1 execute jstar-nest --remote -c wrangler.nest.jsonc "$@"); }
d1 --file "$tmp/seed.sql" >/dev/null
# The database answers queries again only once the import has finished.
for i in $(seq 1 10); do
  seeded=$(d1 --json --command "SELECT COUNT(*) AS n FROM serials WHERE batch_id = '$batch' AND redeemed_at IS NULL" 2>/dev/null |
    jq -r 'if type == "array" then .[0].results[0].n else empty end' 2>/dev/null || true)
  [ -z "$seeded" ] || break
  sleep 5
done
[ "$seeded" = "$count" ] || { echo "only ${seeded:-?} of $count codes of $batch are in jstar-nest (plain codes are in $codes_file)"; exit 1; }
echo "$count review codes ($batch) are in jstar-nest; plain codes appended to $codes_file"
