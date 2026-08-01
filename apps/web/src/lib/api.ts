/**
 * The API client.
 *
 * Thin on purpose: fetch, parse, throw a typed error. No caching here — TanStack
 * Query owns that, and a second cache layer would make staleness impossible to
 * reason about.
 */
import type {
  AnalyticsResponse,
  ChatCitation,
  Collection,
  Digest,
  HealthResponse,
  Highlight,
  IngestResult,
  Item,
  ItemState,
  ItemSummary,
  SavedSearch,
  SearchQuery,
  SearchResponse,
  Settings,
  SourceConfig,
} from '@sift/core'

/** Same-origin in production, Vite-proxied in development. */
const BASE = '/api'

export class ApiError extends Error {
  status: number
  detail?: string
  code?: string
  constructor(message: string, status: number, detail?: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (cause) {
    // A dead local server is the most likely failure, and the message should say
    // so rather than "Failed to fetch".
    throw new ApiError('Cannot reach the Sift server. Is it running?', 0, String(cause), 'offline')
  }

  if (!response.ok) {
    let detail: string | undefined
    let code: string | undefined
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string; detail?: string; code?: string }
      if (body.error) message = body.error
      detail = body.detail
      code = body.code
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new ApiError(message, response.status, detail, code)
  }

  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
const del = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) })

/* ------------------------------------------------------------ query string -- */

/** Serialise a SearchQuery for a GET, so search URLs stay shareable. */
export function searchParams(query: Partial<SearchQuery>): string {
  const params = new URLSearchParams()
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','))
      return
    }
    params.set(key, String(value))
  }
  put('q', query.q)
  put('sort', query.sort)
  put('mode', query.mode)
  put('limit', query.limit)
  put('cursor', query.cursor)
  put('minScore', query.minScore)
  put('from', query.from)
  put('to', query.to)
  put('diversify', query.diversify)
  put('lang', query.lang)
  put('collectionId', query.collectionId)
  if (query.starred) put('starred', 'true')
  if (query.unreadOnly) put('unreadOnly', 'true')
  if (query.hasMedia) put('hasMedia', 'true')
  put('sources', query.sources)
  put('kinds', query.kinds)
  put('states', query.states)
  put('tags', query.tags)
  put('topics', query.topics)
  put('authors', query.authors)
  return params.toString()
}

/* ------------------------------------------------------------------- types -- */

export type ItemDetail = {
  item: Item
  highlights: Highlight[]
  collections: { id: string; name: string; icon?: string }[]
  why: string[]
  similar: ItemSummary[]
}

export type StateCounts = Record<string, number>

export type SourcesResponse = {
  sources: (SourceConfig & { pollable: boolean; pushOnly: boolean })[]
  available: { kind: string; pollable: boolean; pushOnly: boolean }[]
  presets: { kind: string; name: string; target: string; intervalMinutes: number; trust: number }[]
}

export type SettingsResponse = {
  settings: Settings
  ai: { provider: string; model: string; configured: boolean; reason?: string }
}

export type FacetValues = {
  tags: { value: string; count: number }[]
  topics: { value: string; count: number }[]
  authors: { value: string; name: string; count: number }[]
  sources: { value: string; count: number }[]
}

export type AnalyticsFull = AnalyticsResponse & {
  heatmap: { dow: number; hour: number; count: number }[]
  daily: { day: string; captured: number; saved: number; read: number }[]
}

/* --------------------------------------------------------------------- api -- */

