/**
 * The sidebar: navigation, live counts, collections, saved views.
 *
 * Counts are the point. A sidebar that shows "Inbox" tells you nothing; one that
 * shows "Inbox 12" tells you whether to look.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  BarChart3,
  Bookmark,
  ChevronRight,
  Inbox,
  ListChecks,
  MessageSquareText,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Star,
  Sun,
  Moon,
  Wifi,
  WifiOff,
  Layers,
} from 'lucide-react'
import { compactNumber } from '@sift/core'
import { api } from '../lib/api.ts'
import { navigate, useRoute, type ViewName } from '../lib/router.ts'
import { applyTheme, currentTheme, useStreamStatus, type Theme } from '../lib/stream.ts'
import { Badge, IconButton, Input, Kbd, Spinner, Tooltip, cx } from './ui.tsx'
import { toast } from 'sonner'

type NavItem = {
  view: ViewName
  id?: string
  label: string
  icon: typeof Inbox
  countKey?: string
  keys?: string
}

const PRIMARY: NavItem[] = [
  { view: 'inbox', label: 'Inbox', icon: Inbox, countKey: 'inbox', keys: 'G I' },
  { view: 'today', label: 'Today', icon: Newspaper, countKey: 'today', keys: 'G T' },
  { view: 'shortlist', label: 'Shortlist', icon: ListChecks, countKey: 'shortlist', keys: 'G L' },
  { view: 'saved', label: 'Saved', icon: Bookmark, countKey: 'saved', keys: 'G S' },
  { view: 'starred', label: 'Starred', icon: Star, countKey: 'starred' },
  { view: 'archive', label: 'Archive', icon: Archive, countKey: 'archived' },
]

const SECONDARY: NavItem[] = [
  { view: 'digest', label: 'Briefing', icon: Sparkles, keys: 'G D' },
  { view: 'analytics', label: 'Trends', icon: BarChart3, keys: 'G A' },
  { view: 'ask', label: 'Ask', icon: MessageSquareText, keys: 'G Q' },
  { view: 'sources', label: 'Sources', icon: Rss, keys: 'G C' },
]

function NavRow({
  item,
  count,
  active,
  onClick,
}: {
  item: NavItem
  count?: number
  active: boolean
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors duration-[120ms]',
        active ? 'bg-bg-active font-medium text-fg' : 'text-fg-secondary hover:bg-bg-hover hover:text-fg',
      )}
    >
      <Icon size={14} className={cx('shrink-0', active ? 'text-accent' : 'text-fg-quaternary')} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.keys && (
        <span className="hidden font-mono text-[10px] text-fg-quaternary opacity-0 transition-opacity group-hover:opacity-100 xl:inline">
          {item.keys}
        </span>
      )}
      {count != null && count > 0 && (
        <span className={cx('tabular shrink-0 font-mono text-[10px]', active ? 'text-fg-secondary' : 'text-fg-quaternary')}>
          {compactNumber(count)}
        </span>
      )}
    </button>
  )
}

export function Sidebar({ onOpenPalette, onOpenShortcuts }: { onOpenPalette: () => void; onOpenShortcuts: () => void }) {
  const route = useRoute()
  const queryClient = useQueryClient()
  const online = useStreamStatus()
  const [theme, setTheme] = useState<Theme>(currentTheme)
  const [newCollection, setNewCollection] = useState<string | null>(null)

  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.counts, refetchInterval: 30_000 })
  const { data: collections } = useQuery({ queryKey: ['collections'], queryFn: api.collections })
  const { data: views } = useQuery({ queryKey: ['views'], queryFn: api.views })
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 })

  const refresh = useMutation({
    mutationFn: api.refreshAll,
    onSuccess: (result) => {
      void queryClient.invalidateQueries()
      toast.success(
        result.collected ? `${result.collected} new item${result.collected === 1 ? '' : 's'}` : 'Everything up to date',
      )
    },
    onError: (error) => toast.error('Refresh failed', { description: (error as Error).message }),
  })

  const createCollection = useMutation({
    mutationFn: (name: string) => api.createCollection({ name }),
    onSuccess: ({ collection }) => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
      setNewCollection(null)
      navigate({ view: 'collection', id: collection.id, item: undefined })
    },
  })

  const cycleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  return (
    <nav className="flex h-full w-full flex-col bg-bg-subtle" aria-label="Main navigation">
      {/* brand + search */}
      <div className="shrink-0 px-2.5 pb-2 pt-3">
        <div className="mb-3 flex items-center gap-2 px-1">
          <svg width="17" height="17" viewBox="0 0 24 24" className="text-accent" aria-hidden="true">
            <path d="M2 12 L12 2 L22 12 L12 22 Z" fill="currentColor" />
          </svg>
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">Sift</span>

          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip label={online ? 'Live — receiving updates' : 'Reconnecting to the local server'}>
              <span className={cx('flex size-6 items-center justify-center', online ? 'text-success' : 'text-warning')}>
                {online ? <Wifi size={11} /> : <WifiOff size={11} />}
              </span>
            </Tooltip>
            <IconButton
              title={refresh.isPending ? 'Refreshing…' : 'Refresh all sources (⌘↵)'}
              size="xs"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending ? <Spinner size={12} /> : <RefreshCw size={12} />}
            </IconButton>
            <IconButton
              title={`Theme: ${theme} — click to change`}
              size="xs"
              onClick={cycleTheme}
            >
              {theme === 'light' ? <Sun size={12} /> : <Moon size={12} />}
            </IconButton>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenPalette}
          className="flex h-7 w-full items-center gap-2 rounded-md border border-border-subtle bg-bg-inset px-2 text-xs text-fg-quaternary transition-colors hover:border-border hover:text-fg-tertiary"
        >
          <Search size={12} />
          <span className="flex-1 text-left">Search or jump to…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      {/* scrollable nav */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <div className="space-y-px">
          {PRIMARY.map((item) => (
            <NavRow
              key={item.view}
              item={item}
              count={item.countKey ? counts?.[item.countKey] : undefined}
              active={route.view === item.view}
              onClick={() => navigate({ view: item.view, id: undefined, item: undefined, query: { q: '' } })}
            />
          ))}
        </div>

        <div className="my-3 h-px bg-border-subtle" />

        <div className="space-y-px">
          {SECONDARY.map((item) => (
            <NavRow
              key={item.view}
              item={item}
              active={route.view === item.view}
              onClick={() => navigate({ view: item.view, id: undefined, item: undefined })}
            />
          ))}
        </div>

        {/* saved views */}
        {views && views.views.length > 0 && (
          <>
            <div className="mt-4 mb-1.5 flex items-center justify-between px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-quaternary">Views</span>
            </div>
            <div className="space-y-px">
              {views.views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => {
                    navigate({ view: 'search', id: view.id, item: undefined, query: view.query })
                    if (view.alerting) void api.markViewSeen(view.id).then(() => queryClient.invalidateQueries({ queryKey: ['views'] }))
                  }}
                  className={cx(
                    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors',
                    route.id === view.id ? 'bg-bg-active font-medium text-fg' : 'text-fg-secondary hover:bg-bg-hover hover:text-fg',
                  )}
                >
                  <span className="w-3.5 shrink-0 text-center text-[11px]">{view.icon ?? '◇'}</span>
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                  {view.newCount > 0 && <Badge tone="accent">{compactNumber(view.newCount)}</Badge>}
                </button>
              ))}
            </div>
          </>
        )}

        {/* collections */}
        <div className="mt-4 mb-1.5 flex items-center justify-between px-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-quaternary">Collections</span>
          <IconButton title="New collection" size="xs" onClick={() => setNewCollection('')}>
            <Plus size={11} />
          </IconButton>
        </div>

        {newCollection !== null && (
          <div className="mb-1 px-1">
            <Input
              autoFocus
              value={newCollection}
              placeholder="Collection name…"
              className="h-7 text-xs"
              onChange={(event) => setNewCollection(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newCollection.trim()) createCollection.mutate(newCollection.trim())
                if (event.key === 'Escape') setNewCollection(null)
              }}
              onBlur={() => !newCollection.trim() && setNewCollection(null)}
            />
          </div>
        )}

        <div className="space-y-px">
          {collections?.collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              onClick={() => navigate({ view: 'collection', id: collection.id, item: undefined, query: { q: '' } })}
              className={cx(
                'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors',
                route.view === 'collection' && route.id === collection.id
                  ? 'bg-bg-active font-medium text-fg'
                  : 'text-fg-secondary hover:bg-bg-hover hover:text-fg',
              )}
            >
              <span className="w-3.5 shrink-0 text-center text-[11px]">{collection.icon ?? <Layers size={13} />}</span>
              <span className="min-w-0 flex-1 truncate">{collection.name}</span>
              <span className="tabular shrink-0 font-mono text-[10px] text-fg-quaternary">
                {collection.itemCount || ''}
              </span>
            </button>
          ))}
          {!collections?.collections.length && newCollection === null && (
            <p className="px-2 py-1.5 text-[11px] leading-relaxed text-fg-quaternary">
              No collections yet. Press <span className="font-mono">C</span> on an item to file it.
            </p>
          )}
        </div>
      </div>

      {/* footer */}
      <div className="shrink-0 border-t border-border-subtle px-2.5 py-2">
        <button
          type="button"
          onClick={() => navigate({ view: 'settings', id: undefined, item: undefined })}
          className={cx(
            'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors',
            route.view === 'settings' ? 'bg-bg-active font-medium text-fg' : 'text-fg-secondary hover:bg-bg-hover hover:text-fg',
          )}
        >
          <SettingsIcon size={14} className="shrink-0 text-fg-quaternary" />
          <span className="flex-1">Settings</span>
          <span className="hidden font-mono text-[10px] text-fg-quaternary xl:inline">G ,</span>
        </button>

        <button
          type="button"
          onClick={onOpenShortcuts}
          className="mt-1 flex w-full items-center justify-between px-2 py-1 text-[10px] text-fg-quaternary transition-colors hover:text-fg-tertiary"
        >
          <span className="flex items-center gap-1.5">
            {health?.db.items != null && <span className="tabular font-mono">{compactNumber(health.db.items)} items</span>}
            {health && (
              <span className="opacity-60">
                · {health.embeddings.provider}
                {health.ai.configured ? ' · AI on' : ''}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            shortcuts <Kbd>?</Kbd>
          </span>
        </button>
      </div>
    </nav>
  )
}

