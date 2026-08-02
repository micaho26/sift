#!/usr/bin/env bash
#
# Read-only inventory of everything that is not yet on origin/main.
#
# Nothing here mutates the repository. It exists so the decision about *what*
# gets pushed is made from facts rather than from whatever `git status` in one
# directory happened to show — this repo can have work sitting in a linked
# worktree, on a local-only branch, or in a stash, and none of those appear in
# the primary worktree's status.
#
# Exit codes:
#   0  surveyed; safe to proceed
#   1  a blocker was found (secret material, or a file tracked despite being
#      ignored). Do not push until it is resolved.
#   2  invoked outside a git repository
#
# Usage: .claude/skills/push/scripts/survey.sh

set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "not a git repository" >&2
  exit 2
}

BLOCKERS=0
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
bad() {
  printf '  \033[31m✗ %s\033[0m\n' "$1"
  BLOCKERS=$((BLOCKERS + 1))
}
ok() { printf '  \033[32m✓ %s\033[0m\n' "$1"; }

DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
git fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || warn "could not reach origin — figures below may be stale"

bold "── worktrees ──"
# --porcelain gives one stanza per worktree; the path line is what we need.
WORKTREES=()
while IFS= read -r line; do
  [[ $line == worktree\ * ]] && WORKTREES+=("${line#worktree }")
done < <(git worktree list --porcelain)

for wt in "${WORKTREES[@]}"; do
  branch="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '(detached)')"
  dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  untracked="$(git -C "$wt" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"
  label="$wt"
  [[ "$wt" == "$PWD" ]] && label="$wt (this one)"
  if [[ "$dirty" == "0" ]]; then
    ok "$label · $branch · clean"
  else
    warn "$label · $branch · $dirty changed ($untracked untracked)"
    git -C "$wt" status --short | sed 's/^/      /'
  fi
done

bold "── local branches not on origin ──"
FOUND_BRANCH_WORK=0
while IFS=$'\t' read -r name upstream track; do
  if [[ -z "$upstream" ]]; then
    count="$(git rev-list --count "origin/$DEFAULT_BRANCH..$name" 2>/dev/null || echo '0')"
    # A branch with no commits of its own is a checkout, not pending work — its
    # dirty worktree is already reported above, so saying "0 commits" here is
    # noise that makes the real entries harder to see.
    if [[ "$count" != "0" ]]; then
      warn "$name · no upstream · $count commit(s) not in origin/$DEFAULT_BRANCH"
      git log --oneline "origin/$DEFAULT_BRANCH..$name" | sed 's/^/      /'
      FOUND_BRANCH_WORK=1
    fi
  elif [[ "$track" == *ahead* ]]; then
    warn "$name · $track"
    FOUND_BRANCH_WORK=1
  fi
done < <(git for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)' refs/heads)
[[ "$FOUND_BRANCH_WORK" == "0" ]] && ok "no local branch carries commits that origin lacks"

bold "── stashes ──"
STASHES="$(git stash list | wc -l | tr -d ' ')"
if [[ "$STASHES" == "0" ]]; then
  ok "none"
else
  # Stashes are deliberately NOT collected: a stash is work someone set aside,
  # and silently publishing it is the opposite of what setting it aside meant.
  warn "$STASHES stash(es) present — these are NOT collected, apply them first if you want them included"
  git stash list | sed 's/^/      /'
fi

bold "── files tracked despite being ignored ──"
# `git add -f` on a gitignored path stays tracked forever afterwards, which is
# how a private database or an .env ends up in a public repo months later.
IGNORED_TRACKED="$(git ls-files --cached --ignored --exclude-standard)"
if [[ -z "$IGNORED_TRACKED" ]]; then
  ok "none"
else
  while IFS= read -r f; do bad "tracked but gitignored: $f"; done <<<"$IGNORED_TRACKED"
fi

bold "── secret scan ──"
# Two passes, because each misses what the other catches — both of these gaps
# were real in the first version of this script and only showed up when the
# blocker was tested with an actual planted key:
#
#   1. Working trees, tracked AND untracked. `git ls-files` alone lists only
#      tracked files, so a brand-new file holding a key would sail through —
#      and a new file is exactly what step 3's `git add -A` commits.
#      `--untracked` includes it; gitignored paths stay excluded, correctly,
#      since they are never pushed.
#
#   2. The full patch series, not a diff. `git diff origin/main...HEAD` shows
#      the NET change, so a secret added in one commit and removed in the next
#      is invisible to it — while still being fully present in the history that
#      gets pushed. `git log -p --branches --not --remotes` is every commit on
#      every local branch that no remote has yet, which is exactly the set
#      about to become public.
PATTERNS='-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bpsa]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'
HITS=0

for wt in "${WORKTREES[@]}"; do
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    bad "possible credential — ${wt}/${hit%%:*} line $(echo "$hit" | cut -d: -f2)"
    HITS=1
  done < <(git -C "$wt" grep -I -n -E --untracked -e "$PATTERNS" -- . 2>/dev/null)
done

UNPUSHED_HITS="$(git log -p --no-color --branches --not --remotes 2>/dev/null | grep -cE "^\+.*($PATTERNS)" || true)"
if [[ "${UNPUSHED_HITS:-0}" -gt 0 ]]; then
  bad "$UNPUSHED_HITS added line(s) in unpushed commits look like credentials — inspect: git log -p --branches --not --remotes"
  HITS=1
fi

[[ "$HITS" == "0" ]] && ok "no credential-shaped strings in any worktree or unpushed commit"

bold "── unpushed commits on HEAD ──"
if git rev-parse --quiet --verify "origin/$DEFAULT_BRANCH" >/dev/null; then
  AHEAD="$(git rev-list --count "origin/$DEFAULT_BRANCH..HEAD")"
  if [[ "$AHEAD" == "0" ]]; then
    ok "HEAD matches origin/$DEFAULT_BRANCH"
  else
    warn "$AHEAD commit(s) ahead of origin/$DEFAULT_BRANCH"
    git log --oneline "origin/$DEFAULT_BRANCH..HEAD" | sed 's/^/      /'
  fi
fi

echo
if [[ "$BLOCKERS" -gt 0 ]]; then
  printf '\033[31m%s blocker(s). Resolve these before pushing.\033[0m\n' "$BLOCKERS"
  exit 1
fi
printf '\033[32mSurvey clean.\033[0m\n'
