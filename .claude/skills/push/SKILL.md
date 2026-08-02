---
name: push
description: "Collect every uncommitted and unpushed change in this repo — the primary worktree, every linked worktree, and any local-only branch — onto one new branch, open a PR, let CI verify it, merge to main, then confirm the project is actually published and runnable. Runs the local pipeline before pushing and refuses to merge on red. Triggers on: push, 推一下, 发布, 上线, 把改动推上去, 合并到 main, 走一遍流水线, ship it, release."
---

# push — collect, verify, merge, confirm published

One command for: *everything I have locally should end up on `main`, and `main`
should still work afterwards.*

The order matters. Verify locally, **then** push. A PR that fails CI has already
cost a round trip and a notification; the same failure found in 40 seconds
locally costs nothing.

## What counts as "all the changes"

`git status` in one directory does not show it. Four places hold work:

| Where | How it surfaces |
|---|---|
| Primary worktree | `git status` |
| Linked worktrees | only in `git -C <path> status` — each is a separate checkout on its own branch |
| Local-only branches | `git for-each-ref` — no upstream, or ahead of it |
| Stashes | `git stash list` |

**Stashes are never collected.** A stash is work someone deliberately set aside;
publishing it is the opposite of what setting it aside meant. Report them and
move on. If the user wants a stash included they will say so, and then it is
`git stash pop` first, as a separate decision.

## Procedure

### 1. Survey — never skip this

```bash
.claude/skills/push/scripts/survey.sh
```

Read-only. It enumerates all four places, and it hard-fails on two things:

- **a file tracked despite being gitignored** — `git add -f` on a `data/` or
  `.env` path stays tracked forever afterwards, which is how a private database
  reaches a public repo months later
- **credential-shaped strings** in tracked files or in unpushed commits

If it exits non-zero, **stop**. Show the user the blocker and what to do about
it (`git rm --cached <path>`, rotate the key, rewrite the commit). Do not push
"just this once" — the push is what makes it public and irreversible.

Then tell the user what you are about to push, in one short block: which
worktrees, which branches, how many commits. This is the last cheap moment to
notice something wrong.

### 2. Local pipeline — before anything leaves the machine

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm build:site
```

All four. `pnpm test` alone is not enough: Node's type-stripping does not
typecheck, so a type error only ever surfaces in `pnpm typecheck`, and the site
build is the only thing that catches a broken Astro page.

If anything fails: **fix it, then restart at step 1.** Do not push a branch that
you already know is red.

### 3. Commit each dirty worktree, in place

Commit in the worktree that owns the change, on its own branch — not by copying
files into the primary tree. That keeps authorship and history where they belong
and it is what makes step 4 a merge rather than a guess.

```bash
git -C <worktree> add -A
git -C <worktree> commit -m "<message>"
```

`add -A` respects `.gitignore`, so `data/` and `.env` cannot be picked up here —
step 1 already covered the case where something was force-added earlier.

Write a real message for each: what changed and why, in this repo's style —
imperative subject, then the reasoning. If a worktree's changes are unrelated to
each other, make separate commits. One commit per idea, not one per push.

### 4. Integrate onto a new branch

```bash
git switch -c push/$(date +%Y%m%d-%H%M)      # add a slug if the user gave one
```

Branch from the current `main` (which may itself be ahead of origin — that work
is included, not lost). Then merge each collected branch:

```bash
git merge --no-ff <branch> -m "Merge <branch>"
```

**On a conflict: stop.** Show the conflicting files and ask which side wins.
Never resolve a conflict between two pieces of the user's parallel work by
guessing — that is how one worktree's afternoon disappears. `git merge --abort`
leaves everything as it was, so stopping costs nothing.

Re-run step 2 after integrating. Two branches that each pass can still fail
together, and that is exactly what an integration branch exists to find.

### 5. Push and open the PR

```bash
git push -u origin HEAD
gh pr create --base main --fill
```

Write the PR body properly — a summary of what changed and the verification you
actually ran. If several logical changes are in one branch, list them.

**Never `git push --force` to a branch that already exists on origin** unless
the user asks for it in those words. Force-pushing a branch someone else (or
another agent, or a running CI job) has fetched destroys history that was already
shared.

### 6. Wait for CI, then merge

```bash
gh pr checks --watch
```

Merge only when every check is green:

```bash
gh pr merge --squash --delete-branch
```

Squash by default — this repo's `main` is linear, and the individual commit
messages survive in the squash body. Use `--merge` instead when the branch
collects work from several worktrees and per-commit attribution matters.

**Never `--admin`.** Never merge with a failing or pending check. If CI is red,
the job is to fix it and push again, not to get past the gate — the gate is the
only thing standing between a broken `main` and everyone who clones it.

### 7. Confirm it is actually published

```bash
.claude/skills/push/scripts/verify-published.sh
```

Green CI means the code compiled on a runner. It does not mean a stranger can
clone this and have it run, and it does not mean the site people are linked to is
serving the new build. Those are the promises this repo makes in its README, so
those are what get checked:

- every workflow run on the new `main` SHA succeeded
- the live site and `/showcase/` return 200
- the served HTML pulls **no third-party asset origin** — the site's own first
  claim is that nothing leaves your machine, and a Google Fonts link makes that
  false on the marketing page itself
- the repo still serves its custom social preview rather than GitHub's auto-card
- a fresh `git clone` installs, passes its tests, seeds, boots, and answers
  `/api/health`

Pass `--skip-clone` only when the change cannot affect installability (copy edits,
images). Anything touching `package.json`, a lockfile, or `apps/server` gets the
full run.

If a check fails after the merge, say so plainly and fix forward — do not quietly
re-run until it passes.

## Notes on this repo

- **Deploy is path-filtered.** `pages.yml` only runs on `apps/site/**`,
  `assets/screenshots/**` or its own file. A change elsewhere produces no deploy
  run, and that is correct — do not wait for a workflow that will never start.
- **Health is at `/api/health`,** not `/health`; routes mount under `/api`.
- **Node 24+ is a hard requirement** — the persistence layer is `node:sqlite`.
- **Generated assets are committed** (`assets/screenshots/`,
  `apps/site/public/social/`). If a change makes them stale, regenerate with
  `pnpm screenshots` / `pnpm social-cards` / `pnpm promo-cards` in the same
  branch, so the README and the live site never disagree with the code.
- **Test scripts name their files explicitly.** If you add a test file, add it to
  the package's `test` script — the deliberate cost of not globbing, which is
  what let `apps/server` have a test script and no tests while CI stayed green.

## When to stop and ask

Everything above is designed to run without check-ins. These are the exceptions,
because guessing wrong is unrecoverable:

- a merge conflict between two pieces of the user's own work
- a survey blocker (secret material, or an ignored file that is tracked)
- CI red for a reason that looks like a real defect rather than flake
- the user asking to force-push, to merge with `--admin`, or to include a stash
