#!/usr/bin/env bash
# Builds the API and agent images on this Mac, without Docker, and pushes whichever is not in the registry yet.
# The tags are the ones deploy.sh looks for (image-tags.sh: a hash of the sources each image holds), so a deploy
# needs nothing else. Run by images.yml on the self-hosted runner, or by hand:
#
#   build-images.sh                 # both, skipping tags that already exist
#   build-images.sh --only api      # or: --only agent
#   build-images.sh --force         # rebuild and overwrite the tags
#   DEPLOY_ROOT=<checkout> build-images.sh    # another checkout (its node_modules must be installed)
#
# What each image holds is specified by infra/api.Dockerfile and infra/agent.Dockerfile; this reproduces their final
# stage on the same pinned bases (build-image.py lays folders over the base and writes the image config):
#   api    node:20-alpine + /srv/server.mjs (esbuild bundle of apps/api, pure JS), USER node, NODE_ENV=production,
#          WORKDIR /srv, port 8080, CMD node server.mjs
#   agent  python:3.12-slim + the pip packages of the Dockerfile as linux x86_64 wheels (uv, no compiler) +
#          /srv/pyproject.toml and /srv/app, PYTHONUNBUFFERED=1, WORKDIR /srv, port 8100, CMD uvicorn app.main:app
# Change the Dockerfile and this script together. Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, jq, uv, rsync.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "${DEPLOY_ROOT:-$here/../../..}"
root=$PWD
force=0; only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --only) only=$2; shift ;;
    *) echo "usage: build-images.sh [--only api|agent] [--force]"; exit 2 ;;
  esac
  shift
done

# The FROM lines of the Dockerfiles, pinned to their linux/amd64 manifests (Cloudflare Containers run amd64).
# Update a pin deliberately: resolve the tag's amd64 manifest on Docker Hub and put its digest here.
NODE_BASE=docker.io/library/node@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb     # node:20-alpine
PYTHON_BASE=docker.io/library/python@sha256:44ff437bba879d4941b710a369a8f19266aea34b29002807f0c487fabc9eec9b # python:3.12-slim
# RUN pip install in infra/agent.Dockerfile.
AGENT_PACKAGES=(fastapi "uvicorn[standard]" pydantic pyyaml httpx)

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
# macOS's own Python trusts the system keychain; a python.org build without its certificates cannot reach the registries.
PY=${PYTHON:-/usr/bin/python3}
eval "$("$here/image-tags.sh")"
sha=$(git rev-parse HEAD)
created=$(git log -1 --format=%cI HEAD)
mtime=$(git log -1 --format=%ct HEAD)
wr() { (cd "$root/infra/cloudflare" && npx wrangler "$@"); }
existing=$(wr containers images list --json 2>/dev/null)
have() {
  local name=${1##*/}; local repo=${name%:*}; local tag=${name##*:}
  jq -e --arg r "$repo" --arg t "$tag" '.[] | select(.name == $r) | .tags | index($t)' <<<"$existing" >/dev/null
}
want() { [ -z "$only" ] || [ "$only" = "$1" ]; }
todo=()
for spec in "api:$API_IMAGE" "agent:$AGENT_IMAGE"; do
  kind=${spec%%:*}; ref=${spec#*:}
  want "$kind" || continue
  if [ $force = 0 ] && have "$ref"; then echo "${ref##*/} is already in the registry"; continue; fi
  todo+=("$kind")
done
[ ${#todo[@]} -gt 0 ] || exit 0

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
REGISTRY_PASSWORD=$(wr containers registries credentials registry.cloudflare.com --pull --push --expiration-minutes 30 --json | jq -r .password)
export REGISTRY_PASSWORD
common=(--created "$created" --mtime "$mtime" --label "org.opencontainers.image.revision=$sha" --label "org.opencontainers.image.source=https://github.com/LinkAgent/jstarcardsai")

for kind in "${todo[@]}"; do
  case "$kind" in
    api)
      echo "▶ api: esbuild bundle"
      npm run build -w @jstar/api >"$work/api-build.log" 2>&1 || { tail -30 "$work/api-build.log"; exit 1; }
      mkdir -p "$work/api/srv"
      cp apps/api/dist/server.mjs "$work/api/srv/server.mjs"
      "$PY" "$here/build-image.py" --base "$NODE_BASE" --dest "$API_IMAGE" --layer "$work/api" \
        --workdir /srv --user node --env NODE_ENV=production --expose 8080 --cmd '["node","server.mjs"]' "${common[@]}"
      ;;
    agent)
      echo "▶ agent: linux x86_64 wheels"
      site="$work/agent-deps/usr/local/lib/python3.12/site-packages"
      mkdir -p "$site" "$work/agent-deps/usr/local/bin"
      uv pip install --quiet --target "$site" --python-platform x86_64-manylinux_2_28 --python-version 3.12 \
        --only-binary :all: "${AGENT_PACKAGES[@]}"
      # pip's console script for the CMD (a --target install leaves it under the target, with this Mac's shebang).
      rm -rf "$site/bin"
      printf '#!/usr/local/bin/python3.12\nimport sys\nfrom uvicorn.main import main\nif __name__ == "__main__":\n    sys.exit(main())\n' >"$work/agent-deps/usr/local/bin/uvicorn"
      chmod 755 "$work/agent-deps/usr/local/bin/uvicorn"
      mkdir -p "$work/agent-app/srv"
      cp apps/agent/pyproject.toml "$work/agent-app/srv/"
      rsync -a --exclude '__pycache__' --exclude '.pytest_cache' apps/agent/app/ "$work/agent-app/srv/app/"
      "$PY" "$here/build-image.py" --base "$PYTHON_BASE" --dest "$AGENT_IMAGE" --layer "$work/agent-deps" --layer "$work/agent-app" \
        --workdir /srv --env PYTHONUNBUFFERED=1 --expose 8100 --cmd '["uvicorn","app.main:app","--host","0.0.0.0","--port","8100"]' "${common[@]}"
      ;;
  esac
done
