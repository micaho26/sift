/**
 * The user's own organisation layer: collections, highlights and saved searches.
 *
 * Distinct from `items` in one important way — everything here is created by hand
 * and is therefore irreplaceable. Items can be re-crawled; a highlight cannot.
 * Nothing in this file deletes user content as a side effect of anything else.
 */
import { Collection, Highlight, SavedSearch, SearchQuery, type ItemSummary } from '@sift/core'
import { all, get, newId, parseJson, run, transaction } from '../db/index.ts'
import { hydrate, SUMMARY_COLUMNS, type ItemRow } from './items.ts'

/* ------------------------------------------------------------ collections -- */

type CollectionRow = {
  id: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  smart_query: string | null
  created_at: number
  updated_at: number
  position: number
}

function toCollection(row: CollectionRow, itemCount: number): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    smartQuery: row.smart_query ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount,
  }
}

export function listCollections(): Collection[] {
  const rows = all<CollectionRow>('SELECT * FROM collections ORDER BY position, created_at')
  const counts = new Map(
    all<{ collection_id: string; n: number }>(
      'SELECT collection_id, count(*) AS n FROM collection_items GROUP BY collection_id',
    ).map((r) => [r.collection_id, r.n]),
  )
  return rows.map((row) => toCollection(row, counts.get(row.id) ?? 0))
}

export function getCollection(id: string): Collection | null {
  const row = get<CollectionRow>('SELECT * FROM collections WHERE id = ?', id)
  if (!row) return null
  const count = get<{ n: number }>('SELECT count(*) AS n FROM collection_items WHERE collection_id = ?', id)?.n ?? 0
  return toCollection(row, count)
}

export function createCollection(input: {
  name: string
  description?: string
  icon?: string
  color?: string
  smartQuery?: string
}): Collection {
  const id = newId('c_')
  const now = Date.now()
  const position = get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM collections')?.n ?? 1
  run(
    `INSERT INTO collections (id, name, description, icon, color, smart_query, created_at, updated_at, position)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.name.trim().slice(0, 120) || 'Untitled',
    input.description ?? null,
    input.icon ?? null,
    input.color ?? null,
    input.smartQuery ?? null,
    now,
    now,
    position,
  )
  return getCollection(id)!
}

export function updateCollection(id: string, patch: Partial<Collection>): Collection | null {
  const existing = getCollection(id)
  if (!existing) return null
  run(
    `UPDATE collections SET name = ?, description = ?, icon = ?, color = ?, smart_query = ?, updated_at = ? WHERE id = ?`,
    patch.name?.trim() || existing.name,
    patch.description ?? existing.description ?? null,
    patch.icon ?? existing.icon ?? null,
    patch.color ?? existing.color ?? null,
    patch.smartQuery ?? existing.smartQuery ?? null,
    Date.now(),
    id,
  )
  return getCollection(id)
}

/** Deletes the collection, never its items. */
export function deleteCollection(id: string): boolean {
  return run('DELETE FROM collections WHERE id = ?', id).changes > 0
}

export function addToCollection(collectionId: string, itemIds: string[], note?: string): number {
  if (!itemIds.length) return 0
  return transaction(() => {
    const now = Date.now()
    const base = get<{ n: number }>(
      'SELECT COALESCE(MAX(position), 0) AS n FROM collection_items WHERE collection_id = ?',
      collectionId,
    )?.n ?? 0
    let added = 0
    for (const [index, itemId] of itemIds.entries()) {
      const result = run(
        `INSERT INTO collection_items (collection_id, item_id, added_at, note, position)
         VALUES (?,?,?,?,?)
         ON CONFLICT(collection_id, item_id) DO UPDATE SET note = COALESCE(excluded.note, collection_items.note)`,
        collectionId,
        itemId,
        now,
        note ?? null,
        base + index + 1,
      )
      added += result.changes
    }
    run('UPDATE collections SET updated_at = ? WHERE id = ?', now, collectionId)
    return added
  })
}

export function removeFromCollection(collectionId: string, itemIds: string[]): number {
  if (!itemIds.length) return 0
  const placeholders = itemIds.map(() => '?').join(',')
  return run(
    `DELETE FROM collection_items WHERE collection_id = ? AND item_id IN (${placeholders})`,
    collectionId,
    ...itemIds,
  ).changes
}

/** Items in a collection, in the user's manual order. */
export function collectionItems(collectionId: string, limit = 200): ItemSummary[] {
  const rows = all<ItemRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM items i
       JOIN collection_items ci ON ci.item_id = i.id
      WHERE ci.collection_id = ?
      ORDER BY ci.position, ci.added_at DESC
      LIMIT ?`,
    collectionId,
    limit,
  )
  return hydrate(rows)
}