/** Header shown above the feed, with the view title and its controls. */
export function FeedHeader({
  title,
  subtitle,
  count,
  tookMs,
  selectedCount,
  onClearSelection,
  right,
  children,
}: {
  title: string
  subtitle?: string
  count?: number
  tookMs?: number
  selectedCount: number
  onClearSelection: () => void
  right?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <header className="hairline-b shrink-0 bg-bg/85 backdrop-blur-md">
      <div className="flex h-11 items-center gap-2 px-3">
        {selectedCount > 0 ? (
          <>
            <Badge tone="accent">{selectedCount} selected</Badge>
            <button type="button" onClick={onClearSelection} className="text-2xs text-fg-tertiary hover:text-fg">
              clear
            </button>
            <div className="ml-auto flex items-center gap-1">{children}</div>
          </>
        ) : (
          <>
            <h1 className="truncate text-[13px] font-semibold text-fg">{title}</h1>
            {count != null && (
              <span className="tabular shrink-0 font-mono text-2xs text-fg-quaternary">{compactNumber(count)}</span>
            )}
            {tookMs != null && tookMs > 0 && (
              <span className="hidden shrink-0 font-mono text-[10px] text-fg-quaternary lg:inline">{tookMs}ms</span>
            )}
            {subtitle && <span className="truncate text-2xs text-fg-quaternary">· {subtitle}</span>}
            <div className="ml-auto flex items-center gap-1">{right}</div>
          </>
        )}
      </div>
    </header>
  )
}

export { ChevronRight }