export const api = {
  health: () => get<HealthResponse>('/health'),

  search: (query: Partial<SearchQuery>, facets = false) =>
    get<SearchResponse>(`/search?${searchParams(query)}${facets ? '&facets=true' : ''}`),

  facets: () => get<FacetValues>('/search/facets'),

  counts: () => get<StateCounts>('/items/counts'),
  item: (id: string) => get<ItemDetail>(`/items/${id}`),
  itemsByIds: (ids: string[]) => post<{ items: ItemSummary[] }>('/items/batch', { ids }),
  similar: (id: string, limit = 8) => get<{ items: ItemSummary[] }>(`/items/${id}/similar?limit=${limit}`),

  setState: (ids: string[], state: ItemState) => post<{ changed: number }>('/items/state', { ids, state }),
  setStarred: (ids: string[], starred: boolean) => post<{ changed: number }>('/items/star', { ids, starred }),
  markRead: (ids: string[], read = true, dwellSec = 0) =>
    post<{ changed: number }>('/items/read', { ids, read, dwellSec }),
  setTags: (id: string, tags: string[]) => put<{ tags: string[] }>(`/items/${id}/tags`, { tags }),
  deleteItems: (ids: string[]) => del<{ removed: number }>('/items', { ids }),

  ingest: (items: unknown[], collector?: string) => post<IngestResult>('/ingest', { items, collector }),
  rescore: () => post<{ rescored: number; tookMs: number }>('/ingest/rescore', { limit: 20000 }),

  collections: () => get<{ collections: Collection[] }>('/collections'),
  collection: (id: string) => get<{ collection: Collection; items: ItemSummary[]; smart: boolean }>(`/collections/${id}`),
  createCollection: (body: { name: string; description?: string; icon?: string }) =>
    post<{ collection: Collection }>('/collections', body),
  updateCollection: (id: string, body: Partial<Collection>) =>
    patch<{ collection: Collection }>(`/collections/${id}`, body),
  deleteCollection: (id: string) => del<{ ok: boolean }>(`/collections/${id}`),
  addToCollection: (id: string, itemIds: string[], note?: string) =>
    post<{ added: number }>(`/collections/${id}/items`, { itemIds, note }),
  removeFromCollection: (id: string, itemIds: string[]) =>
    del<{ removed: number }>(`/collections/${id}/items`, { itemIds }),

  highlights: (itemId?: string) =>
    get<{ highlights: Highlight[] }>(`/highlights${itemId ? `?itemId=${encodeURIComponent(itemId)}` : ''}`),
  createHighlight: (body: { itemId: string; text: string; note?: string; color?: Highlight['color'] }) =>
    post<{ highlight: Highlight }>('/highlights', body),
  updateHighlight: (id: string, body: { note?: string; color?: Highlight['color'] }) =>
    patch<{ highlight: Highlight }>(`/highlights/${id}`, body),
  deleteHighlight: (id: string) => del<{ ok: boolean }>(`/highlights/${id}`),

  views: () => get<{ views: SavedSearch[] }>('/views'),
  createView: (body: { name: string; query: Partial<SearchQuery>; icon?: string; pinned?: boolean; alerting?: boolean }) =>
    post<{ view: SavedSearch }>('/views', body),
  updateView: (id: string, body: Partial<SavedSearch>) => patch<{ view: SavedSearch }>(`/views/${id}`, body),
  deleteView: (id: string) => del<{ ok: boolean }>(`/views/${id}`),
  markViewSeen: (id: string) => post<{ ok: boolean }>(`/views/${id}/seen`),

  sources: () => get<SourcesResponse>('/sources'),
  createSource: (body: { kind: string; name: string; target: string; intervalMinutes?: number; trust?: number }) =>
    post<{ source: SourceConfig }>('/sources', body),
  updateSource: (id: string, body: Partial<SourceConfig>) => patch<{ source: SourceConfig }>(`/sources/${id}`, body),
  deleteSource: (id: string) => del<{ ok: boolean }>(`/sources/${id}`),
  runSource: (id: string) => post<{ collected: number; error?: string }>(`/sources/${id}/run`),
  refreshAll: () => post<{ collected: number }>('/sources/refresh'),
  seedDefaultSources: () => post<{ created: number }>('/sources/defaults'),

  settings: () => get<SettingsResponse>('/settings'),
  saveSettings: (body: Partial<Settings>) => put<SettingsResponse & { rescoring: boolean }>('/settings', body),
  saveKey: (provider: 'anthropic' | 'openai', key: string | null) =>
    put<{ ok: boolean; set: boolean }>('/settings/keys', { provider, key }),

  aiStatus: () => get<{ provider: string; model: string; configured: boolean; reason?: string }>('/ai/status'),
  takeaways: (itemId: string) => post<{ takeaways: string[]; generator?: string }>('/ai/takeaways', { itemId }),

  analytics: (days = 30) => get<AnalyticsFull>(`/analytics?days=${days}`),

  digests: () => get<{ digests: Digest[] }>('/digests'),
  latestDigest: () => get<{ digest: Digest | null }>('/digests/latest'),
  generateDigest: (body: { hours?: number; maxItems?: number } = {}) =>
    post<{ digest: Digest }>('/digests', body),

  exportItems: (body: {
    format: 'markdown' | 'json' | 'csv'
    itemIds?: string[]
    query?: Partial<SearchQuery>
    title?: string
  }) => request<Response>('/export', { method: 'POST', body: JSON.stringify(body) }),
}

/* ------------------------------------------------------------- SSE helpers -- */

export type SseHandlers = {
  onDelta?: (text: string) => void
  onEvent?: (event: string, data: string) => void
  onDone?: (meta: unknown) => void
  onError?: (message: string) => void
}

/**
 * POST that returns an SSE stream. `fetch` + a manual frame reader rather than
 * EventSource, because EventSource cannot POST and every generative endpoint here
 * needs a request body.
 */
export async function streamPost(path: string, body: unknown, handlers: SseHandlers, signal?: AbortSignal): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    if ((cause as Error).name === 'AbortError') return
    handlers.onError?.('Cannot reach the Sift server.')
    return
  }

  if (!response.ok || !response.body) {
    let message = `${response.status} ${response.statusText}`
    try {
      const parsed = (await response.json()) as { error?: string; detail?: string }
      message = parsed.detail ? `${parsed.error}: ${parsed.detail}` : (parsed.error ?? message)
    } catch {
      // keep the status line
    }
    handlers.onError?.(message)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        const data = dataLines.join('\n')

        if (event === 'delta' || event === 'cached') handlers.onDelta?.(data)
        else if (event === 'error') handlers.onError?.(data)
        else if (event === 'done') {
          try {
            handlers.onDone?.(data ? JSON.parse(data) : {})
          } catch {
            handlers.onDone?.({})
          }
        } else handlers.onEvent?.(event, data)
      }
    }
  } catch (cause) {
    if ((cause as Error).name !== 'AbortError') handlers.onError?.((cause as Error).message)
  }
}

export type ChatStreamHandlers = SseHandlers & { onCitations?: (citations: ChatCitation[]) => void }

export function streamChat(
  body: { messages: { role: 'user' | 'assistant'; content: string }[]; scope?: Partial<SearchQuery>; topK?: number },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamPost(
    '/ai/chat',
    body,
    {
      ...handlers,
      onEvent: (event, data) => {
        if (event === 'citations') {
          try {
            handlers.onCitations?.(JSON.parse(data) as ChatCitation[])
          } catch {
            // A malformed citation frame should not kill the answer.
          }
          return
        }
        handlers.onEvent?.(event, data)
      },
    },
    signal,
  )
}
