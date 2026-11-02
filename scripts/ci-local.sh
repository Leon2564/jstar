#!/usr/bin/env bash
# The PR gate. .github/workflows/ci.yml runs it on the self-hosted Mac runner (label jstar-mac) for every PR and
# push to main, and its result is the `ci` check that deploys require. Run it by hand before pushing to catch
# failures early.
#
#   npm run ci:local                 # everything
#   npm run ci:local -- --no-e2e     # skip the browser suite (docs / tools-only changes)
#
# Needs: Node 22+, gitleaks, uv (Python 3.12 for the agent tests), and a Chromium for Playwright — CHROME_PATH, or the
# newest one under ~/Library/Caches/ms-playwright is picked. E2E runs on its own port (PW_PORT, default 4273).
set -uo pipefail
cd "$(dirname "$0")/.."

E2E=1
[ "${1:-}" = "--no-e2e" ] && E2E=0
LOG_DIR=${CI_LOG_DIR:-.ci-local}
mkdir -p "$LOG_DIR"
results=()
failed=0

step() {
  local name=$1; shift
  local log="$LOG_DIR/$(echo "$name" | tr ' /' '__').log"
  local t0=$SECONDS
  printf '▶ %s … ' "$name"
  if "$@" >"$log" 2>&1; then
    printf 'ok (%ss)\n' $((SECONDS - t0)); results+=("| $name | ✅ | $((SECONDS - t0))s |")
  else
    printf 'FAILED (%ss) — see %s\n' $((SECONDS - t0)) "$log"; tail -20 "$log" | sed 's/^/    /'
    results+=("| $name | ❌ | $((SECONDS - t0))s |"); failed=1
  fi
}

guard() {
  # Talent recordings, raw footage, references and secrets must never be committed (docs/PROCESS.md).
  local bad
  bad=$(git ls-files | grep -E '(^|/)(assets/agency|assets/refs|assets/originals|\.voice|tools/luckcards/out)/|\.(wav|flac|mov|MOV|m4a|safetensors|ckpt|pth)$|(^|/)\.env(\.|$)' | grep -vE '\.env\.example$|^apps/web/public/audio/' || true)
  [ -z "$bad" ] || { echo "Private or raw material is tracked:"; echo "$bad"; return 1; }
}

secret_scan() {
  # Every commit, not just the tree: a key removed later is still leaked. Known false positives: .gitleaksignore.
  command -v gitleaks >/dev/null || { echo "gitleaks is not installed (brew install gitleaks)"; return 1; }
  gitleaks git --no-banner --redact .
}

agent_tests() {
  # Python 3.12 in a throwaway environment (the system python is too old); nothing is written to the repo.
  (cd apps/agent && uv run --no-project --python 3.12 --with pytest --with pytest-asyncio --with fastapi \
    --with 'uvicorn[standard]' --with pydantic --with pyyaml --with httpx python -m pytest -q)
}

e2e() {
  if [ -z "${CHROME_PATH:-}" ]; then
    CHROME_PATH=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | sort -V | tail -1)
    export CHROME_PATH
  fi
  # Timing budgets (perf, interaction) run alone after the rest: under parallel load they measure the machine.
  (cd apps/web && PW_PORT=${PW_PORT:-4273} npx playwright test $(ls tests/e2e/*.spec.ts | grep -v -e perf.spec -e interaction.spec) --workers=2 --reporter=line \
    && PW_PORT=${PW_PORT:-4273} npx playwright test tests/e2e/perf.spec.ts tests/e2e/interaction.spec.ts --workers=1 --reporter=line)
}

step "private material guard" guard
step "secret scan (gitleaks)" secret_scan
step "lint" npm run lint
step "typecheck" npm run typecheck
step "unit tests (shared, web, api, media)" npm test
step "agent tests" agent_tests
step "build" npm run build
[ $E2E = 1 ] && step "e2e (Playwright)" e2e

echo
echo "### Local CI — $(git rev-parse --short HEAD) — $(date '+%Y-%m-%d %H:%M')"
echo
echo "| Step | Result | Time |"
echo "| --- | --- | --- |"
printf '%s\n' "${results[@]}"
[ $E2E = 1 ] && grep -hoE '[0-9]+ (passed|failed|flaky|skipped)' "$LOG_DIR/e2e_(Playwright).log" 2>/dev/null | awk '{n[$2]+=$1} END {for (k in n) printf "%s %s  ", n[k], k}' | sed 's/^/\ne2e: /'
echo
exit $failed
