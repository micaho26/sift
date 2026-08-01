/**
 * Item persistence.
 *
 * This module owns three invariants that everything else depends on:
 *
 *  1. `url_hash` is unique. Re-ingesting the same URL updates metrics in place
 *     rather than creating a second row.
 *  2. FTS, LSH bands, tags, topics, entities and the vector index are always in
 *     step with `items`. Every write path goes through `writeDerived`.
 *  3. Nothing is ever silently lost. A near-duplicate is linked to its canonical
 *     item via `duplicate_of` and still fully searchable — it is hidden from the
 *     feed, not deleted, because "we hid a story you wanted" is unrecoverable
 *     while "we showed one extra" is merely noise.
 */
import { createHash } from 'node:crypto'
import {
  DUPLICATE_THRESHOLD,
  Item,
  cjkBigrams,
  hammingDistance,
  simhashBands,
  type Author,
  type Entity,
  type ItemState,
  type ItemSummary,
  type Media,
  type Metrics,
  type ScoreBreakdown,
  type SourceKind,
} from '@sift/core'
import { all, get, newId, parseJson, run, transaction } from '../db/index.ts'
import { getVectorIndex, vectorIndexReady } from '../db/vector.ts'

export type ItemRow = {
  id: string
  url: string
  url_hash: string
  source: string
  source_id: string | null
  kind: string
  title: string
  summary: string | null
  content: string | null
  lang: string | null
  author_json: string | null
  author_handle: string | null
  author_name: string | null
  metrics_json: string | null
  media_json: string | null
  published_at: number | null
  captured_at: number
  updated_at: number
  score: number
  score_json: string | null
  state: string
  starred: number
  read_at: number | null
  reading_time: number
  simhash: string | null
  duplicate_of: string | null
  echo_count: number
  ai_summary: string | null
  ai_translation: string | null
  ai_takeaways: string | null
  embed_model: string | null
  raw_json?: string | null
}

/** Columns for list views — deliberately excludes `content` and `raw_json`. */
export const SUMMARY_COLUMNS = `
  id, url, url_hash, source, source_id, kind, title, summary, lang,
  author_json, author_handle, author_name, metrics_json, media_json,
  published_at, captured_at, updated_at, score, score_json,
  state, starred, read_at, reading_time, simhash, duplicate_of, echo_count,
  ai_summary, ai_translation, ai_takeaways, embed_model
`

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/* --------------------------------------------------------------- mapping -- */

function rowToSummary(row: ItemRow, tags: string[] = [], topics: string[] = [], entities: Entity[] = []): ItemSummary {
  return {
    id: row.id,
    url: row.url,
    urlHash: row.url_hash,
    source: row.source as SourceKind,
    sourceId: row.source_id ?? undefined,
    kind: row.kind as ItemSummary['kind'],
    title: row.title,
    summary: row.summary ?? undefined,
    lang: row.lang ?? undefined,
    author: parseJson<Author | undefined>(row.author_json, undefined),
    metrics: parseJson<Metrics>(row.metrics_json, {}),
    media: parseJson<Media[]>(row.media_json, []),
    topics,
    tags,
    entities,
    publishedAt: row.published_at ?? undefined,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
    score: row.score,
    scoreBreakdown: parseJson<ScoreBreakdown | undefined>(row.score_json, undefined),
    state: row.state as ItemState,
    starred: row.starred === 1,
    readAt: row.read_at ?? undefined,
    readingTimeSec: row.reading_time,
    simhash: row.simhash ?? undefined,
    duplicateOf: row.duplicate_of ?? undefined,
    echoCount: row.echo_count,
    aiSummary: row.ai_summary ?? undefined,
    aiTranslation: row.ai_translation ?? undefined,
    aiTakeaways: parseJson<string[] | undefined>(row.ai_takeaways, undefined),
  }
}

/**
 * Hydrate rows with their tags/topics/entities in three batched queries instead
 * of 3N — the difference between a 12ms and a 400ms feed request.
 */
