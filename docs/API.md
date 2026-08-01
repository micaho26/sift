# HTTP API

Base URL `http://127.0.0.1:4471/api`. Loopback only. No authentication — the trust boundary is the network interface.

Every request and response shape is a Zod schema in [`packages/core/src/types.ts`](../packages/core/src/types.ts).

## Health

### `GET /health`

Also the extension's handshake: `service` must be `"sift"` before any client trusts the port.

```json
{
  "ok": true,
  "version": "0.1.0",
  "service": "sift",
  "db": { "items": 329, "sizeBytes": 4915200, "vectorSearch": true, "fullTextSearch": true },
  "embeddings": { "provider": "hash", "ready": true, "dimensions": 384 },
  "ai": { "provider": "none", "configured": false },
  "uptimeSec": 412
}
```

## Search

### `GET /search`

Query parameters map to `SearchQuery`. Comma-separated for arrays.

```
q          text query (empty = browse)
sort       signal | recent | relevance | velocity | oldest
           omitted → relevance when q is present, signal otherwise
mode       hybrid (default) | keyword | semantic
limit      1–200, default 50
cursor     opaque, from a previous response
minScore   0–100
from, to   epoch ms on COALESCE(published_at, captured_at)
diversify  0–1, MMR strength
starred, unreadOnly, hasMedia   "true"
lang, collectionId
sources, kinds, states, tags, topics, authors    comma-separated
facets     "true" to include facet counts
```

```bash
curl -s 'localhost:4471/api/search?states=inbox&sort=signal&limit=5'
curl -sG 'localhost:4471/api/search' --data-urlencode 'q=推理成本'
```

Response:

```json
{
  "items": [ /* ItemSummary[] — no `content`, no `raw` */ ],
  "total": 36,
  "cursor": "eyJvIjo1MH0",
  "tookMs": 2.14,
  "matchedBy": { "i_abc": "both", "i_def": "semantic" },
  "concepts": ["efficiency", "vLLM"],
  "facets": { "sources": [], "topics": [], "tags": [], "authors": [] }
}
```

`matchedBy` lets the UI badge how each result was found. `concepts` are the topic and entity ids the query expanded into.

### `POST /search`
```json
{ "query": { /* full SearchQuery */ }, "facets": true }
```

### `GET /search/facets`
Distinct tags, topics, authors and sources with counts, for the filter UI.

## Items

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/items/counts` | Sidebar badge counts |
| `GET` | `/items/:id` | Item + highlights + collections + `why` + `similar` |
| `POST` | `/items/batch` | `{ ids }` → items, in the order given |
| `POST` | `/items/state` | `{ ids, state }` |
| `POST` | `/items/star` | `{ ids, starred }` |
| `POST` | `/items/read` | `{ ids, read, dwellSec }` |
| `PUT` | `/items/:id/tags` | `{ tags }` — replaces the set |
| `PUT` | `/items/:id/ai` | `{ summary?, translation?, takeaways? }` — manual override |
| `DELETE` | `/items` | `{ ids }` — permanent |
| `GET` | `/items/:id/similar` | Vector neighbours |

**Every triage endpoint takes an array.** They are all reachable from a multi-select, and a client that has to loop produces N round-trips and a half-applied state when one fails.

```bash
curl -s -X POST localhost:4471/api/items/state \
  -H 'content-type: application/json' \
  -d '{"ids":["i_abc","i_def"],"state":"saved"}'
```

`GET /items/:id` includes `why`: the ranked, human-readable reasons behind the score.

## Ingestion

### `POST /ingest`

The extension's only write path. Zod-parsed and size-capped.

```json
{
  "items": [{
    "url": "https://x.com/karpathy/status/1899000000000000001",
    "source": "x",
    "kind": "thread",
    "title": "…",
    "content": "…",
    "author": { "name": "Andrej Karpathy", "handle": "karpathy", "followers": 1240000 },
    "metrics": { "likes": 18400, "reposts": 3120, "bookmarks": 9800 },
    "publishedAt": 1785000000000
  }],
  "collector": "x:HomeTimeline"
}
```

Response reports what happened to every item — a silent drop would leave the user believing a capture succeeded:

```json
{ "received": 2, "created": 2, "updated": 0, "duplicates": 0, "rejected": 0,
  "ids": ["i_abc", "i_def"], "errors": [] }
