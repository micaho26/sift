# Architecture

A map of how Sift is put together and, more usefully, why each part is the way it is.

## Shape

Four applications and one shared library in a pnpm workspace.

| Package | Role | Runs where |
|---|---|---|
| `@sift/core` | Pure domain logic — types, scoring, SimHash, RRF, taxonomy, fallback embedder | Node, browser, service worker |
| `sift-server` | HTTP API, connectors, ingestion pipeline, SQLite, AI | Node 24, loopback only |
| `sift-web` | The application UI | Browser |
| `sift-extension` | Capture from X, 小红书 and arbitrary pages | Chromium MV3 |
| `sift-site` | Marketing site | Static, GitHub Pages |

`@sift/core` is deliberately dependency-light (Zod only) and free of platform assumptions. That constraint pays off concretely: the extension can score a post locally to decide whether it is worth sending, the server scores it again authoritatively, and the web app explains the score — all from one implementation, with no chance of the three disagreeing.

## Data model

SQLite, one file, WAL mode. The shape follows one rule: **JSON for what is read whole, normalised tables for what is queried.**

```
items                 the only table with a hot write path
├── author_json       read whole → JSON
├── metrics_json      read whole → JSON
├── media_json        read whole → JSON
├── score_json        the full breakdown, so "why?" needs no recompute
└── embedding         BLOB, raw little-endian Float32

item_tags   (item_id, tag)          queried → normalised + indexed
item_topics (item_id, topic)        queried → normalised + indexed
item_entities (item_id, name, type) queried → normalised + indexed
item_bands  (band, item_id)         SimHash LSH index

items_fts   FTS5 virtual table: title, body, author, tags, cjk
fts_map     (rowid → item_id), because FTS5 rowids are integers and ours are text

collections / collection_items / highlights / saved_searches / sources / digests
author_stats  revealed preference: seen, saved, dismissed per author
kv            settings and secrets
events        local-only activity ledger
```

Storing tags as JSON would make "everything tagged X" a full scan. Storing metrics normalised would mean six joins to render one row. Neither choice is universally right; both are right here.

### Indexes that exist for a reason

- `idx_items_state_score (state, score DESC)` — the feed's default query is literally `WHERE state = ? ORDER BY score DESC`.
- `idx_items_starred`, `idx_items_unread` — partial indexes, so they cost nothing until used.
- `item_bands` is `WITHOUT ROWID` with a composite primary key: it is a pure lookup table and the rowid would be dead weight.

## Search

Four retrievers, one ranking.

```
query ──┬─▶ keyword    FTS5 BM25(title×10, body×1, author×3, tags×4, cjk×1)
        ├─▶ concept    classifyTopics(query) → item_topics ∩ item_entities
        ├─▶ semantic   exact cosine KNN over the flat matrix
        └─▶ (no query) indexed scan, keyset paginated
                            │
                            ▼
              Reciprocal Rank Fusion  Σ wᵢ / (60 + rankᵢ)
                            │
                            ▼
              MMR diversification (optional)
                            │
                            ▼
              re-sort by the user's chosen sort
```

**Why RRF and not weighted score normalisation.** BM25 returns unbounded negatives; cosine returns 0–1. Any normalisation constant that worked for one corpus would be wrong for the next. RRF combines *ranks*, so it needs no tuning and cannot be skewed by an outlier score.

**Why a concept retriever exists.** The default embedder is lexical, so it cannot know that "making models cheaper to run" means `efficiency`. But we already own a curated AI taxonomy that does. Running the *query* through the same classifier the items went through gives conceptual retrieval that is exact (topic ids, not fuzzy distances), instant, offline, and explainable — the UI can name which concept matched.

This required separating two vocabularies. `terms` is the language of documents ("quantization", "throughput") and decides how items are filed. `querySynonyms` is the language of questions ("cheaper", "memory", "score") and is used only to expand a query. Mixing them was tried and mislabelled the corpus: "memory" tagged unrelated papers as `hardware`.

**Query resolution.** `sort` is intentionally optional in the schema. Browsing wants the highest signal; searching wants the best answer to what was typed. One default cannot serve both, so the server resolves `sort ?? (q ? 'relevance' : 'signal')`.

### CJK

`unicode61` treats a Chinese sentence as a single token. The fix is a parallel `cjk` column holding application-generated character bigrams, and a query builder that emits ordered bigram *phrases* — which is exactly substring matching.

A full-sentence query cannot be phrase-matched verbatim (no document contains the whole sentence), so interrogative affixes are stripped from both ends and the remainder becomes overlapping 4-character windows OR-ed together, letting BM25 rank by how many windows a document contains.

## The vector index

An in-process flat matrix: row-major `Float32Array`, one contiguous allocation, grown geometrically. Deletes tombstone and zero their row rather than splicing, so inserts and deletes are O(1) and search stays sequential over memory.

Search is exact top-k by dot product (vectors are pre-normalised, so dot product *is* cosine), with a bounded insertion-sorted top-k rather than a heap — for the k ≤ 200 we ever request, the constant factors favour it and results come out already ordered. The inner loop is unrolled by four.

**Why not sqlite-vec, LanceDB or hnswlib.** All three would be faster and all three would be worse here. 100k × 384 is ~25 ms of exact scan; the ANN alternatives add a native dependency, an index to keep in sync, a recall cliff, and a class of bug where the index and the table disagree. When filters are present, SQL narrows to a candidate set first and only those rows are scored — which is how faceted semantic search stays fast.

## The ingestion pipeline

```
canonicalise → mute filter → enrich → fingerprint → dedup → embed → score → store
```

The order is load-bearing:

