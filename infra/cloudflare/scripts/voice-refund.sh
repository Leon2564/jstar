#!/usr/bin/env bash
# Gives back the voice seconds charged while her runtime voice did not sound (#73): from the deploy of #183 until the
# deploy of #184, the page's CSP refused the data: audio, so nothing played while each sentence was charged. NOT
# owner-approved yet: run only after the owner says so.
#
#   infra/cloudflare/scripts/voice-refund.sh test                 # preview: who, how many sentences, how many seconds
#   infra/cloudflare/scripts/voice-refund.sh test --apply         # the refund (asks once more before writing)
#   FROM=2026-10-02T13:05:00Z TO=2026-10-02T14:30:00Z infra/cloudflare/scripts/voice-refund.sh nest
#
# Sites: test (D1 jstar-test, wrangler.test.jsonc), nest (jstar-nest, wrangler.nest.jsonc). Needs CLOUDFLARE_API_TOKEN
# (set -a; . ./.env.cloudflare.local; set +a). The window defaults to 13:05–14:30 UTC on 2026-10-02.
#
# What it does: each runtime-voice charge (`voice_ledger.kind = 'tts'`) created in the window has its seconds set to 0.
# The rows stay, so their request ids stay used (never synthesized again for free). Idempotent: a second run finds
# nothing left to refund.
#
# Timing: a day's voice time is that JST day's ledger (it resets at 0:00 JST). The window is 22:05–23:30 JST on 10/2,
# so the refund only gives him minutes back while 10/2 JST lasts (until 2026-10-02T15:00:00Z). After that his
# allowance has reset anyway; the refund then only corrects the record (usage metrics).
set -euo pipefail
cd "$(dirname "$0")/.."
site=${1:?usage: voice-refund.sh <test|nest> [--apply]}
case "$site" in
  test) config=wrangler.test.jsonc; db=jstar-test ;;
  nest) config=wrangler.nest.jsonc; db=jstar-nest ;;
  *) echo "unknown site: $site (test | nest)"; exit 2 ;;
esac
from=${FROM:-2026-10-02T13:05:00Z}
to=${TO:-2026-10-02T14:30:00Z}
# created_at is ISO (toISOString: 2026-10-02T13:05:00.000Z); compare on the same shape.
f=${from%Z}; t=${to%Z}
[[ "$f" == *.* ]] || f="$f.000"; [[ "$t" == *.* ]] || t="$t.000"
where="kind = 'tts' AND seconds > 0 AND created_at >= '${f}Z' AND created_at < '${t}Z'"
for v in "$f" "$t"; do [[ "$v" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$ ]] || { echo "bad time: $v"; exit 2; }; done

echo "== $site ($db): runtime-voice charges between ${f}Z and ${t}Z"
npx wrangler d1 execute "$db" --remote -c "$config" --command \
  "SELECT user_id, day, count(*) AS sentences, sum(seconds) AS seconds FROM voice_ledger WHERE $where GROUP BY user_id, day ORDER BY seconds DESC"
npx wrangler d1 execute "$db" --remote -c "$config" --command \
  "SELECT count(DISTINCT user_id) AS accounts, count(*) AS sentences, coalesce(sum(seconds), 0) AS seconds FROM voice_ledger WHERE $where"

[ "${2:-}" = "--apply" ] || { echo "preview only; add --apply to refund (owner's OK first)"; exit 0; }
read -r -p "Refund these seconds on $site? Type the site name to confirm: " ok
[ "$ok" = "$site" ] || { echo "not confirmed"; exit 1; }
npx wrangler d1 execute "$db" --remote -c "$config" --command "UPDATE voice_ledger SET seconds = 0 WHERE $where"
echo "refunded; run again without --apply to see nothing left"