```

Server-owned fields (`id`, `score`, `urlHash`, `state`) are absent from the input by design.

### `POST /ingest/check`
`{ urls }` → which are already known, with state and score. Lets the extension render "already saved" without shipping page content.

### `POST /ingest/rescore`
`{ limit? }` → recompute every score. Chunked, streams progress over SSE.

## Live updates

### `GET /stream`

Server-sent events. One connection per tab.

| Event | Payload |
|---|---|
| `items:new` | `{ count, ids, topScore }` — coalesced over 250 ms |
| `items:updated` | `{ ids }` |
| `items:removed` | `{ ids }` |
| `source:status` | `{ id, state, message?, collected? }` |
| `job` | `{ name, state, progress?, message? }` |
| `ping` | `{ t }` — every 25 s |

A 200-item extension batch produces **one** `items:new`, not 200.

## Library

| Group | Endpoints |
|---|---|
| Collections | `GET/POST /collections`, `GET/PATCH/DELETE /collections/:id`, `POST/DELETE /collections/:id/items` |
| Highlights | `GET/POST /highlights`, `PATCH/DELETE /highlights/:id` |
| Saved views | `GET/POST /views`, `PATCH/DELETE /views/:id`, `POST /views/:id/seen` |

A collection with `smartQuery` set resolves its membership from that query at read time rather than from pinned rows.

## Sources

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sources` | Configured sources + available kinds + presets |
| `POST` | `/sources` | Add one |
| `PATCH` | `/sources/:id` | Update — including `trust` and `enabled` |
| `DELETE` | `/sources/:id` | Remove |
| `POST` | `/sources/:id/run` | Poll now |
| `POST` | `/sources/refresh` | Poll everything, backfill embeddings, rebuild the interest model |
| `POST` | `/sources/defaults` | Restore the curated 13 |

## Settings

### `GET /settings`
Returns settings plus AI status. `ai.apiKeySet` is a boolean; **the key itself is never returned by any endpoint.**

### `PUT /settings`
Accepts a partial `Settings`. Changing interests, weights or the half-life triggers a background rescore; the response says `rescoring: true`. Changing the embedding provider re-embeds in the background.

### `PUT /settings/keys`
`{ provider: "anthropic" | "openai", key: string | null }` — write-only. `null` deletes.

## AI

All generative endpoints stream SSE with `delta`, `done`, and `error` events. All degrade gracefully when no provider is configured.

| Path | Without a provider |
|---|---|
| `POST /ai/summarize` | Local extractive summary |
| `POST /ai/translate` | `400 ai_not_configured` — the one feature that genuinely needs a model |
| `POST /ai/takeaways` | Top-scoring sentences |
| `POST /ai/chat` | Returns the matching items instead of prose |
| `POST /ai/synthesize` | A template brief from the selection |

`/ai/chat` emits a `citations` event **before** the first token, carrying exactly the passages the model was shown, so the user can verify every claim against the source actually used.

```bash
curl -N -X POST localhost:4471/api/ai/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What changed in inference efficiency?"}],"topK":12}'
```

## Analytics

### `GET /analytics?days=30`

Totals, volume series, per-source breakdown, topic momentum, top authors, entity counts, score histogram, activity heatmap, daily activity.

Topic momentum carries `isNew: true` when there is no comparable prior window, so the UI can label it rather than report meaningless growth on a fresh install.

## Digests

| Method | Path |
|---|---|
| `GET` | `/digests`, `/digests/latest`, `/digests/:id` |
| `POST` | `/digests` — `{ hours?, maxItems?, template? }` |

`template: true` forces the local path even when an LLM is available.

## Export

### `POST /export`
```json
{ "format": "markdown" | "json" | "csv",
  "itemIds": ["…"],           // or omit and pass `query`
  "query": { /* SearchQuery */ },
  "includeHighlights": true,
  "title": "My export" }
```

CSV is BOM-prefixed so Excel opens UTF-8 Chinese correctly rather than as mojibake.

### `GET /export/opml`
Every RSS source as OPML, so your feeds can move to another reader.

### `GET /export/card/:id?theme=dark|light`
### `GET /export/digest-card/:id?theme=dark|light`

An SVG share card, rendered server-side with no headless browser and no canvas dependency. The web app rasterises it to PNG in-page when a bitmap is wanted.

## Errors

```json
{ "error": "Item not found", "detail": "…", "code": "…" }
```

| Status | Meaning |
|---|---|
| 400 | Validation failed, or a feature needs configuration (`code: ai_not_configured`) |
| 404 | No such resource |
| 500 | Unhandled — the detail is the exception message |
| 502 | An upstream provider failed |

A malformed FTS query degrades to "no keyword hits" rather than a 500: search is a read path, and returning fewer results beats returning an error.
