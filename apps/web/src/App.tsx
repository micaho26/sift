/**
 * The app shell.
 *
 * Owns three things nothing else can: the keyboard cursor over the feed, the
 * optimistic triage queue with undo, and the wiring from every hotkey to an
 * action. Everything else is a leaf component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  Bookmark,
  Archive as ArchiveIcon,
  Filter,
  LayoutList,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import {
  SOURCE_META,
  highlightTerms as computeHighlightTerms,
  topicLabel,
  type ItemState,
  type ItemSummary,
  type SearchQuery,
} from '@sift/core'
import { api } from './lib/api.ts'
import { VIEW_TITLES, isFeedView, navigate, openItem, routeToQuery, setQuery, useRoute } from './lib/router.ts'
import { useHotkeys } from './lib/keys.ts'
import { applyTheme, useLocalStorage, useMediaQuery, useStream } from './lib/stream.ts'
import { Badge, IconButton, Input, cx } from './components/ui.tsx'
import { FeedEmpty, FeedList } from './components/FeedList.tsx'
import { Reader, ReaderPlaceholder, type ReaderActions } from './components/Reader.tsx'
import { FeedHeader, Sidebar } from './components/Sidebar.tsx'
import { CollectDialog, CommandPalette, ShareDialog, ShortcutsDialog, TagDialog, type PaletteAction } from './components/CommandPalette.tsx'
import { Analytics } from './components/Analytics.tsx'
import { Ask, DigestView } from './components/Ask.tsx'
import { Settings, Sources } from './components/Settings.tsx'
import { Onboarding } from './components/Onboarding.tsx'
import { toast } from 'sonner'

const SORTS: { value: NonNullable<SearchQuery['sort']>; label: string }[] = [
  { value: 'signal', label: 'Signal' },
  { value: 'recent', label: 'Newest' },
  { value: 'velocity', label: 'Fastest rising' },
  { value: 'relevance', label: 'Best match' },
  { value: 'oldest', label: 'Oldest' },
]

export function App() {
  const route = useRoute()
  const queryClient = useQueryClient()
  const isNarrow = useMediaQuery('(max-width: 1080px)')

  const [sidebarOpen, setSidebarOpen] = useLocalStorage('sift.sidebar', true)
  const [density, setDensity] = useLocalStorage<'comfortable' | 'compact'>('sift.density', 'comfortable')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [tagTarget, setTagTarget] = useState<ItemSummary | undefined>()
  const [collectTargets, setCollectTargets] = useState<string[] | null>(null)
  const [shareTarget, setShareTarget] = useState<ItemSummary | undefined>()
  const [searchDraft, setSearchDraft] = useState(route.query.q ?? '')
  const [showFilters, setShowFilters] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const readerActions = useRef<ReaderActions | null>(null)

  /** Ids removed optimistically, hidden from the list until the server agrees. */
  const [pendingRemoval, setPendingRemoval] = useState<Set<string>>(new Set())

  const feedQuery = useMemo(() => routeToQuery(route), [route])
  const feedView = isFeedView(route.view)

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['search', feedQuery],
    queryFn: () => api.search(feedQuery, true),
    enabled: feedView,
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  })

  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health })

  const items = useMemo(
    () => (data?.items ?? []).filter((item) => !pendingRemoval.has(item.id)),
    [data?.items, pendingRemoval],
  )

  const terms = useMemo(() => computeHighlightTerms(route.query.q ?? ''), [route.query.q])

  // Keep the cursor inside the list as it changes under us.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, items.length - 1)))
  }, [items.length])

  // Sync the search box when the route changes from elsewhere (palette, chips).
  useEffect(() => {
    setSearchDraft(route.query.q ?? '')
  }, [route.query.q])

  // Live updates. A new-item event refreshes counts always, and the list only
  // when the user is at the top — otherwise rows would shift under their cursor.
  useStream((event) => {
    if (event.type === 'items:new') {
      void queryClient.invalidateQueries({ queryKey: ['counts'] })
      if (cursor <= 1) void refetch()
      else if (event.count > 0 && event.topScore >= 70) {
        toast(`${event.count} new item${event.count === 1 ? '' : 's'}`, {
          description: `Top signal ${event.topScore}`,
          action: { label: 'Show', onClick: () => void refetch() },
        })
      }
    } else if (event.type === 'items:updated' || event.type === 'items:removed') {
      void queryClient.invalidateQueries({ queryKey: ['counts'] })
    } else if (event.type === 'job' && event.state === 'done' && event.name === 'rescore') {
      void queryClient.invalidateQueries({ queryKey: ['search'] })
    }
  })

  const activeItem = items[cursor]
  const targetIds = selected.size > 0 ? [...selected] : activeItem ? [activeItem.id] : []

  /* ------------------------------------------------------- triage actions -- */

  /**
   * Optimistic state change with undo.
   *
   * The row disappears immediately and a toast offers 6 seconds of undo. Waiting
   * for the round-trip would make rapid triage feel like wading; not offering undo
   * would make it feel dangerous.
   */
  const applyState = useCallback(
    async (ids: string[], state: ItemState, label: string) => {
      if (!ids.length) return
      const removesFromView = !feedQuery.states?.includes(state)
      if (removesFromView) setPendingRemoval((prev) => new Set([...prev, ...ids]))

      try {
        await api.setState(ids, state)
        void queryClient.invalidateQueries({ queryKey: ['counts'] })
        setSelected(new Set())

        toast.success(`${label} ${ids.length > 1 ? `${ids.length} items` : ''}`.trim(), {
          duration: 6000,
          action: {
            label: 'Undo',
            onClick: () => {
              void api.setState(ids, (feedQuery.states?.[0] as ItemState) ?? 'inbox').then(() => {
                setPendingRemoval((prev) => {
                  const next = new Set(prev)
                  for (const id of ids) next.delete(id)
                  return next
                })
                void refetch()
                void queryClient.invalidateQueries({ queryKey: ['counts'] })
              })
            },
          },
        })

        // Reconcile once the toast window has passed, dropping the tombstones.
        setTimeout(() => {
          setPendingRemoval((prev) => {
            const next = new Set(prev)
            for (const id of ids) next.delete(id)
            return next
          })
          void refetch()
        }, 6200)
      } catch (error) {
        setPendingRemoval((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
        toast.error('Could not update', { description: (error as Error).message })
      }
    },
    [feedQuery.states, queryClient, refetch],
  )

  const toggleStar = useCallback(
    async (ids: string[], next?: boolean) => {
      if (!ids.length) return
      const value = next ?? !(items.find((item) => item.id === ids[0])?.starred ?? false)
      await api.setStarred(ids, value)
      void refetch()
      void queryClient.invalidateQueries({ queryKey: ['counts'] })
    },
    [items, refetch, queryClient],
  )

  const openReader = useCallback((item: ItemSummary, index: number) => {
    setCursor(index)
    openItem(item.id)
  }, [])

  const moveCursor = useCallback(
    (delta: 1 | -1) => {
      setCursor((current) => {
        const next = Math.max(0, Math.min(items.length - 1, current + delta))
        // When the reader is open, moving the cursor moves the reader too — that
        // is the triage loop: J, read, S, J, read, E.
        if (route.item && items[next]) openItem(items[next]!.id)
        return next
      })
    },
    [items, route.item],
  )

  const exportView = useCallback(
    async (format: 'markdown' | 'json' | 'csv') => {
      try {
        const response = await api.exportItems({
          format,
          itemIds: selected.size ? [...selected] : undefined,
          query: selected.size ? undefined : feedQuery,
          title: VIEW_TITLES[route.view],
        })
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `sift-${route.view}.${format === 'markdown' ? 'md' : format}`
        link.click()
        URL.revokeObjectURL(url)
        toast.success(`Exported as ${format}`)
      } catch (error) {
        toast.error('Export failed', { description: (error as Error).message })
      }
    },
    [selected, feedQuery, route.view],
  )

  /* ------------------------------------------------------------- hotkeys -- */

  useHotkeys(
    {
      j: () => moveCursor(1),
      k: () => moveCursor(-1),
      arrowdown: () => moveCursor(1),
      arrowup: () => moveCursor(-1),
      enter: () => {
        if (activeItem) openItem(activeItem.id)
      },
      escape: () => {
        if (selected.size) {
          setSelected(new Set())
          return
        }
        if (route.item) openItem(undefined)
        else if (route.query.q) setQuery({ q: '' })
      },
      o: () => {
        if (activeItem) window.open(activeItem.url, '_blank', 'noopener,noreferrer')
      },

      s: () => void applyState(targetIds, 'saved', 'Saved'),
      l: () => void applyState(targetIds, 'shortlist', 'Shortlisted'),
      e: () => void applyState(targetIds, 'archived', 'Archived'),
      '#': () => void applyState(targetIds, 'trash', 'Trashed'),
      f: () => void toggleStar(targetIds),
      u: () => {
        if (!activeItem) return
        void api.markRead([activeItem.id], !activeItem.readAt).then(() => {
          void refetch()
          void queryClient.invalidateQueries({ queryKey: ['counts'] })
        })
      },
      x: () => {
        if (!activeItem) return
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(activeItem.id)) next.delete(activeItem.id)
          else next.add(activeItem.id)
          return next
        })
        moveCursor(1)
      },

      t: () => {
        if (activeItem) setTagTarget(activeItem)
      },
      c: () => {
        if (targetIds.length) setCollectTargets(targetIds)
      },
      y: () => {
        if (readerActions.current) {
          readerActions.current.copyLink()
          return
        }
        if (activeItem) void navigator.clipboard.writeText(activeItem.url).then(() => toast.success('Link copied'))
      },
      'shift+s': () => {
        if (activeItem) setShareTarget(activeItem)
      },
      w: () => {
        readerActions.current?.toggleWhy()
      },

      a: () => {
        if (!route.item && activeItem) openItem(activeItem.id)
        setTimeout(() => readerActions.current?.summarize(), route.item ? 0 : 260)
      },
      r: () => {
        if (!route.item && activeItem) openItem(activeItem.id)
        setTimeout(() => readerActions.current?.translate(), route.item ? 0 : 260)
      },
      i: () => {
        if (!route.item && activeItem) openItem(activeItem.id)
        setTimeout(() => readerActions.current?.takeaways(), route.item ? 0 : 260)
      },

      'g i': () => navigate({ view: 'inbox', id: undefined, item: undefined, query: { q: '' } }),
      'g t': () => navigate({ view: 'today', id: undefined, item: undefined, query: { q: '' } }),
      'g l': () => navigate({ view: 'shortlist', id: undefined, item: undefined, query: { q: '' } }),
      'g s': () => navigate({ view: 'saved', id: undefined, item: undefined, query: { q: '' } }),
      'g a': () => navigate({ view: 'analytics', id: undefined, item: undefined }),
      'g q': () => navigate({ view: 'ask', id: undefined, item: undefined }),
      'g d': () => navigate({ view: 'digest', id: undefined, item: undefined }),
      'g c': () => navigate({ view: 'sources', id: undefined, item: undefined }),
      'g ,': () => navigate({ view: 'settings', id: undefined, item: undefined }),

      'mod+k': () => setPaletteOpen(true),
      '/': () => {
        if (!feedView) navigate({ view: 'search', id: undefined, item: undefined })
        setTimeout(() => searchRef.current?.focus(), 0)
      },
      'mod+enter': () => {
        toast.promise(api.refreshAll(), {
          loading: 'Polling every source…',
          success: (result) => {
            void queryClient.invalidateQueries()
            return result.collected ? `${result.collected} new items` : 'Everything up to date'
          },
          error: (error) => `Refresh failed: ${(error as Error).message}`,
        })
      },
      'mod+\\': () => setSidebarOpen(!sidebarOpen),
      'mod+shift+l': () => {
        const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
        applyTheme(next)
      },
      '?': () => setShortcutsOpen(true),
    },
    !paletteOpen,
  )

  /* ------------------------------------------------------ palette actions -- */

  const handlePaletteAction = useCallback(
    (action: PaletteAction) => {
      switch (action.type) {
        case 'navigate':
          navigate({ view: action.view, id: action.id, item: undefined, query: { q: '' } })
          break
        case 'search':
          navigate({ view: 'search', id: undefined, item: undefined, query: { q: action.q } })
          break
        case 'open-item':
          openItem(action.id)
          break
        case 'refresh':
          toast.promise(api.refreshAll(), {
            loading: 'Polling every source…',
            success: (result) => {
              void queryClient.invalidateQueries()
              return result.collected ? `${result.collected} new items` : 'Everything up to date'
            },
            error: 'Refresh failed',
          })
          break
        case 'rescore':
          toast.promise(api.rescore(), {
            loading: 'Recomputing signal scores…',
            success: (result) => {
              void queryClient.invalidateQueries()
              return `Rescored ${result.rescored} items in ${result.tookMs}ms`
            },
            error: 'Rescore failed',
          })
          break
        case 'digest':
          toast.promise(api.generateDigest({ hours: 24 }), {
            loading: 'Writing your briefing…',
            success: () => {
              void queryClient.invalidateQueries({ queryKey: ['digest-latest'] })
              navigate({ view: 'digest', id: undefined, item: undefined })
              return 'Briefing ready'
            },
            error: 'Could not generate a briefing',
          })
          break
        case 'theme':
          applyTheme(action.theme)
          break
        case 'export':
          void exportView(action.format)
          break
        case 'shortcuts':
          setShortcutsOpen(true)
          break
        case 'state':
          void applyState(targetIds, action.state, action.state === 'saved' ? 'Saved' : 'Updated')
          break
        case 'star':
          void toggleStar(targetIds)
          break
        case 'tag':
          if (activeItem) setTagTarget(activeItem)
          break
        case 'collect':
          if (targetIds.length) setCollectTargets(targetIds)
          break
        case 'summarize':
          if (activeItem) {
            openItem(activeItem.id)
            setTimeout(() => readerActions.current?.summarize(), 280)
          }
          break
        case 'translate':
          if (activeItem) {
            openItem(activeItem.id)
            setTimeout(() => readerActions.current?.translate(), 280)
          }
          break
        case 'filter-source':
          navigate({ view: 'search', id: undefined, item: undefined, query: { ...route.query, sources: [action.source] as never } })
          break
        case 'filter-topic':
          navigate({ view: 'search', id: undefined, item: undefined, query: { ...route.query, topics: [action.topic] } })
          break
      }
    },
    [activeItem, applyState, exportView, queryClient, route.query, targetIds, toggleStar],
  )

  /* --------------------------------------------------------------- render -- */

  const showReader = Boolean(route.item)
  const showSidebar = sidebarOpen && !(isNarrow && showReader)
  const activeFilters = [
    route.query.sources?.length && `${route.query.sources.length} source`,
    route.query.topics?.length && `${route.query.topics.length} topic`,
    route.query.tags?.length && `${route.query.tags.length} tag`,
    route.query.minScore != null && `≥${route.query.minScore}`,
    route.query.unreadOnly && 'unread',
  ].filter(Boolean) as string[]

  const needsOnboarding = health && health.db.items === 0

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg text-fg">
      {/* sidebar */}
      <aside
        className={cx(
          'hairline-b relative shrink-0 border-r border-border-subtle transition-[width] duration-[220ms] ease-[var(--ease-out-expo)]',
          showSidebar ? 'w-[212px]' : 'w-0',
        )}
      >
        {showSidebar && <Sidebar onOpenPalette={() => setPaletteOpen(true)} onOpenShortcuts={() => setShortcutsOpen(true)} />}
      </aside>

      {/* main */}
      <main className="flex min-w-0 flex-1">
        {needsOnboarding ? (
          <Onboarding onDone={() => void queryClient.invalidateQueries()} />
        ) : !feedView ? (
          <div className="min-w-0 flex-1">
            {route.view === 'analytics' && <Analytics />}
            {route.view === 'ask' && <Ask onOpenItem={(id) => navigate({ view: 'inbox', item: id, id: undefined })} />}
            {route.view === 'digest' && <DigestView onOpenItem={(id) => navigate({ view: 'inbox', item: id, id: undefined })} />}
            {route.view === 'sources' && <Sources />}
            {route.view === 'settings' && <Settings />}
          </div>
        ) : (
          <>
            {/* feed pane */}
            <section
              className={cx(
                'flex min-w-0 flex-col border-r border-border-subtle',
                showReader ? 'hidden w-[400px] shrink-0 lg:flex xl:w-[440px]' : 'flex-1',
              )}
            >
              <FeedHeader
                title={route.view === 'collection' ? 'Collection' : VIEW_TITLES[route.view]}
                count={data?.total}
                tookMs={data?.tookMs}
                selectedCount={selected.size}
                onClearSelection={() => setSelected(new Set())}
                right={
                  <>
                    <IconButton
                      title={sidebarOpen ? 'Hide sidebar (⌘\\)' : 'Show sidebar (⌘\\)'}
                      size="xs"
                      onClick={() => setSidebarOpen(!sidebarOpen)}
                    >
                      {sidebarOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
                    </IconButton>
                    <IconButton
                      title={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
                      size="xs"
                      active={density === 'compact'}
                      onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
                    >
                      <LayoutList size={13} />
                    </IconButton>
                    <IconButton
                      title="Filters"
                      size="xs"
                      active={showFilters || activeFilters.length > 0}
                      onClick={() => setShowFilters(!showFilters)}
                    >
                      <Filter size={13} />
                    </IconButton>
                    <div className="relative">
                      <select
                        aria-label="Sort"
                        value={route.query.sort ?? (route.query.q ? 'relevance' : 'signal')}
                        onChange={(event) => setQuery({ sort: event.target.value as SearchQuery['sort'] })}
                        className="h-6 cursor-pointer appearance-none rounded-md border border-border-subtle bg-bg-inset pl-6 pr-1.5 text-2xs text-fg-tertiary outline-none hover:text-fg"
                      >
                        {SORTS.map((sort) => (
                          <option key={sort.value} value={sort.value}>
                            {sort.label}
                          </option>
                        ))}
                      </select>
                      <ArrowDownWideNarrow size={11} className="pointer-events-none absolute left-1.5 top-1.5 text-fg-quaternary" />
                    </div>
                  </>
                }
              >
                {/* selection-mode actions */}
                <IconButton title="Save all" size="xs" onClick={() => void applyState([...selected], 'saved', 'Saved')}>
                  <Bookmark size={13} />
                </IconButton>
                <IconButton title="Shortlist all" size="xs" onClick={() => void applyState([...selected], 'shortlist', 'Shortlisted')}>
                  <ListChecks size={13} />
                </IconButton>
                <IconButton title="Star all" size="xs" onClick={() => void toggleStar([...selected], true)}>
                  <Star size={13} />
                </IconButton>
                <IconButton title="Add to collection" size="xs" onClick={() => setCollectTargets([...selected])}>
                  <Sparkles size={13} />
                </IconButton>
                <IconButton title="Archive all" size="xs" onClick={() => void applyState([...selected], 'archived', 'Archived')}>
                  <ArchiveIcon size={13} />
                </IconButton>
                <IconButton title="Trash all" size="xs" onClick={() => void applyState([...selected], 'trash', 'Trashed')}>
                  <Trash2 size={13} />
                </IconButton>
              </FeedHeader>

              {/* search + filters */}
              <div className="hairline-b shrink-0 space-y-2 px-3 py-2">
                <Input
                  ref={searchRef}
                  value={searchDraft}
                  icon={<Search size={12} />}
                  placeholder="Search everything you have collected…"
                  onChange={(event) => {
                    setSearchDraft(event.target.value)
                    // Replace history while typing, so Back does not walk keystrokes.
                    setQuery({ q: event.target.value }, { replace: true })
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setSearchDraft('')
                      setQuery({ q: '' })
                      event.currentTarget.blur()
                    }
                  }}
                  className="h-7"
                />

                {(showFilters || activeFilters.length > 0) && (
                  <div className="animate-slide-up flex flex-wrap items-center gap-1.5">
                    {data?.facets?.sources.slice(0, 6).map((facet) => {
                      const active = route.query.sources?.includes(facet.value as never)
                      return (
                        <button
                          key={facet.value}
                          type="button"
                          onClick={() =>
                            setQuery({
                              sources: active
                                ? (route.query.sources?.filter((s) => s !== facet.value) as never)
                                : ([...(route.query.sources ?? []), facet.value] as never),
                            })
                          }
                          className={cx(
                            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs transition-colors',
                            active
                              ? 'border-accent-600 bg-accent-muted text-accent'
                              : 'border-border-subtle bg-bg-inset text-fg-tertiary hover:text-fg',
                          )}
                        >
                          <span
                            className="size-[5px] rounded-full"
                            style={{ background: SOURCE_META[facet.value as keyof typeof SOURCE_META]?.color }}
                          />
                          {SOURCE_META[facet.value as keyof typeof SOURCE_META]?.short ?? facet.value}
                          <span className="tabular opacity-60">{facet.count}</span>
                        </button>
                      )
                    })}
                    {data?.facets?.topics.slice(0, 5).map((facet) => {
                      const active = route.query.topics?.includes(facet.value)
                      return (
                        <button
                          key={facet.value}
                          type="button"
                          onClick={() =>
                            setQuery({
                              topics: active
                                ? route.query.topics?.filter((t) => t !== facet.value)
                                : [...(route.query.topics ?? []), facet.value],
                            })
                          }
                          className={cx(
                            'rounded-md border px-1.5 py-0.5 text-2xs transition-colors',
                            active
                              ? 'border-accent-600 bg-accent-muted text-accent'
                              : 'border-border-subtle bg-bg-inset text-fg-tertiary hover:text-fg',
                          )}
                        >
                          {topicLabel(facet.value)}
                          <span className="tabular ml-1 opacity-60">{facet.count}</span>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => setQuery({ unreadOnly: route.query.unreadOnly ? undefined : true })}
                      className={cx(
                        'rounded-md border px-1.5 py-0.5 text-2xs transition-colors',
                        route.query.unreadOnly
                          ? 'border-accent-600 bg-accent-muted text-accent'
                          : 'border-border-subtle bg-bg-inset text-fg-tertiary hover:text-fg',
                      )}
                    >
                      unread
                    </button>
                    {activeFilters.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          navigate({ query: { q: route.query.q } })
                        }
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-fg-quaternary hover:text-danger"
                      >
                        <X size={9} /> clear
                      </button>
                    )}
                  </div>
                )}

                {data?.concepts && data.concepts.length > 0 && route.query.q && (
                  <p className="flex flex-wrap items-center gap-1.5 text-[10px] text-fg-quaternary">
                    also matched by concept:
                    {data.concepts.slice(0, 4).map((concept) => (
                      <Badge key={concept} tone="info">
                        {topicLabel(concept)}
                      </Badge>
                    ))}
                  </p>
                )}
              </div>

              {/* list */}
              <div className="min-h-0 flex-1">
                {items.length === 0 && !isFetching ? (
                  <FeedEmpty
                    view={route.view}
                    onAction={() => {
                      toast.promise(api.refreshAll(), {
                        loading: 'Polling every source…',
                        success: (result) => {
                          void queryClient.invalidateQueries()
                          return result.collected ? `${result.collected} new items` : 'Everything up to date'
                        },
                        error: 'Refresh failed',
                      })
                    }}
                  />
                ) : (
                  <FeedList
                    items={items}
                    loading={isFetching && !data}
                    cursorIndex={cursor}
                    selected={selected}
                    openId={route.item}
                    matchedBy={data?.matchedBy}
                    highlightTerms={terms}
                    density={density}
                    onOpen={openReader}
                    onCursor={setCursor}
                    onToggleSelect={(id) =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }
                    onSave={(item) => void applyState([item.id], 'saved', 'Saved')}
                    onStar={(item) => void toggleStar([item.id], !item.starred)}
                    onArchive={(item) => void applyState([item.id], 'archived', 'Archived')}
                    hasMore={Boolean(data?.cursor)}
                  />
                )}
              </div>
            </section>

            {/* reader pane */}
            {showReader ? (
              <section className="min-w-0 flex-1">
                <Reader
                  itemId={route.item!}
                  onClose={() => openItem(undefined)}
                  onNavigate={moveCursor}
                  onStateChange={() => void refetch()}
                  onOpenItem={(id) => openItem(id)}
                  onShare={setShareTarget}
                  onTag={setTagTarget}
                  onCollect={(item) => setCollectTargets([item.id])}
                  registerActions={(actions) => {
                    readerActions.current = actions
                  }}
                />
              </section>
            ) : (
              <section className="hidden min-w-0 flex-1 xl:block">
                <ReaderPlaceholder hasItems={items.length > 0} />
              </section>
            )}
          </>
        )}
      </main>

      {/* overlays */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        context={{ activeItem, selectedIds: [...selected], onAction: handlePaletteAction }}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <TagDialog
        open={Boolean(tagTarget)}
        item={tagTarget}
        onClose={() => setTagTarget(undefined)}
        onSaved={() => {
          void refetch()
          void queryClient.invalidateQueries({ queryKey: ['facets'] })
        }}
      />
      <CollectDialog
        open={Boolean(collectTargets)}
        itemIds={collectTargets ?? []}
        onClose={() => setCollectTargets(null)}
        onSaved={() => {
          setSelected(new Set())
          void refetch()
        }}
      />
      <ShareDialog open={Boolean(shareTarget)} item={shareTarget} onClose={() => setShareTarget(undefined)} />
    </div>
  )
}
