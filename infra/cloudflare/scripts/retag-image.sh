#!/usr/bin/env bash
# Copies an image already in the Cloudflare registry to another name:tag, without Docker: the layers are mounted
# (or copied) registry-side and the manifest is written under the new tag. Used to adopt an image a deploy built
# earlier as the build-once image for its sources (image-tags.sh), e.g. while no GitHub-hosted runner is available.
# Usage: retag-image.sh <source-name@sha256:...> <target-name:tag>   (needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
set -euo pipefail
src=$1; dst=$2
src_name=${src%@*}; src_digest=${src#*@}
dst_name=${dst%:*}; dst_tag=${dst##*:}
cd "$(dirname "$0")/.."
pw=$(npx wrangler containers registries credentials registry.cloudflare.com --pull --push --expiration-minutes 10 --json | jq -r .password)
reg="https://registry.cloudflare.com/v2/$CLOUDFLARE_ACCOUNT_ID"
auth=(-u "v1:$pw")
accept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

manifest=$(curl -fsS "${auth[@]}" -H "Accept: $accept" "$reg/$src_name/manifests/$src_digest")
media_type=$(jq -r .mediaType <<<"$manifest")
[ "$(jq -r '.manifests // empty' <<<"$manifest")" = "" ] || { echo "multi-platform index: not supported"; exit 1; }

for blob in $(jq -r '.config.digest, .layers[].digest' <<<"$manifest"); do
  if curl -fsS -o /dev/null -I "${auth[@]}" "$reg/$dst_name/blobs/$blob" 2>/dev/null; then continue; fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" \
    "$reg/$dst_name/blobs/uploads/?mount=$blob&from=$CLOUDFLARE_ACCOUNT_ID/$src_name")
  if [ "$code" != 201 ]; then
    # No cross-repository mount: copy the blob through this machine.
    tmp=$(mktemp); curl -fsSL "${auth[@]}" -o "$tmp" "$reg/$src_name/blobs/$blob"
    location=$(curl -fsS -D - -o /dev/null -X POST "${auth[@]}" "$reg/$dst_name/blobs/uploads/" | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}')
    case "$location" in http*) ;; *) location="https://registry.cloudflare.com$location" ;; esac
    sep='?'; [[ "$location" == *\?* ]] && sep='&'
    curl -fsS -o /dev/null -X PUT "${auth[@]}" -H 'Content-Type: application/octet-stream' --data-binary "@$tmp" "$location${sep}digest=$blob"
    rm -f "$tmp"
  fi
done

curl -fsS -o /dev/null -X PUT "${auth[@]}" -H "Content-Type: $media_type" --data-binary "$manifest" "$reg/$dst_name/manifests/$dst_tag"
echo "$src -> $dst_name:$dst_tag"