export function hydrate(rows: ItemRow[]): ItemSummary[] {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')

  const tagsByItem = new Map<string, string[]>()
  for (const row of all<{ item_id: string; tag: string }>(
    `SELECT item_id, tag FROM item_tags WHERE item_id IN (${placeholders}) ORDER BY tag`,
    ...ids,
  )) {
    const list = tagsByItem.get(row.item_id)
    if (list) list.push(row.tag)
    else tagsByItem.set(row.item_id, [row.tag])
  }

  const topicsByItem = new Map<string, string[]>()
  for (const row of all<{ item_id: string; topic: string }>(
    `SELECT item_id, topic FROM item_topics WHERE item_id IN (${placeholders})`,
    ...ids,
  )) {
    const list = topicsByItem.get(row.item_id)
    if (list) list.push(row.topic)
    else topicsByItem.set(row.item_id, [row.topic])
  }

  const entitiesByItem = new Map<string, Entity[]>()
  for (const row of all<{ item_id: string; name: string; type: string; confidence: number }>(
    `SELECT item_id, name, type, confidence FROM item_entities WHERE item_id IN (${placeholders}) ORDER BY confidence DESC`,
    ...ids,
  )) {
    const entity: Entity = { name: row.name, type: row.type as Entity['type'], confidence: row.confidence }
    const list = entitiesByItem.get(row.item_id)
    if (list) list.push(entity)
    else entitiesByItem.set(row.item_id, [entity])
  }

  return rows.map((row) =>
    rowToSummary(row, tagsByItem.get(row.id) ?? [], topicsByItem.get(row.id) ?? [], entitiesByItem.get(row.id) ?? []),
  )
}

export function findById(id: string): Item | null {
  const row = get<ItemRow>('SELECT * FROM items WHERE id = ?', id)
  if (!row) return null
  const [summary] = hydrate([row])
  if (!summary) return null
  return { ...summary, content: row.content ?? undefined } as Item
}

export function findManyByIds(ids: string[]): ItemSummary[] {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = all<ItemRow>(`SELECT ${SUMMARY_COLUMNS} FROM items WHERE id IN (${placeholders})`, ...ids)
  const hydrated = hydrate(rows)
  // Preserve the caller's ordering — search results arrive already ranked.
  const byId = new Map(hydrated.map((i) => [i.id, i]))
  return ids.map((id) => byId.get(id)).filter((i): i is ItemSummary => Boolean(i))
}

export function findByUrlHash(urlHash: string): ItemRow | undefined {
  return get<ItemRow>('SELECT * FROM items WHERE url_hash = ?', urlHash)
}

/* -------------------------------------------------------- near-duplicates -- */

/**
 * Find an existing item whose SimHash is within `threshold` bits.
 *
 * The band index narrows the search to items sharing at least one 16-bit band;
 * by the pigeonhole principle every true near-duplicate is in that set, so
 * recall is complete while the scan stays tiny.
 */
export function findNearDuplicate(simhash: string, threshold = DUPLICATE_THRESHOLD): { id: string; distance: number } | null {
  const bands = simhashBands(simhash)
  if (!bands.length) return null
  const placeholders = bands.map(() => '?').join(',')
  const candidates = all<{ item_id: string; simhash: string | null }>(
    `SELECT DISTINCT b.item_id, i.simhash
       FROM item_bands b
       JOIN items i ON i.id = b.item_id
      WHERE b.band IN (${placeholders})
        AND i.duplicate_of IS NULL
      LIMIT 400`,
    ...bands,
  )
  let best: { id: string; distance: number } | null = null
  for (const candidate of candidates) {
    if (!candidate.simhash) continue
    const distance = hammingDistance(simhash, candidate.simhash)
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { id: candidate.item_id, distance }
    }
  }
  return best
}

/**
 * Candidates for "same story, different words" clustering.
 *
 * Narrowed by two cheap, strong guards before any vector maths runs:
 *  - a shared *specific* entity (a model, company, product, paper or benchmark —
 *    not a vague concept), because two items about one launch always name it;
 *  - publication within `windowHours`, because news about the same event arrives
 *    together and a six-month-old post about GPT-5 is not an echo of today's.
 *
 * Without these guards, a similarity threshold alone folds together any two items
 * that merely share a topic, which loses real content.
 */
