# Contributing

Thanks for looking. Sift is small enough that one afternoon is genuinely enough to understand all of it.

## Setup

```bash
git clone https://github.com/micaho26/sift && cd sift
pnpm install
pnpm seed
pnpm dev
```

Requires Node 24+ (for `node:sqlite`) and pnpm. There are no native modules, so install cannot fail on a compile step.

## Before opening a PR

```bash
pnpm typecheck
pnpm test
pnpm build
```

All three must pass. CI runs the same commands.

If you use Claude Code, `/push` does the whole sequence — it surveys every
worktree, branch and stash for work you might have forgotten, refuses to push
when it finds credential-shaped strings or a gitignored file that is tracked,
runs the pipeline locally *before* pushing, opens the PR, waits for CI, and then
verifies the merge actually published: live site, no third-party asset origins,
and a fresh clone that installs, tests, seeds and boots. See
[`.claude/skills/push/SKILL.md`](.claude/skills/push/SKILL.md) — the two scripts
under it are plain bash and worth reading before you trust them.

## Where things live

| I want to… | Go to |
|---|---|
| Add a source | `apps/server/src/connectors/index.ts` — add a `Connector` and register it |
| Change ranking | `packages/core/src/score.ts` — pure functions, easy to test |
| Add topics or entities | `packages/core/src/taxonomy.ts` |
| Change search | `apps/server/src/search.ts` |
| Add an endpoint | `apps/server/src/routes/` |
| Change the UI | `apps/web/src/` |
| Extend capture | `apps/extension/src/lib/extract-*.ts` |
| Adjust design tokens | `apps/web/src/styles.css` |

## House style

**Comments explain *why*, never *what*.** `// increment the counter` is noise. `// Bookmarks weigh 4x because they are the hardest counter to farm` is the reason someone can safely change the number later. If a decision has a trade-off, name the trade-off.

**Prefer boring code.** The interesting parts of this codebase are the scoring model and the dedup strategy. Everything else should be as unremarkable as possible.

**No new dependencies without a reason that survives a sentence.** The dependency list is short on purpose. "It saves 40 lines" is not a reason; "it implements a spec we would otherwise get wrong" is.

**Zod at every process boundary.** Anything from the extension, or from a platform's API, is parsed rather than cast.

**Never clobber user state.** Re-ingesting an item refreshes metrics and scores; it must not touch `state`, `starred`, highlights or hand-added tags.

**Degrade, do not fail.** A malformed FTS query returns no keyword hits. An unreachable Ollama falls back to the hash embedder. An AI failure falls back to extractive summarisation. The product must stay usable when a part of it is not.

## Adding a connector

```ts
const myConnector: Connector = async ({ source }) => {
  const data = await fetchJson<Shape>(`https://example.com/api?q=${encodeURIComponent(source.target)}`)
  return data.items.map((entry): IngestItem => ({
    url: entry.link,
    source: 'rss',            // or add a new SourceKind in packages/core
    kind: 'article',
    title: entry.title,
    content: htmlToText(entry.body),
    author: { name: entry.author },
    metrics: { points: entry.score },
    publishedAt: Date.parse(entry.date) || undefined,
  }))
}

export const CONNECTORS = { /* … */ myConnector }
```

Rules:

- **Public and keyless.** A connector that needs a key belongs behind a setting, not in the default set — a new user must get a full inbox with no signup.
- **Return raw data.** Do not score, dedupe or classify; the pipeline owns all of that.
- **Let errors throw.** The scheduler records them per-source and surfaces them in the UI.
- **Prefer "recently created and gaining attention" over "all-time popular."** The latter returns the same famous things forever.

If you add a new `SourceKind`, also add it to `SOURCE_PROFILES` in `score.ts` (counter weights and a p95 reference) and `SOURCE_META` in `format.ts` (label and colour).

## Adding to the taxonomy

Two vocabularies, and the distinction matters:

```ts
{
  id: 'efficiency',
  terms: ['quantization', 'kv cache', 'throughput'],        // documents
  querySynonyms: ['cheaper', 'cost per token', '降本'],      // queries only
}
```

`terms` decides how items are **filed**, so it must be precise. `querySynonyms` expands a **search**, so it can be loose. Putting a loose word in `terms` mislabels the whole corpus — "memory" once tagged unrelated interpretability papers as `hardware`.

Chinese terms are welcome and expected in both lists.

## Tests

`node:test`, no framework. Core tests run against built output, so they exercise the public API surface.

```bash
pnpm --filter @sift/core test
pnpm --filter sift-extension test
```

**Assert behaviour, not values.** `assert.equal(score, 66)` breaks every time a weight moves and tells you nothing. `assert.ok(substantive.score > bait.score)` encodes the actual requirement and keeps working.

New scoring or extraction logic needs a test. New UI does not — but do check both themes and a narrow viewport.

## Commits and PRs

Imperative subject, under ~72 characters. Explain *why* in the body if it is not obvious.

```
Weight bookmarks above likes in the X velocity term

A bookmark is the strongest "I will return to this" signal on X and the
hardest to farm; likes are close to free. Measured on the demo corpus,
this moves substantive threads up ~8 points and bait down ~4.
```

One concern per PR. Say what you changed, why, and how you checked it. Screenshots for UI changes, before and after.

## Reporting bugs

Include the output of `curl -s localhost:4471/api/health`, what you expected, what happened, and the server log with `SIFT_LOG=debug`.

For a scoring complaint, the most useful thing you can send is the item's score breakdown — press <kbd>W</kbd> on it. "This ranked too low" is hard to act on; "novelty was 0.12 but this is a genuinely new result" is immediately actionable.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

Particular care is warranted around: the ingestion endpoint (untrusted input from pages we do not control), the MAIN-world interceptor (runs in a hostile realm), the FTS query builder (user input near SQL), and anything touching stored API keys.

## Licence

Contributions are accepted under the MIT licence.
