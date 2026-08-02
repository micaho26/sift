#!/usr/bin/env bash
#
# Post-merge verification: is the project actually published and working?
#
# CI going green means the code compiled and the tests passed on a runner. It
# does not mean a stranger can clone this and have it run, and it does not mean
# the site people are linked to is serving the new build. Those are the two
# claims the README makes, so those are what this checks.
#
# Exit codes:
#   0  everything verified
#   1  at least one check failed
#
# Usage: .claude/skills/push/scripts/verify-published.sh [--skip-clone]
#
#   --skip-clone   skip the clean-clone install/boot (the slow part, ~60s)

set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

SKIP_CLONE=0
[[ "${1:-}" == "--skip-clone" ]] && SKIP_CLONE=1

FAILED=0
bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  FAILED=$((FAILED + 1))
}

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo '')"
SITE="$(gh repo view --json homepageUrl --jq .homepageUrl 2>/dev/null || echo '')"
SITE="${SITE%/}"

bold "── workflow runs on main ──"
if [[ -n "$REPO" ]]; then
  SHA="$(git rev-parse origin/main)"
  RUNS="$(gh run list --repo "$REPO" --limit 12 \
    --json headSha,name,status,conclusion \
    --jq ".[] | select(.headSha == \"$SHA\") | \"\(.name)\t\(.status)\t\(.conclusion // \"running\")\"" 2>/dev/null)"
  if [[ -z "$RUNS" ]]; then
    bad "no workflow run found for $(git rev-parse --short origin/main) on main"
  else
    while IFS=$'\t' read -r name status conclusion; do
      if [[ "$status" == "completed" && "$conclusion" == "success" ]]; then
        ok "$name"
      else
        bad "$name: $status/$conclusion"
      fi
    done <<<"$RUNS"
  fi
else
  bad "gh could not identify the repository"
fi

if [[ -n "$SITE" ]]; then
  bold "── live site ──"
  for path in "/" "/showcase/"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 "$SITE$path")"
    [[ "$code" == "200" ]] && ok "$SITE$path → 200" || bad "$SITE$path → $code"
  done

  # The site's own claim is that nothing leaves your machine. A third-party
  # origin in the served HTML makes that false on the marketing page itself, so
  # it is a release blocker rather than a style question.
  #
  # Compare host to host: SITE carries a path (…github.io/sift) while the
  # extracted origins do not, so stripping only the scheme made the site's own
  # host look foreign to itself.
  SITE_HOST="$(printf '%s' "$SITE" | sed -E 's|https?://([^/]+).*|\1|')"
  ALLOWED="^${SITE_HOST//./\\.}$|^github\.com$|^opensource\.org$|^schema\.org$"
  THIRD_PARTY="$(curl -s -L --max-time 25 "$SITE/" \
    | grep -ohE '(src|href)="https?://[a-z0-9.-]+' \
    | sed -E 's|.*https?://||' | sort -u \
    | grep -vE "$ALLOWED" || true)"
  if [[ -z "$THIRD_PARTY" ]]; then
    ok "no third-party asset origins in the served HTML"
  else
    bad "third-party origins present: $(echo "$THIRD_PARTY" | tr '\n' ' ')"
  fi

  # A custom social preview lives only in GitHub's settings, so a repo transfer
  # or a settings reset silently reverts it to the generic auto-card.
  OG_HOST="$(curl -s "https://github.com/$REPO" \
    | grep -oE 'property="og:image" content="https://[a-z.-]+' | head -1 | sed 's|.*https://||')"
  if [[ "$OG_HOST" == "repository-images.githubusercontent.com" ]]; then
    ok "repo social preview is still the custom card"
  else
    bad "social preview reverted to GitHub's auto-card (og:image host: ${OG_HOST:-none})"
  fi
fi

if [[ "$SKIP_CLONE" == "0" ]]; then
  bold "── clean clone: install, test, boot ──"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  if ! git clone --quiet --depth 1 "https://github.com/$REPO" "$TMP/repo" 2>/dev/null; then
    bad "clone failed"
  else
    pushd "$TMP/repo" >/dev/null || exit 1
    START=$(date +%s)
    if pnpm install --frozen-lockfile --silent >"$TMP/install.log" 2>&1; then
      ok "pnpm install ($(($(date +%s) - START))s, no compile step to fail)"
    else
      bad "pnpm install failed — see $TMP/install.log"
      tail -20 "$TMP/install.log" | sed 's/^/      /'
    fi

    if pnpm test >"$TMP/test.log" 2>&1; then
      COUNT="$(grep -Eo 'ℹ tests [0-9]+' "$TMP/test.log" | awk '{s+=$3} END {print s}')"
      ok "pnpm test (${COUNT:-?} tests)"
    else
      bad "pnpm test failed — see $TMP/test.log"
      grep -E 'not ok|✖|Error' "$TMP/test.log" | head -10 | sed 's/^/      /'
    fi

    # The README promises `pnpm seed && pnpm dev` works on a fresh clone. Boot it
    # on non-default ports so this cannot collide with a dev server already up.
    if pnpm seed >"$TMP/seed.log" 2>&1; then
      ok "pnpm seed"
    else
      bad "pnpm seed failed — see $TMP/seed.log"
    fi

    PORT=4491
    SIFT_PORT=$PORT SIFT_LOG=quiet SIFT_NO_SCHEDULER=1 \
      pnpm --filter sift-server dev >"$TMP/boot.log" 2>&1 &
    BOOT_PID=$!
    HEALTHY=0
    for _ in $(seq 1 60); do
      if curl -sf "http://127.0.0.1:$PORT/api/health" >"$TMP/health.json" 2>/dev/null; then
        HEALTHY=1
        break
      fi
      sleep 0.5
    done
    if [[ "$HEALTHY" == "1" ]]; then
      ITEMS="$(node -e 'console.log(require(process.argv[1]).db.items)' "$TMP/health.json" 2>/dev/null || echo '?')"
      ok "server answers /api/health ($ITEMS items indexed)"
    else
      bad "server never became healthy — see $TMP/boot.log"
      tail -15 "$TMP/boot.log" | sed 's/^/      /'
    fi
    kill "$BOOT_PID" 2>/dev/null
    wait "$BOOT_PID" 2>/dev/null
    popd >/dev/null || true
  fi
fi

echo
if [[ "$FAILED" -gt 0 ]]; then
  printf '\033[31m%s check(s) failed — the release is not verified.\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32mPublished and verified.\033[0m\n'