export function echoCandidates(
  entities: Entity[],
  publishedAt: number | undefined,
  windowHours = 72,
  excludeId?: string,
): string[] {
  const specific = entities
    .filter((e) => e.type === 'model' || e.type === 'company' || e.type === 'product' || e.type === 'paper' || e.type === 'benchmark')
    .map((e) => e.name)
  if (!specific.length) return []

  const center = publishedAt ?? Date.now()
  const span = windowHours * 3_600_000
  const placeholders = specific.map(() => '?').join(',')

  return all<{ id: string }>(
    `SELECT DISTINCT i.id
       FROM item_entities e
       JOIN items i ON i.id = e.item_id
      WHERE e.name IN (${placeholders})
        AND i.duplicate_of IS NULL
        AND i.embedding IS NOT NULL
        AND ABS(COALESCE(i.published_at, i.captured_at) - ?) <= ?
        ${excludeId ? 'AND i.id != ?' : ''}
      LIMIT 200`,
    ...specific,
    center,
    span,
    ...(excludeId ? [excludeId] : []),
  ).map((row) => row.id)
}

/* ------------------------------------------------------------ derived rows -- */

type DerivedInput = {
  id: string
  title: string
  summary?: string
  content?: string
  authorName?: string
  authorHandle?: string
  tags: string[]
  topics: string[]
  entities: Entity[]
  simhash?: string
}

/**
 * Rewrite every derived table for one item. Called on insert and on any update
 * that touches text, tags or topics — keeping this in one place is what stops
 * FTS drifting out of sync with `items`.
 */
function writeDerived(input: DerivedInput): void {
  const { id } = input

  run('DELETE FROM item_tags WHERE item_id = ?', id)
  for (const tag of new Set(input.tags.map((t) => t.trim()).filter(Boolean))) {
    run('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)', id, tag)
  }

  run('DELETE FROM item_topics WHERE item_id = ?', id)
  for (const topic of new Set(input.topics.filter(Boolean))) {
    run('INSERT OR IGNORE INTO item_topics (item_id, topic) VALUES (?, ?)', id, topic)
  }

  run('DELETE FROM item_entities WHERE item_id = ?', id)
  for (const entity of input.entities) {
    run(
      'INSERT OR IGNORE INTO item_entities (item_id, name, type, confidence) VALUES (?, ?, ?, ?)',
      id,
      entity.name,
      entity.type,
      entity.confidence ?? 1,
    )
  }

  run('DELETE FROM item_bands WHERE item_id = ?', id)
  if (input.simhash) {
    for (const band of simhashBands(input.simhash)) {
      run('INSERT OR IGNORE INTO item_bands (band, item_id) VALUES (?, ?)', band, id)
    }
  }

  // --- FTS ---------------------------------------------------------------- //
  const body = [input.summary ?? '', input.content ?? ''].filter(Boolean).join('\n')
  const author = [input.authorName ?? '', input.authorHandle ?? ''].filter(Boolean).join(' ')
  const tagText = [...input.tags, ...input.topics].join(' ')
  // Bigrams of everything Chinese, so `unicode61` cannot swallow CJK queries.
  const cjk = cjkBigrams(`${input.title}\n${body}\n${tagText}`)

  const existing = get<{ rowid: number }>('SELECT rowid FROM fts_map WHERE item_id = ?', id)
  if (existing) {
    run('DELETE FROM items_fts WHERE rowid = ?', existing.rowid)
    run('INSERT INTO items_fts (rowid, title, body, author, tags, cjk) VALUES (?, ?, ?, ?, ?, ?)', existing.rowid, input.title, body, author, tagText, cjk)
  } else {
    const inserted = run('INSERT INTO items_fts (title, body, author, tags, cjk) VALUES (?, ?, ?, ?, ?)', input.title, body, author, tagText, cjk)
    run('INSERT OR REPLACE INTO fts_map (rowid, item_id) VALUES (?, ?)', inserted.lastInsertRowid, id)
  }
}

/* ------------------------------------------------------------------ upsert -- */

export type UpsertInput = {
  url: string
  urlHash: string
  source: SourceKind
  sourceId?: string
  kind: string
  title: string
  summary?: string
  content?: string
  lang?: string
  author?: Author
  metrics?: Metrics
  media?: Media[]
  topics: string[]
  tags: string[]
  entities: Entity[]
  publishedAt?: number
  score: number
  scoreBreakdown?: ScoreBreakdown
  state: ItemState
  readingTimeSec: number
  simhash?: string
  duplicateOf?: string
  raw?: unknown
}

