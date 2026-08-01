/**
 * Hybrid search.
 *
 * Four retrieval paths, one ranking:
 *  - keyword: FTS5 BM25 over title/body/author/tags plus a CJK bigram column.
 *  - concept: the query run through the AI taxonomy, retrieving on matched topic
 *    and entity ids. This is what makes conceptual search work offline.
 *  - semantic: exact cosine KNN over the in-memory vector index.
 *  - browse: no query at all — a plain indexed scan, which is the common case
 *    for the feed and must not pay for any of the above.
 *
 * Results are merged with Reciprocal Rank Fusion rather than by normalising
 * scores, because BM25, concept overlap and cosine live on incomparable scales and
 * any normalisation constant we picked would be wrong for the next corpus.
 */
import {
  buildFtsQuery,
  classifyTopics,
  cosineSimilarity,
  extractEntities,
  maximalMarginalRelevance,
  reciprocalRankFusion,
  type ItemSummary,
  type SearchQuery,
  type SearchResponse,
} from '@sift/core'
import { all, get } from './db/index.ts'
import { getVectorIndex, vectorIndexReady } from './db/vector.ts'
import { getEmbedder } from './embed.ts'
import { SUMMARY_COLUMNS, hydrate, type ItemRow } from './repo/items.ts'

/** A SQL fragment plus its bound parameters. */
type Where = { sql: string; params: unknown[] }

/**
 * Translate the structured part of a query into SQL. Applies to all three
 * retrieval paths so filters behave identically whichever one runs.
 */
function buildWhere(query: SearchQuery, opts: { includeDuplicates?: boolean } = {}): Where {
  const clauses: string[] = []
  const params: unknown[] = []

  // Near-duplicates stay searchable but are hidden from normal listings.
  if (!opts.includeDuplicates) clauses.push('i.duplicate_of IS NULL')

  if (query.states?.length) {
    clauses.push(`i.state IN (${query.states.map(() => '?').join(',')})`)
    params.push(...query.states)
  } else {
    // Trash is never included unless explicitly asked for.
    clauses.push("i.state != 'trash'")
  }

  if (query.sources?.length) {
    clauses.push(`i.source IN (${query.sources.map(() => '?').join(',')})`)
    params.push(...query.sources)
  }
  if (query.kinds?.length) {
    clauses.push(`i.kind IN (${query.kinds.map(() => '?').join(',')})`)
    params.push(...query.kinds)
  }
  if (query.authors?.length) {
    clauses.push(`i.author_handle IN (${query.authors.map(() => '?').join(',')})`)
    params.push(...query.authors)
  }
  if (typeof query.minScore === 'number') {
    clauses.push('i.score >= ?')
    params.push(query.minScore)
  }
  if (query.from) {
    clauses.push('COALESCE(i.published_at, i.captured_at) >= ?')
    params.push(query.from)
  }
  if (query.to) {
    clauses.push('COALESCE(i.published_at, i.captured_at) <= ?')
    params.push(query.to)
  }
  if (query.starred) clauses.push('i.starred = 1')
  if (query.unreadOnly) clauses.push('i.read_at IS NULL')
  if (query.hasMedia) clauses.push("i.media_json IS NOT NULL AND i.media_json != '[]'")
  if (query.lang) {
    clauses.push('i.lang = ?')
    params.push(query.lang)
  }

  // Tags/topics use EXISTS rather than a JOIN so multiple values mean AND, not a
  // row multiplication that would silently change the result count.
  for (const tag of query.tags ?? []) {
    clauses.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag = ?)')
    params.push(tag)
  }
  for (const topic of query.topics ?? []) {
    clauses.push('EXISTS (SELECT 1 FROM item_topics tp WHERE tp.item_id = i.id AND tp.topic = ?)')
    params.push(topic)
  }
  if (query.collectionId) {
    clauses.push('EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_id = i.id AND ci.collection_id = ?)')
    params.push(query.collectionId)
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

type ResolvedSort = NonNullable<SearchQuery['sort']>
type ResolvedQuery = SearchQuery & { sort: ResolvedSort }

const ORDER_BY: Record<ResolvedSort, string> = {
  signal: 'i.score DESC, COALESCE(i.published_at, i.captured_at) DESC',
  recent: 'COALESCE(i.published_at, i.captured_at) DESC, i.score DESC',
  oldest: 'COALESCE(i.published_at, i.captured_at) ASC',
  velocity: "CAST(json_extract(i.score_json, '$.velocity') AS REAL) DESC, i.score DESC",
  // Relevance only means something when a query was supplied; fall back to signal.
  relevance: 'i.score DESC, COALESCE(i.published_at, i.captured_at) DESC',
}

/* ------------------------------------------------------------------ browse -- */

/** No-query listing: one indexed scan, keyset-paginated. */
function browse(query: ResolvedQuery): { rows: ItemRow[]; total: number; cursor?: string } {
  const where = buildWhere(query)
  const order = ORDER_BY[query.sort] ?? ORDER_BY.signal

  const offset = decodeCursor(query.cursor)
  const rows = all<ItemRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM items i ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...where.params,
    query.limit + 1,
    offset,
  )
  const total = get<{ n: number }>(`SELECT count(*) AS n FROM items i ${where.sql}`, ...where.params)?.n ?? 0

  const hasMore = rows.length > query.limit
  return {
    rows: hasMore ? rows.slice(0, query.limit) : rows,
    total,
    cursor: hasMore ? encodeCursor(offset + query.limit) : undefined,
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: number }
    const offset = Number(parsed.o ?? 0)
    return Number.isFinite(offset) && offset >= 0 ? Math.min(offset, 100_000) : 0
  } catch {
    return 0
  }
}