/** Which collections contain this item — drives the reader's collection chips. */
export function collectionsForItem(itemId: string): { id: string; name: string; icon?: string }[] {
  return all<{ id: string; name: string; icon: string | null }>(
    `SELECT c.id, c.name, c.icon FROM collections c
       JOIN collection_items ci ON ci.collection_id = c.id
      WHERE ci.item_id = ? ORDER BY c.position`,
    itemId,
  ).map((row) => ({ id: row.id, name: row.name, icon: row.icon ?? undefined }))
}

/* ------------------------------------------------------------- highlights -- */

type HighlightRow = {
  id: string
  item_id: string
  text: string
  note: string | null
  color: string
  start_offset: number | null
  end_offset: number | null
  created_at: number
}

function toHighlight(row: HighlightRow): Highlight {
  return {
    id: row.id,
    itemId: row.item_id,
    text: row.text,
    note: row.note ?? undefined,
    color: row.color as Highlight['color'],
    startOffset: row.start_offset ?? undefined,
    endOffset: row.end_offset ?? undefined,
    createdAt: row.created_at,
  }
}

export function listHighlights(itemId?: string, limit = 500): Highlight[] {
  const rows = itemId
    ? all<HighlightRow>('SELECT * FROM highlights WHERE item_id = ? ORDER BY created_at LIMIT ?', itemId, limit)
    : all<HighlightRow>('SELECT * FROM highlights ORDER BY created_at DESC LIMIT ?', limit)
  return rows.map(toHighlight)
}