export type UpsertOutcome = {
  id: string
  created: boolean
  duplicate: boolean
}

/**
 * Insert a new item, or update an existing one identified by `urlHash`.
 *
 * On update we refresh volatile fields (metrics, score, title) but never clobber
 * user state — `state`, `starred`, tags added by hand and highlights all survive
 * a re-crawl. That asymmetry is the whole reason this is not a plain REPLACE.
 */
export function upsertItem(input: UpsertInput): UpsertOutcome {
  return transaction(() => {
    const now = Date.now()
    const existing = findByUrlHash(input.urlHash)

    if (existing) {
      const userTags = all<{ tag: string }>('SELECT tag FROM item_tags WHERE item_id = ?', existing.id).map((r) => r.tag)
      const mergedTags = [...new Set([...userTags, ...input.tags])]

      run(
        `UPDATE items SET
            title = ?, summary = COALESCE(?, summary), content = COALESCE(?, content),
            lang = COALESCE(?, lang),
            author_json = COALESCE(?, author_json),
            author_handle = COALESCE(?, author_handle),
            author_name = COALESCE(?, author_name),
            metrics_json = COALESCE(?, metrics_json),
            media_json = COALESCE(?, media_json),
            published_at = COALESCE(?, published_at),
            updated_at = ?, score = ?, score_json = ?,
            reading_time = MAX(reading_time, ?),
            simhash = COALESCE(?, simhash),
            source_id = COALESCE(?, source_id)
          WHERE id = ?`,
        input.title || existing.title,
        input.summary ?? null,
        input.content ?? null,
        input.lang ?? null,
        input.author ? JSON.stringify(input.author) : null,
        input.author?.handle ?? null,
        input.author?.name ?? null,
        input.metrics ? JSON.stringify(input.metrics) : null,
        input.media?.length ? JSON.stringify(input.media) : null,
        input.publishedAt ?? null,
        now,
        input.score,
        input.scoreBreakdown ? JSON.stringify(input.scoreBreakdown) : null,
        input.readingTimeSec,
        input.simhash ?? null,
        input.sourceId ?? null,
        existing.id,
      )

      writeDerived({
        id: existing.id,
        title: input.title || existing.title,
        summary: input.summary ?? existing.summary ?? undefined,
        content: input.content ?? existing.content ?? undefined,
        authorName: input.author?.name ?? existing.author_name ?? undefined,
        authorHandle: input.author?.handle ?? existing.author_handle ?? undefined,
        tags: mergedTags,
        topics: input.topics,
        entities: input.entities,
        simhash: input.simhash ?? existing.simhash ?? undefined,
      })

      return { id: existing.id, created: false, duplicate: false }
    }

    const id = newId('i_')
    run(
      `INSERT INTO items (
        id, url, url_hash, source, source_id, kind, title, summary, content, lang,
        author_json, author_handle, author_name, metrics_json, media_json,
        published_at, captured_at, updated_at, score, score_json,
        state, starred, reading_time, simhash, duplicate_of, echo_count, raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.url,
      input.urlHash,
      input.source,
      input.sourceId ?? null,
      input.kind,
      input.title,
      input.summary ?? null,
      input.content ?? null,
      input.lang ?? null,
      input.author ? JSON.stringify(input.author) : null,
      input.author?.handle ?? null,
      input.author?.name ?? null,
      input.metrics ? JSON.stringify(input.metrics) : null,
      input.media?.length ? JSON.stringify(input.media) : null,
      input.publishedAt ?? null,
      now,
      now,
      input.score,
      input.scoreBreakdown ? JSON.stringify(input.scoreBreakdown) : null,
      input.state,
      0,
      input.readingTimeSec,
      input.simhash ?? null,
      input.duplicateOf ?? null,
      0,
      input.raw === undefined ? null : JSON.stringify(input.raw),
    )

    writeDerived({
      id,
      title: input.title,
      summary: input.summary,
      content: input.content,
      authorName: input.author?.name,
      authorHandle: input.author?.handle,
      tags: input.tags,
      topics: input.topics,
      entities: input.entities,
      simhash: input.simhash,
    })

    if (input.duplicateOf) {
      run('UPDATE items SET echo_count = echo_count + 1, updated_at = ? WHERE id = ?', now, input.duplicateOf)
    }

    return { id, created: true, duplicate: Boolean(input.duplicateOf) }
  })
}

/* ------------------------------------------------------------ mutations -- */

export function setState(ids: string[], state: ItemState): number {
  if (!ids.length) return 0
  return transaction(() => {
    const placeholders = ids.map(() => '?').join(',')
    // Record revealed preference before the state changes, for the authority term.
    if (state === 'saved' || state === 'shortlist') {
      run(
        `UPDATE author_stats SET saved = saved + 1, updated_at = ?
          WHERE handle IN (SELECT author_handle FROM items WHERE id IN (${placeholders}) AND author_handle IS NOT NULL)`,
        Date.now(),
        ...ids,
      )
    } else if (state === 'archived' || state === 'trash') {
      run(
        `UPDATE author_stats SET dismissed = dismissed + 1, updated_at = ?
          WHERE handle IN (SELECT author_handle FROM items WHERE id IN (${placeholders}) AND author_handle IS NOT NULL)`,
        Date.now(),
        ...ids,
      )
    }
    const result = run(
      `UPDATE items SET state = ?, updated_at = ? WHERE id IN (${placeholders})`,
      state,
      Date.now(),
      ...ids,
    )
    for (const id of ids) logEvent(state === 'saved' ? 'item.save' : `item.${state}`, id)
    return result.changes
  })
}

export function setStarred(ids: string[], starred: boolean): number {
  if (!ids.length) return 0
  const placeholders = ids.map(() => '?').join(',')
  const result = run(
    `UPDATE items SET starred = ?, updated_at = ? WHERE id IN (${placeholders})`,
    starred ? 1 : 0,
    Date.now(),
    ...ids,
  )
  return result.changes
}

export function markRead(ids: string[], read: boolean, dwellSec = 0): number {
  if (!ids.length) return 0
  const placeholders = ids.map(() => '?').join(',')
  const result = run(
    `UPDATE items SET read_at = ?, updated_at = ? WHERE id IN (${placeholders})`,
    read ? Date.now() : null,
    Date.now(),
    ...ids,
  )
  if (read) for (const id of ids) logEvent('item.read', id, { dwellSec })
  return result.changes
}

export function setTags(id: string, tags: string[]): string[] {
  return transaction(() => {
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 64)
    const row = get<ItemRow>('SELECT * FROM items WHERE id = ?', id)
    if (!row) return []
    const topics = all<{ topic: string }>('SELECT topic FROM item_topics WHERE item_id = ?', id).map((r) => r.topic)
    const entities = all<{ name: string; type: string; confidence: number }>(
      'SELECT name, type, confidence FROM item_entities WHERE item_id = ?',
      id,
    ).map((e) => ({ name: e.name, type: e.type as Entity['type'], confidence: e.confidence }))

    writeDerived({
      id,
      title: row.title,
      summary: row.summary ?? undefined,
      content: row.content ?? undefined,
      authorName: row.author_name ?? undefined,
      authorHandle: row.author_handle ?? undefined,
      tags: clean,
      topics,
      entities,
      simhash: row.simhash ?? undefined,
    })
    run('UPDATE items SET updated_at = ? WHERE id = ?', Date.now(), id)
    return clean
  })
}

export function setAiFields(
  id: string,
  fields: { summary?: string; translation?: string; takeaways?: string[] },
): void {
  run(
    `UPDATE items SET
       ai_summary = COALESCE(?, ai_summary),
       ai_translation = COALESCE(?, ai_translation),
       ai_takeaways = COALESCE(?, ai_takeaways),
       updated_at = ?
     WHERE id = ?`,
    fields.summary ?? null,
    fields.translation ?? null,
    fields.takeaways ? JSON.stringify(fields.takeaways) : null,
    Date.now(),
    id,
  )
}

export function updateScore(id: string, score: number, breakdown: ScoreBreakdown): void {
  run('UPDATE items SET score = ?, score_json = ?, updated_at = ? WHERE id = ?', score, JSON.stringify(breakdown), Date.now(), id)
}

export function deleteItems(ids: string[]): number {
  if (!ids.length) return 0
  return transaction(() => {
    const placeholders = ids.map(() => '?').join(',')
    // FTS has no foreign keys, so its rows must be removed explicitly.
    const rowids = all<{ rowid: number }>(
      `SELECT rowid FROM fts_map WHERE item_id IN (${placeholders})`,
      ...ids,
    ).map((r) => r.rowid)
    for (const rowid of rowids) run('DELETE FROM items_fts WHERE rowid = ?', rowid)
    run(`DELETE FROM fts_map WHERE item_id IN (${placeholders})`, ...ids)
    const result = run(`DELETE FROM items WHERE id IN (${placeholders})`, ...ids)
    if (vectorIndexReady()) for (const id of ids) getVectorIndex().delete(id)
    return result.changes
  })
}

/** Permanently remove trashed items older than `days`. */
export function emptyTrash(days = 30): number {
  const cutoff = Date.now() - days * 86_400_000
  const ids = all<{ id: string }>("SELECT id FROM items WHERE state = 'trash' AND updated_at < ?", cutoff).map((r) => r.id)
  return deleteItems(ids)
}

/* -------------------------------------------------------------- author stats -- */

export function touchAuthor(handle: string | undefined, name: string | undefined, source: string, followers?: number): void {
  if (!handle) return
  run(
    `INSERT INTO author_stats (handle, name, source, seen, saved, dismissed, followers, updated_at)
     VALUES (?, ?, ?, 1, 0, 0, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       seen = seen + 1,
       name = COALESCE(excluded.name, author_stats.name),
       followers = COALESCE(excluded.followers, author_stats.followers),
       updated_at = excluded.updated_at`,
    handle,
    name ?? null,
    source,
    followers ?? null,
    Date.now(),
  )
}

export function authorStats(handle: string | undefined): { seen: number; saved: number; followers?: number } {
  if (!handle) return { seen: 0, saved: 0 }
  const row = get<{ seen: number; saved: number; followers: number | null }>(
    'SELECT seen, saved, followers FROM author_stats WHERE handle = ?',
    handle,
  )
  return { seen: row?.seen ?? 0, saved: row?.saved ?? 0, followers: row?.followers ?? undefined }
}

/* --------------------------------------------------------------- activity -- */

export function logEvent(type: string, itemId?: string, meta?: unknown): void {
  run(
    'INSERT INTO events (ts, type, item_id, meta) VALUES (?, ?, ?, ?)',
    Date.now(),
    type,
    itemId ?? null,
    meta === undefined ? null : JSON.stringify(meta),
  )
}

export function countItems(state?: ItemState): number {
  if (state) {
    return (
      get<{ n: number }>('SELECT count(*) AS n FROM items WHERE state = ? AND duplicate_of IS NULL', state)?.n ?? 0
    )
  }
  return get<{ n: number }>('SELECT count(*) AS n FROM items')?.n ?? 0
}

/** Sidebar badge counts, in a single scan. */
export function stateCounts(): Record<string, number> {
  const rows = all<{ state: string; n: number }>(
    'SELECT state, count(*) AS n FROM items WHERE duplicate_of IS NULL GROUP BY state',
  )
  const counts: Record<string, number> = { inbox: 0, shortlist: 0, saved: 0, archived: 0, trash: 0 }
  for (const row of rows) counts[row.state] = row.n
  counts.unread =
    get<{ n: number }>(
      "SELECT count(*) AS n FROM items WHERE read_at IS NULL AND state IN ('inbox','shortlist') AND duplicate_of IS NULL",
    )?.n ?? 0
  counts.starred = get<{ n: number }>('SELECT count(*) AS n FROM items WHERE starred = 1')?.n ?? 0
  counts.today =
    get<{ n: number }>(
      'SELECT count(*) AS n FROM items WHERE duplicate_of IS NULL AND COALESCE(published_at, captured_at) > ?',
      Date.now() - 86_400_000,
    )?.n ?? 0
  return counts
}

/** Items needing an embedding — drives the background backfill job. */
export function itemsMissingEmbedding(model: string, limit = 200): { id: string; title: string; summary: string | null; content: string | null }[] {
  return all(
    `SELECT id, title, summary, substr(content, 1, 4000) AS content
       FROM items
      WHERE (embedding IS NULL OR embed_model IS NOT ?)
      ORDER BY score DESC
      LIMIT ?`,
    model,
    limit,
  )
}
