/**
 * URL-as-state.
 *
 * The entire view — which pane, which filters, which item is open — lives in the
 * address bar. That is not minimalism for its own sake: it makes every view
 * shareable, makes back/forward work correctly for free, and means a reload lands
 * you exactly where you were. A 90-line router beats a dependency here because
 * the whole surface is one enum plus a search query.
 */
import { useSyncExternalStore } from 'react'
import type { SearchQuery } from '@sift/core'

export const VIEWS = [
  'inbox',
  'today',
  'shortlist',
  'saved',
  'starred',
  'archive',
  'search',
  'collection',
  'view',
  'analytics',
  'ask',
  'digest',
  'sources',
  'settings',
] as const
export type ViewName = (typeof VIEWS)[number]

export type Route = {
  view: ViewName
  /** Collection id, saved-view id, etc. */
  id?: string
  /** Currently open item in the reader pane. */
  item?: string
  query: Partial<SearchQuery>
}

const listeners = new Set<() => void>()
let current: Route = parse(location.search)

function parseList(value: string | null): string[] | undefined {
  if (!value) return undefined
  const items = value.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function parse(search: string): Route {
  const params = new URLSearchParams(search)
  const rawView = params.get('v') ?? 'inbox'
  const view = (VIEWS as readonly string[]).includes(rawView) ? (rawView as ViewName) : 'inbox'

  const query: Partial<SearchQuery> = {
    q: params.get('q') ?? '',
    sources: parseList(params.get('sources')) as SearchQuery['sources'],
    kinds: parseList(params.get('kinds')) as SearchQuery['kinds'],
    tags: parseList(params.get('tags')),
    topics: parseList(params.get('topics')),
    authors: parseList(params.get('authors')),
    minScore: parseNumber(params.get('minScore')),
    from: parseNumber(params.get('from')),
    to: parseNumber(params.get('to')),
    sort: (params.get('sort') as SearchQuery['sort']) ?? undefined,
    mode: (params.get('mode') as SearchQuery['mode']) ?? undefined,
    starred: params.get('starred') === '1' ? true : undefined,
    unreadOnly: params.get('unread') === '1' ? true : undefined,
    hasMedia: params.get('media') === '1' ? true : undefined,
    lang: params.get('lang') ?? undefined,
  }

  return {
    view,
    id: params.get('id') ?? undefined,
    item: params.get('i') ?? undefined,
    query,
  }
}

export function serialize(route: Route): string {
  const params = new URLSearchParams()
  if (route.view !== 'inbox') params.set('v', route.view)
  if (route.id) params.set('id', route.id)
  if (route.item) params.set('i', route.item)

  const q = route.query
  if (q.q) params.set('q', q.q)
  if (q.sources?.length) params.set('sources', q.sources.join(','))
  if (q.kinds?.length) params.set('kinds', q.kinds.join(','))
  if (q.tags?.length) params.set('tags', q.tags.join(','))
  if (q.topics?.length) params.set('topics', q.topics.join(','))
  if (q.authors?.length) params.set('authors', q.authors.join(','))
  if (q.minScore != null) params.set('minScore', String(q.minScore))
  if (q.from != null) params.set('from', String(q.from))
  if (q.to != null) params.set('to', String(q.to))
  if (q.sort) params.set('sort', q.sort)
  if (q.mode && q.mode !== 'hybrid') params.set('mode', q.mode)
  if (q.starred) params.set('starred', '1')
  if (q.unreadOnly) params.set('unread', '1')
  if (q.hasMedia) params.set('media', '1')
  if (q.lang) params.set('lang', q.lang)

  const search = params.toString()
  return search ? `?${search}` : location.pathname
}

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Navigate. Opening an item `replace`s rather than pushing, so arrowing down a
 * list of forty items does not bury the previous view under forty history
 * entries — but changing view or filters pushes, so Back means what it should.
 */
export function navigate(next: Partial<Route>, options: { replace?: boolean } = {}): void {
  const merged: Route = {
    view: next.view ?? current.view,
    id: 'id' in next ? next.id : current.id,
    item: 'item' in next ? next.item : current.item,
    query: next.query ? { ...next.query } : current.query,
  }
  const url = serialize(merged)
  if (url === serialize(current)) return

  const viewChanged = merged.view !== current.view || merged.id !== current.id
  const onlyItemChanged =
    !viewChanged && JSON.stringify(merged.query) === JSON.stringify(current.query) && merged.item !== current.item

  current = merged
  if (options.replace ?? onlyItemChanged) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  emit()
}

/** Patch just the query part, keeping the current view. */
export function setQuery(patch: Partial<SearchQuery>, options: { replace?: boolean } = {}): void {
  navigate({ query: { ...current.query, ...patch } }, options)
}

export function openItem(id: string | undefined): void {
  navigate({ item: id }, { replace: true })
}

export function getRoute(): Route {
  return current
}

addEventListener('popstate', () => {
  current = parse(location.search)
  emit()
})

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute, getRoute)
}

/* --------------------------------------------------------- view semantics -- */

/** The states a view shows. Separated from the router so both the feed and the command palette agree. */
export function statesForView(view: ViewName): SearchQuery['states'] {
  switch (view) {
    case 'inbox':
    case 'today':
      return ['inbox']
    case 'shortlist':
      return ['shortlist']
    case 'saved':
      return ['saved']
    case 'starred':
      return ['inbox', 'shortlist', 'saved', 'archived']
    case 'archive':
      return ['archived']
    default:
      return undefined
  }
}

/** Turn a route into the query the feed should run. */
export function routeToQuery(route: Route): Partial<SearchQuery> {
  const base: Partial<SearchQuery> = { ...route.query, limit: 60 }
  const states = statesForView(route.view)
  if (states) base.states = states

  if (route.view === 'today') {
    base.from = base.from ?? Date.now() - 86_400_000
    base.sort = base.sort ?? 'signal'
  }
  if (route.view === 'starred') base.starred = true
  if (route.view === 'collection' && route.id) base.collectionId = route.id
  if (route.view === 'archive') base.sort = base.sort ?? 'recent'
  return base
}

export const VIEW_TITLES: Record<ViewName, string> = {
  inbox: 'Inbox',
  today: 'Today',
  shortlist: 'Shortlist',
  saved: 'Saved',
  starred: 'Starred',
  archive: 'Archive',
  search: 'Search',
  collection: 'Collection',
  view: 'Saved view',
  analytics: 'Trends',
  ask: 'Ask',
  digest: 'Briefing',
  sources: 'Sources',
  settings: 'Settings',
}

/** Views that render a feed + reader rather than their own full-pane UI. */
export function isFeedView(view: ViewName): boolean {
  return !['analytics', 'ask', 'sources', 'settings', 'digest'].includes(view)
}