export function createHighlight(input: {
  itemId: string
  text: string
  note?: string
  color?: Highlight['color']
  startOffset?: number
  endOffset?: number
}): Highlight {
  const id = newId('h_')
  run(
    `INSERT INTO highlights (id, item_id, text, note, color, start_offset, end_offset, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.itemId,
    input.text.slice(0, 10_000),
    input.note ?? null,
    input.color ?? 'yellow',
    input.startOffset ?? null,
    input.endOffset ?? null,
    Date.now(),
  )
  return toHighlight(get<HighlightRow>('SELECT * FROM highlights WHERE id = ?', id)!)
}

export function updateHighlight(id: string, patch: { note?: string; color?: Highlight['color'] }): Highlight | null {
  const row = get<HighlightRow>('SELECT * FROM highlights WHERE id = ?', id)
  if (!row) return null
  run(
    'UPDATE highlights SET note = ?, color = ? WHERE id = ?',
    patch.note ?? row.note,
    patch.color ?? row.color,
    id,
  )
  return toHighlight(get<HighlightRow>('SELECT * FROM highlights WHERE id = ?', id)!)
}

export function deleteHighlight(id: string): boolean {
  return run('DELETE FROM highlights WHERE id = ?', id).changes > 0
}

/* ---------------------------------------------------------- saved searches -- */

type SavedSearchRow = {
  id: string
  name: string
  query_json: string
  icon: string | null
  pinned: number
  alerting: number
  last_seen_at: number | null
  created_at: number
  position: number
}

function toSavedSearch(row: SavedSearchRow, newCount: number): SavedSearch {
  const parsedQuery = SearchQuery.safeParse(parseJson(row.query_json, {}))
  return {
    id: row.id,
    name: row.name,
    query: parsedQuery.success ? parsedQuery.data : SearchQuery.parse({}),
    icon: row.icon ?? undefined,
    pinned: row.pinned === 1,
    alerting: row.alerting === 1,
    lastSeenAt: row.last_seen_at ?? undefined,
    newCount,
    createdAt: row.created_at,
  }
}

export function listSavedSearches(): SavedSearch[] {
  const rows = all<SavedSearchRow>('SELECT * FROM saved_searches ORDER BY position, created_at')
  return rows.map((row) => {
    const newCount = row.alerting === 1 ? countNewMatches(row) : 0
    return toSavedSearch(row, newCount)
  })
}

/**
 * How many items matching this view have arrived since it was last opened.
 *
 * Applies the view's own structural filters rather than counting everything new —
 * a badge that says "288" when the view holds three matching items is worse than
 * no badge, because the user learns to ignore it. The text query is deliberately
 * *not* applied: running FTS for every sidebar row on every render is not worth
 * it, and the structural filters carry almost all of the selectivity in practice.
 */
function countNewMatches(row: SavedSearchRow): number {
  const parsed = SearchQuery.safeParse(parseJson(row.query_json, {}))
  if (!parsed.success) return 0
  const query = parsed.data
  const since = row.last_seen_at ?? row.created_at

  const clauses = ["duplicate_of IS NULL", "state != 'trash'", 'captured_at > ?']
  const params: unknown[] = [since]

  if (query.states?.length) {
    clauses.push(`state IN (${query.states.map(() => '?').join(',')})`)
    params.push(...query.states)
  }
  if (query.sources?.length) {
    clauses.push(`source IN (${query.sources.map(() => '?').join(',')})`)
    params.push(...query.sources)
  }
  if (query.kinds?.length) {
    clauses.push(`kind IN (${query.kinds.map(() => '?').join(',')})`)
    params.push(...query.kinds)
  }
  if (typeof query.minScore === 'number') {
    clauses.push('score >= ?')
    params.push(query.minScore)
  }
  if (query.starred) clauses.push('starred = 1')
  if (query.unreadOnly) clauses.push('read_at IS NULL')
  if (query.lang) {
    clauses.push('lang = ?')
    params.push(query.lang)
  }
  for (const topic of query.topics ?? []) {
    clauses.push('EXISTS (SELECT 1 FROM item_topics tp WHERE tp.item_id = items.id AND tp.topic = ?)')
    params.push(topic)
  }
  for (const tag of query.tags ?? []) {
    clauses.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id AND t.tag = ?)')
    params.push(tag)
  }

  return get<{ n: number }>(`SELECT count(*) AS n FROM items WHERE ${clauses.join(' AND ')}`, ...params)?.n ?? 0
}

export function createSavedSearch(input: {
  name: string
  query: unknown
  icon?: string
  pinned?: boolean
  alerting?: boolean
}): SavedSearch {
  const id = newId('q_')
  const position = get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM saved_searches')?.n ?? 1
  const query = SearchQuery.parse(input.query ?? {})
  run(
    `INSERT INTO saved_searches (id, name, query_json, icon, pinned, alerting, last_seen_at, created_at, position)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.name.trim().slice(0, 120) || 'Untitled view',
    JSON.stringify(query),
    input.icon ?? null,
    input.pinned ? 1 : 0,
    input.alerting ? 1 : 0,
    Date.now(),
    Date.now(),
    position,
  )
  const row = get<SavedSearchRow>('SELECT * FROM saved_searches WHERE id = ?', id)!
  return toSavedSearch(row, 0)
}

export function updateSavedSearch(id: string, patch: Partial<SavedSearch>): SavedSearch | null {
  const row = get<SavedSearchRow>('SELECT * FROM saved_searches WHERE id = ?', id)
  if (!row) return null
  run(
    `UPDATE saved_searches SET name = ?, query_json = ?, icon = ?, pinned = ?, alerting = ?, last_seen_at = ? WHERE id = ?`,
    patch.name ?? row.name,
    patch.query ? JSON.stringify(SearchQuery.parse(patch.query)) : row.query_json,
    patch.icon ?? row.icon,
    (patch.pinned ?? row.pinned === 1) ? 1 : 0,
    (patch.alerting ?? row.alerting === 1) ? 1 : 0,
    patch.lastSeenAt ?? row.last_seen_at,
    id,
  )
  const updated = get<SavedSearchRow>('SELECT * FROM saved_searches WHERE id = ?', id)!
  return toSavedSearch(updated, 0)
}

export function deleteSavedSearch(id: string): boolean {
  return run('DELETE FROM saved_searches WHERE id = ?', id).changes > 0
}

export function markSavedSearchSeen(id: string): void {
  run('UPDATE saved_searches SET last_seen_at = ? WHERE id = ?', Date.now(), id)
}