- **Dedup before scoring** — no point spending an embedding and a score on the fortieth copy.
- **Embed before tier-2 dedup** — which needs the vector. The result is reused for storage and scoring, so nothing is computed twice.
- **Score last** — it needs the novelty measurement, which only exists once the vector can be compared against the corpus.

**URL canonicalisation is the foundation.** Four spellings of one tweet, `arxiv.org/pdf/…v3` versus `/abs/…`, `youtu.be` versus `watch?v=`, Xiaohongshu's per-session `xsec_token`. If these do not collapse to one key, everything downstream duplicates. `canonicalizeUrl` never throws — an unparseable input is still recorded rather than dropped.

**User state is never clobbered.** Re-ingesting refreshes volatile fields (metrics, score, title) and merges tags, but `state`, `starred`, highlights and hand-added tags survive. That asymmetry is why the write path is an explicit UPSERT rather than a REPLACE.

## Scoring

See [SCORING.md](SCORING.md) for the formulas. Architecturally, two properties matter:

1. **Pure and synchronous.** `computeScore` is a function of its inputs, so re-scoring the corpus after a weight change is cheap and deterministic.
2. **The breakdown is persisted.** Answering "why is this a 92?" requires no recomputation, and an old score stays legible because the weights in force at the time are stored with it.

The interest profile is the model of what you care about: stated interests from Settings plus revealed preference from what you saved. Saved items are *clustered* (deterministic farthest-point seeding, then Lloyd iterations with cosine assignment) rather than averaged — a user who follows both robotics and inference optimisation is served badly by a centroid sitting between the two, which resembles neither.

## The API

Hono, mounted at `/api`, bound to loopback.

| Group | Notable endpoints |
|---|---|
| `/health` | Doubles as the extension's handshake — `service: "sift"` |
| `/stream` | SSE; coalesces a 200-item batch into one `items:new` event |
| `/items` | Batch triage throughout: every endpoint takes an array |
| `/search` | GET for shareable URLs, POST for the full filter object |
| `/ingest` | The only write path the extension uses; Zod-parsed, size-capped |
| `/ai/*` | All generative endpoints stream, all degrade without a provider |
| `/export` | Markdown / JSON / CSV / OPML, plus SVG share cards |

Everything crossing a process boundary is a Zod schema in `@sift/core` with the TS type inferred from it. The extension is the least trustworthy caller in the system — it runs inside pages we do not control — so its payloads are parsed, never cast.

## The web app

React 19, Vite 8, Tailwind 4 with CSS-first tokens.

**URL as state.** The whole view — pane, filters, open item — lives in the address bar, via a ~150-line router. Not minimalism for its own sake: it makes every view shareable, makes back/forward correct for free, and makes a reload land exactly where you were. Opening an item `replaceState`s so arrowing through forty items does not bury the previous view under forty history entries; changing view or filters pushes.

**Optimistic triage.** Pressing `E` removes the row immediately and offers 6 seconds of undo, reconciling afterwards. Waiting for the round-trip makes rapid triage feel like wading; no undo makes it feel dangerous.

**Virtualisation.** TanStack Virtual with `content-visibility: auto` on rows. The keyboard cursor drives `scrollToIndex({align:'auto'})`, which scrolls the minimum needed and preserves the user's sense of place.

**Design tokens in OKLCH.** Perceptual lightness means one ramp step looks like the same step at every hue, so the accent, danger and success ramps stay consistent without hand-tuning. Dark-mode elevation is carried by hairlines and a 1px inner top highlight — a drop shadow on a near-black surface is invisible.

## The extension

Two worlds, one direction of data flow.

```
MAIN world (page realm)              ISOLATED world               service worker
patches fetch + XHR      ──post──▶   walks JSON      ──message──▶  queue (1.5s coalesce,
observes the page's own    Message    extracts items                dedup by URL)
responses                            DOM fallback                        │
                                                                         ▼
                                                              handshake → POST /api/ingest
```

The MAIN world is necessary because an isolated content script has its own `fetch` and would see nothing. Content scripts have no path to the Sift server — routing through the worker means one place enforces the handshake, and a compromised page cannot reach loopback.

The walkers are shape-tolerant: they look for objects *resembling* a tweet or a note rather than following a hardcoded path, with a cycle guard and a depth limit. Content scripts import from `@sift/core` **type-only** — pulling in the value graph dragged Zod and 400 compiled regexes into a script that runs on every page load, taking it from 10 KB to 114 KB.

## Performance

| Operation | Measured | Why |
|---|---|---|
| Server boot | ~10 ms + vector load | Prepared-statement cache, WAL, mmap |
| Feed query | <1 ms | Composite index, no joins for the row itself |
| Hybrid search | 2–6 ms | FTS5 + concept SQL + flat scan |
| Vector KNN (100k) | ~25 ms | Contiguous memory, unrolled loop |
| Full rescore | ~7 ms / 36 items | Pure function, chunked transactions, yields to the loop |
| Web bundle | 168 KB gzipped | Manual chunks, no component library |
| Content script | 10.5 KB | Type-only imports |

## Deliberate omissions

- **No ORM.** The queries are the interesting part; hiding them behind a query builder would obscure the indexes they depend on.
- **No state-management library.** TanStack Query owns server state, the URL owns view state, `useState` owns the rest. A third store would make staleness impossible to reason about.
- **No component library.** ~250 lines of primitives against our own tokens, versus fighting someone else's defaults.
- **No charting library.** Four hand-drawn SVG chart types, none of which would have matched the tokens without overrides.
- **No Docker.** `pnpm install && pnpm dev` on Node 24 is fewer moving parts than a container for a single-user local tool.