/* ----------------------------------------------------------------- keyword -- */

/**
 * BM25 over FTS5. Column weights put a title hit well above a body hit; `cjk`
 * is weighted like the body since it duplicates the same text as bigrams.
 */
function keywordSearch(
  query: SearchQuery,
  limit: number,
  opts: { relax?: boolean } = {},
): { id: string; rank: number }[] {
  const strict = buildFtsQuery(query.q)
  // Relaxed form: same clauses, OR instead of AND.
  const match = opts.relax ? strict.replace(/ AND /g, ' OR ') : strict
  if (!match) return []
  const where = buildWhere(query)
  // bm25() returns a negative number where more-negative is better, so ORDER BY
  // ascending is correct and no sign flip is needed.
  try {
    return all<{ id: string; rank: number }>(
      `SELECT m.item_id AS id, bm25(items_fts, 10.0, 1.0, 3.0, 4.0, 1.0) AS rank
         FROM items_fts f
         JOIN fts_map m ON m.rowid = f.rowid
         JOIN items i   ON i.id = m.item_id
        ${where.sql ? `${where.sql} AND` : 'WHERE'} items_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      ...where.params,
      match,
      limit,
    )
  } catch {
    // A malformed MATCH expression must degrade to "no keyword hits", never 500.
    return []
  }
}

/* ---------------------------------------------------------------- semantic -- */

/**
 * Vector KNN. Restricted to the SQL-filtered candidate set when filters are
 * present, so semantic search respects facets instead of returning items the
 * user has filtered away.
 */
async function semanticSearch(
  query: SearchQuery,
  limit: number,
): Promise<{ hits: { id: string; score: number }[]; queryVector: Float32Array | null }> {
  if (!query.q.trim() || !vectorIndexReady()) return { hits: [], queryVector: null }

  const index = getVectorIndex()
  if (index.size === 0) return { hits: [], queryVector: null }

  const embedder = getEmbedder()
  let queryVector: Float32Array
  try {
    queryVector = await embedder.embedOne(query.q)
  } catch {
    return { hits: [], queryVector: null }
  }
  if (queryVector.length !== index.dimensions) return { hits: [], queryVector: null }

  const allowed = candidateSet(query)
  // 0.15 floor: below that, hash-embedding cosine is noise and adding the result
  // only pollutes the fusion.
  const hits = index.search(queryVector, limit, allowed, 0.15)
  return { hits, queryVector }
}

/**
 * Ids matching the structural filters, for restricting the vector scan. Skipped
 * when the query has no filters — scanning the whole matrix is cheaper than
 * materialising 50k ids.
 */
function candidateSet(query: SearchQuery): Set<string> | null {
  const hasFilters = Boolean(
    query.sources?.length ||
      query.kinds?.length ||
      query.tags?.length ||
      query.topics?.length ||
      query.authors?.length ||
      query.collectionId ||
      query.starred ||
      query.unreadOnly ||
      query.hasMedia ||
      query.lang ||
      query.from ||
      query.to ||
      typeof query.minScore === 'number' ||
      (query.states?.length ?? 0) > 0,
  )
  if (!hasFilters) return null

  const where = buildWhere(query)
  const rows = all<{ id: string }>(`SELECT i.id FROM items i ${where.sql} LIMIT 40000`, ...where.params)
  return new Set(rows.map((r) => r.id))
}

/* ----------------------------------------------------------------- concept -- */

/**
 * The third retriever: concept expansion through the AI lexicon.
 *
 * A hash embedder captures lexical overlap, not meaning — ask it for "making
 * models cheaper to run" and it cannot know that is the `efficiency` topic. But we
 * already own a domain taxonomy that does know, so we run the *query* through the
 * same classifier the items went through and retrieve on the resulting topic and
 * entity ids.
 *
 * This is what makes conceptual search work with no neural model and no network:
 * precise (topic ids are exact matches, not fuzzy distances), instant, and
 * explainable — we can tell the user *which* concept matched.
 */
function conceptSearch(query: SearchQuery, limit: number): { hits: { id: string; rank: number }[]; concepts: string[] } {
  const text = query.q
  const topics = classifyTopics({ title: text, content: text }, { limit: 4, includeQuerySynonyms: true })
  const entities = extractEntities(text).map((e) => e.name)
  if (!topics.length && !entities.length) return { hits: [], concepts: [] }

  const where = buildWhere(query)
  const conditions: string[] = []
  const params: unknown[] = []

  if (topics.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM item_topics tp WHERE tp.item_id = i.id AND tp.topic IN (${topics.map(() => '?').join(',')}))`,
    )
    params.push(...topics)
  }
  if (entities.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM item_entities e WHERE e.item_id = i.id AND e.name IN (${entities.map(() => '?').join(',')}))`,
    )
    params.push(...entities)
  }

  // Rank by how many of the query's concepts an item carries, then by signal —
  // an item matching two concepts is a better answer than one matching one.
  const overlapExpr = [
    topics.length
      ? `(SELECT count(*) FROM item_topics tp WHERE tp.item_id = i.id AND tp.topic IN (${topics.map(() => '?').join(',')}))`
      : '0',
    entities.length
      ? `(SELECT count(*) FROM item_entities e WHERE e.item_id = i.id AND e.name IN (${entities.map(() => '?').join(',')}))`
      : '0',
  ].join(' + ')
  const overlapParams = [...(topics.length ? topics : []), ...(entities.length ? entities : [])]

  try {
    const hits = all<{ id: string; overlap: number; score: number }>(
      `SELECT i.id, (${overlapExpr}) AS overlap, i.score
         FROM items i
        ${where.sql ? `${where.sql} AND` : 'WHERE'} (${conditions.join(' OR ')})
        ORDER BY overlap DESC, i.score DESC
        LIMIT ?`,
      ...overlapParams,
      ...where.params,
      ...params,
      limit,
    )
    return {
      hits: hits.map((h, index) => ({ id: h.id, rank: index + 1 })),
      concepts: [...topics, ...entities],
    }
  } catch {
    return { hits: [], concepts: [] }
  }
}

/* ------------------------------------------------------------------ facets -- */

function computeFacets(query: SearchQuery): SearchResponse['facets'] {
  const where = buildWhere(query)
  const sources = all<{ value: string; count: number }>(
    `SELECT i.source AS value, count(*) AS count FROM items i ${where.sql} GROUP BY i.source ORDER BY count DESC LIMIT 12`,
    ...where.params,
  )
  const topics = all<{ value: string; count: number }>(
    `SELECT tp.topic AS value, count(*) AS count
       FROM item_topics tp JOIN items i ON i.id = tp.item_id
       ${where.sql} GROUP BY tp.topic ORDER BY count DESC LIMIT 16`,
    ...where.params,
  )
  const tags = all<{ value: string; count: number }>(
    `SELECT t.tag AS value, count(*) AS count
       FROM item_tags t JOIN items i ON i.id = t.item_id
       ${where.sql} GROUP BY t.tag ORDER BY count DESC LIMIT 16`,
    ...where.params,
  )
  const authors = all<{ value: string; count: number }>(
    `SELECT i.author_handle AS value, count(*) AS count FROM items i
       ${where.sql ? `${where.sql} AND` : 'WHERE'} i.author_handle IS NOT NULL
       GROUP BY i.author_handle ORDER BY count DESC LIMIT 12`,
    ...where.params,
  )
  return { sources, topics, tags, authors }
}

/* ------------------------------------------------------------------ search -- */

export type SearchOptions = { facets?: boolean }

export async function search(input: SearchQuery, options: SearchOptions = {}): Promise<SearchResponse> {
  const started = performance.now()
  const hasQuery = input.q.trim().length > 0
  // Resolve the sort here rather than in the schema: browsing wants the highest
  // signal, searching wants the best answer to what was typed.
  const query: ResolvedQuery = {
    ...input,
    sort: input.sort ?? (hasQuery ? 'relevance' : 'signal'),
  }

  if (!hasQuery) {
    const { rows, total, cursor } = browse(query)
    return {
      items: hydrate(rows),
      total,
      cursor,
      tookMs: Math.round((performance.now() - started) * 100) / 100,
      matchedBy: {},
      concepts: [],
      facets: options.facets ? computeFacets(query) : undefined,
    }
  }

  // Over-fetch so fusion and diversification have material to work with.
  const depth = Math.min(400, Math.max(query.limit * 4, 60))

  const wantKeyword = query.mode === 'keyword' || query.mode === 'hybrid'
  const wantSemantic = query.mode === 'semantic' || query.mode === 'hybrid'

  let keywordHits = wantKeyword ? keywordSearch(query, depth) : []
  const { hits: semanticHits } = wantSemantic ? await semanticSearch(query, depth) : { hits: [] }
  const { hits: conceptHits, concepts } = query.mode === 'keyword' ? { hits: [], concepts: [] } : conceptSearch(query, depth)

  // Relaxation. A multi-term query ANDs its terms, which is right almost always
  // and occasionally yields nothing for a query the user considers reasonable
  // ("vLLM 推理" when no single item mentions both). Rather than show an empty
  // state, retry the keyword pass with OR semantics — a worse match beats no match,
  // and the fusion step will still rank a full match above a partial one.
  if (wantKeyword && !keywordHits.length && !semanticHits.length && !conceptHits.length) {
    keywordHits = keywordSearch(query, depth, { relax: true })
  }

  const matchedBy: Record<string, 'keyword' | 'semantic' | 'both'> = {}
  const keywordIds = new Set(keywordHits.map((h) => h.id))
  const fuzzyIds = new Set([...semanticHits.map((h) => h.id), ...conceptHits.map((h) => h.id)])
  for (const id of keywordIds) matchedBy[id] = fuzzyIds.has(id) ? 'both' : 'keyword'
  for (const id of fuzzyIds) if (!matchedBy[id]) matchedBy[id] = 'semantic'

  const fused = reciprocalRankFusion<{ id: string }>(
    [
      // Keyword is weighted highest: when a user types an exact model name they
      // mean that name, and a conceptual neighbour is a worse answer.
      { items: keywordHits.map((h) => ({ id: h.id })), label: 'keyword', weight: 1.2 },
      // Concept expansion outranks raw vectors because a taxonomy hit is an exact
      // match on a curated id, while a hash-embedding cosine is a lexical proxy.
      { items: conceptHits.map((h) => ({ id: h.id })), label: 'concept', weight: 1 },
      { items: semanticHits.map((h) => ({ id: h.id })), label: 'semantic', weight: 0.85 },
    ],
    (h) => h.id,
  )

  if (!fused.length) {
    return {
      items: [],
      total: 0,
      tookMs: Math.round((performance.now() - started) * 100) / 100,
      matchedBy: {},
      concepts,
      facets: options.facets ? computeFacets(query) : undefined,
    }
  }

  let orderedIds = fused.map((f) => f.id)

  // Diversify before truncating, so MMR can actually swap results in.
  if (query.diversify > 0 && vectorIndexReady()) {
    const index = getVectorIndex()
    const scoreById = new Map(fused.map((f) => [f.id, f.score]))
    orderedIds = maximalMarginalRelevance(
      orderedIds.map((id) => ({ item: id, relevance: scoreById.get(id) ?? 0, vector: index.get(id) })),
      1 - query.diversify,
      Math.min(orderedIds.length, query.limit * 2),
      cosineSimilarity,
    )
  }

  const offset = decodeCursor(query.cursor)
  const page = orderedIds.slice(offset, offset + query.limit)
  const rows = fetchRowsInOrder(page)

  // `relevance` keeps fusion order; any other sort re-sorts the fused set.
  const items = query.sort === 'relevance' ? hydrate(rows) : sortHydrated(hydrate(rows), query.sort)

  return {
    items,
    total: orderedIds.length,
    cursor: offset + query.limit < orderedIds.length ? encodeCursor(offset + query.limit) : undefined,
    tookMs: Math.round((performance.now() - started) * 100) / 100,
    matchedBy,
    concepts,
    facets: options.facets ? computeFacets(query) : undefined,
  }
}

function fetchRowsInOrder(ids: string[]): ItemRow[] {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = all<ItemRow>(`SELECT ${SUMMARY_COLUMNS} FROM items i WHERE i.id IN (${placeholders})`, ...ids)
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is ItemRow => Boolean(r))
}

function sortHydrated(items: ItemSummary[], sort: ResolvedSort): ItemSummary[] {
  const when = (i: ItemSummary) => i.publishedAt ?? i.capturedAt
  const sorted = [...items]
  switch (sort) {
    case 'recent':
      return sorted.sort((a, b) => when(b) - when(a))
    case 'oldest':
      return sorted.sort((a, b) => when(a) - when(b))
    case 'velocity':
      return sorted.sort((a, b) => (b.scoreBreakdown?.velocity ?? 0) - (a.scoreBreakdown?.velocity ?? 0))
    case 'signal':
      return sorted.sort((a, b) => b.score - a.score || when(b) - when(a))
    default:
      return sorted
  }
}

/**
 * "More like this" — pure vector neighbours of one item, excluding itself and
 * anything already known to be a duplicate of it.
 */
export function similarItems(itemId: string, limit = 8): ItemSummary[] {
  if (!vectorIndexReady()) return []
  const index = getVectorIndex()
  const vector = index.get(itemId)
  if (!vector) return []
  const hits = index.search(vector, limit + 6, null, 0.2).filter((h) => h.id !== itemId)
  if (!hits.length) return []
  const rows = fetchRowsInOrder(hits.slice(0, limit).map((h) => h.id))
  return hydrate(rows)
}

/** Distinct values for the filter UI. */
export function listFacetValues(): {
  tags: { value: string; count: number }[]
  topics: { value: string; count: number }[]
  authors: { value: string; name: string; count: number }[]
  sources: { value: string; count: number }[]
} {
  return {
    tags: all('SELECT tag AS value, count(*) AS count FROM item_tags GROUP BY tag ORDER BY count DESC LIMIT 100'),
    topics: all('SELECT topic AS value, count(*) AS count FROM item_topics GROUP BY topic ORDER BY count DESC LIMIT 60'),
    authors: all(
      `SELECT author_handle AS value, COALESCE(MAX(author_name), author_handle) AS name, count(*) AS count
         FROM items WHERE author_handle IS NOT NULL
        GROUP BY author_handle ORDER BY count DESC LIMIT 80`,
    ),
    sources: all('SELECT source AS value, count(*) AS count FROM items GROUP BY source ORDER BY count DESC'),
  }
}
