/**
 * Search and ingestion routes.
 *
 * `/ingest` is the extension's only write endpoint. It is the one place where
 * untrusted input enters the system, so the payload is Zod-parsed, size-capped,
 * and the response reports exactly what happened to every item — a silent drop
 * would leave the user believing a capture succeeded when it did not.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { IngestRequest, SearchQuery, canonicalizeUrl } from '@sift/core'
import { ingest } from '../pipeline/ingest.ts'
import { listFacetValues, search } from '../search.ts'
import { findByUrlHash, sha256 } from '../repo/items.ts'
import { readSettings } from '../repo/settings.ts'
import { rescoreAll } from '../pipeline/rescore.ts'

export const searchRoutes = new Hono()

  /** GET for shareable/bookmarkable URLs; POST for the full filter object. */
  .get('/', async (c) => {
    const q = c.req.query()
    const parsed = SearchQuery.safeParse({
      q: q.q ?? '',
      sort: q.sort,
      mode: q.mode,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor,
      minScore: q.minScore ? Number(q.minScore) : undefined,
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      diversify: q.diversify ? Number(q.diversify) : undefined,
      starred: q.starred === 'true' ? true : undefined,
      unreadOnly: q.unreadOnly === 'true' ? true : undefined,
      hasMedia: q.hasMedia === 'true' ? true : undefined,
      lang: q.lang,
      collectionId: q.collectionId,
      sources: q.sources ? q.sources.split(',').filter(Boolean) : undefined,
      kinds: q.kinds ? q.kinds.split(',').filter(Boolean) : undefined,
      states: q.states ? q.states.split(',').filter(Boolean) : undefined,
      tags: q.tags ? q.tags.split(',').filter(Boolean) : undefined,
      topics: q.topics ? q.topics.split(',').filter(Boolean) : undefined,
      authors: q.authors ? q.authors.split(',').filter(Boolean) : undefined,
    })
    if (!parsed.success) return c.json({ error: 'Invalid query', detail: parsed.error.issues[0]?.message }, 400)
    return c.json(await search(parsed.data, { facets: q.facets === 'true' }))
  })

  .post('/', zValidator('json', z.object({ query: SearchQuery, facets: z.boolean().default(false) })), async (c) => {
    const { query, facets } = c.req.valid('json')
    return c.json(await search(query, { facets }))
  })

  /** Distinct filter values for the search UI. */
  .get('/facets', (c) => c.json(listFacetValues()))

export const ingestRoutes = new Hono()

  .post('/', zValidator('json', IngestRequest), async (c) => {
    const { items, collector } = c.req.valid('json')
    const settings = readSettings()
    const result = await ingest(items, { collector, settings })
    return c.json(result)
  })

  /**
   * Cheap existence check so the extension can render "already saved" without
   * shipping the page content. Takes URLs, returns the ones we already have.
   */
  .post('/check', zValidator('json', z.object({ urls: z.array(z.string()).min(1).max(300) })), (c) => {
    const known: Record<string, { id: string; state: string; score: number; starred: boolean }> = {}
    for (const url of c.req.valid('json').urls) {
      const canonical = canonicalizeUrl(url)
      const row = findByUrlHash(sha256(canonical.url || url))
      if (row) known[url] = { id: row.id, state: row.state, score: row.score, starred: row.starred === 1 }
    }
    return c.json({ known })
  })

  /** Re-score the corpus after a weight or interest change. */
  .post(
    '/rescore',
    zValidator('json', z.object({ limit: z.number().int().min(1).max(100_000).default(20_000) }).optional()),
    async (c) => {
      const limit = c.req.valid('json')?.limit ?? 20_000
      const result = await rescoreAll(limit)
      return c.json(result)
    },
  )
