#!/usr/bin/env bash
# Prints the registry references of the API and agent images for a commit, as shell assignments:
#   API_IMAGE=registry.cloudflare.com/<account>/jstar-api:<tag>
#   AGENT_IMAGE=registry.cloudflare.com/<account>/jstar-agent:<tag>
# The tag is a hash of the git trees that end up in each image, so an image is built once (images.yml) and every
# environment and every later commit with the same sources reuses it. Only what the image runs is hashed: tests,
# migrations and the root package.json/lock are left out (the lock changes with every dev tool, and the API is
# bundled by esbuild; the API's own dependencies are in apps/api/package.json, which is hashed). Keep this list
# and the paths in images.yml in step with the Dockerfiles. To force a rebuild, run images.yml by hand.
# Usage: image-tags.sh [commit]   (needs CLOUDFLARE_ACCOUNT_ID; DEPLOY_ROOT picks another checkout)
set -euo pipefail
cd "${DEPLOY_ROOT:-$(dirname "$0")/../../..}"
ref=${1:-HEAD}
tag() { git ls-tree "$ref" "$@" | shasum -a 256 | cut -c1-16; }
registry="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
echo "API_IMAGE=$registry/jstar-api:$(tag apps/api/src apps/api/package.json packages/shared/src packages/shared/package.json infra/api.Dockerfile)"
echo "AGENT_IMAGE=$registry/jstar-agent:$(tag apps/agent/app apps/agent/pyproject.toml infra/agent.Dockerfile)"
