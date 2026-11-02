#!/usr/bin/env bash
# Waits until each named container application has finished rolling out the version `wrangler deploy` just
# created. The deploy then restarts the containers; restarting earlier brings them back on the old image
# (seen on the test site: restart at 05:39:44, rollout done at 05:40:18, old API code kept serving).
# Usage: wait-rollout.sh <since-iso> <app-name>...   (needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
set -euo pipefail
since="$1"; shift
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers/applications"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
for name in "$@"; do
  id=$(curl -fsS "${auth[@]}" "$api" | jq -r --arg n "$name" '.result[] | select(.name == $n) | .id')
  [ -n "$id" ] || { echo "::error::container application $name not found"; exit 1; }
  for i in $(seq 1 60); do
    # The newest rollout must have been created by this deploy and be done.
    state=$(curl -fsS "${auth[@]}" "$api/$id/rollouts" | jq -r --arg s "$since" '[.result[] | select(.created_at >= $s)] | sort_by(.created_at) | last | .status // "none"')
    case "$state" in
      completed) echo "$name: rollout completed"; break ;;
      none) echo "$name: no new rollout (image unchanged)"; break ;;
      failed|cancelled|reverted) echo "::error::$name rollout $state"; exit 1 ;;
      *) echo "$name: rollout $state ($i)"; sleep 10 ;;
    esac
    [ "$i" -lt 60 ] || { echo "::error::$name rollout did not finish in 10 minutes"; exit 1; }
  done
done
