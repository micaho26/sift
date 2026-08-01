/**
 * Command palette and the small modal surfaces.
 *
 * The palette is the app's real navigation. Everything reachable by mouse is
 * reachable here by name, which is what lets the sidebar stay short and the
 * toolbars stay uncluttered.
 */
import { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  BarChart3,
  Bookmark,
  Check,
  Copy,
  Download,
  Inbox,
  Languages,
  Layers,
  ListChecks,
  MessageSquareText,
  Moon,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Star,
  Sun,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react'
import { SOURCE_META, TOPICS, timeAgo, topicLabel, type ItemSummary } from '@sift/core'
import { api } from '../lib/api.ts'
import { navigate } from '../lib/router.ts'
import { SHORTCUTS, formatKeys } from '../lib/keys.ts'
import { applyTheme, useDebounced } from '../lib/stream.ts'
import { Badge, Button, Dialog, Input, Kbd, ScoreBadge, Spinner, cx } from './ui.tsx'
import { toast } from 'sonner'

/* ------------------------------------------------------------ the palette -- */

export type PaletteContext = {
  /** The item under the cursor, if any — enables item-scoped actions. */
  activeItem?: ItemSummary
  selectedIds: string[]
  onAction: (action: PaletteAction) => void
}

export type PaletteAction =
  | { type: 'navigate'; view: Parameters<typeof navigate>[0]['view']; id?: string }
  | { type: 'search'; q: string }
  | { type: 'open-item'; id: string }
  | { type: 'refresh' }
  | { type: 'rescore' }
  | { type: 'theme'; theme: 'dark' | 'light' | 'system' }
  | { type: 'export'; format: 'markdown' | 'json' | 'csv' }
  | { type: 'shortcuts' }
  | { type: 'state'; state: 'saved' | 'shortlist' | 'archived' | 'trash' }
  | { type: 'star' }
  | { type: 'tag' }
  | { type: 'collect' }
  | { type: 'summarize' }
  | { type: 'translate' }
  | { type: 'digest' }
  | { type: 'filter-source'; source: string }
  | { type: 'filter-topic'; topic: string }

export function CommandPalette({
  open,
  onOpenChange,
  context,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: PaletteContext
}) {
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search, 160)

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  // Live results inside the palette: the fastest path from "I remember reading
  // something about X" to having it open.
  const { data: results, isFetching } = useQuery({
    queryKey: ['palette-search', debounced],
    queryFn: () => api.search({ q: debounced, limit: 7, mode: 'hybrid' }),
    enabled: open && debounced.trim().length >= 2,
    staleTime: 15_000,
  })

  const { data: collections } = useQuery({ queryKey: ['collections'], queryFn: api.collections, enabled: open })

  const act = (action: PaletteAction) => {
    onOpenChange(false)
    context.onAction(action)
  }

  const hasItem = Boolean(context.activeItem)
  const selectedCount = context.selectedIds.length

  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} width="max-w-[600px]">
      <Command
        label="Command palette"
        shouldFilter
        // cmdk's default filter is a fuzzy subsequence match, which is right for
        // command names; item results are filtered server-side and always shown.
        className="flex max-h-[64vh] flex-col"
      >
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
          <Search size={15} className="shrink-0 text-fg-quaternary" />
          <Command.Input
            value={search}
            onValueChange={setSearch}
            autoFocus
            placeholder="Search your library, or type a command…"
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-quaternary"
          />
          {isFetching && <Spinner size={13} className="text-fg-quaternary" />}
          <Kbd>esc</Kbd>
        </div>

        <Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          <Command.Empty className="px-3 py-8 text-center text-xs text-fg-quaternary">
            Nothing matches “{search}”.
          </Command.Empty>

          {/* library results first — they are what the user is usually after */}
          {results && results.items.length > 0 && (
            <Command.Group heading={<GroupHeading>In your library</GroupHeading>}>
              {results.items.map((item) => (
                <Row key={item.id} value={`item-${item.id} ${item.title}`} onSelect={() => act({ type: 'open-item', id: item.id })}>
                  <ScoreBadge score={item.score} size="xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-fg">{item.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-quaternary">
                      <span className="size-[5px] rounded-full" style={{ background: SOURCE_META[item.source].color }} />
                      {SOURCE_META[item.source].short}
                      <span className="tabular">{timeAgo(item.publishedAt ?? item.capturedAt)}</span>
                      {results.matchedBy[item.id] === 'semantic' && <Badge tone="info">semantic</Badge>}
                    </span>
                  </span>
                </Row>
              ))}
              {search.trim().length >= 2 && (
                <Row value={`search-all ${search}`} onSelect={() => act({ type: 'search', q: search })}>
                  <Search size={13} className="text-fg-quaternary" />
                  <span className="text-xs">
                    Search all results for <span className="font-medium text-fg">{search}</span>
                  </span>
                </Row>
              )}
            </Command.Group>
          )}

          {/* item actions */}
          {(hasItem || selectedCount > 0) && (
            <Command.Group heading={<GroupHeading>{selectedCount > 0 ? `${selectedCount} selected` : 'This item'}</GroupHeading>}>
              <Row value="save keep bookmark" onSelect={() => act({ type: 'state', state: 'saved' })}>
                <Bookmark size={13} /> <span className="flex-1 text-xs">Save</span> <Keys k="s" />
              </Row>
              <Row value="shortlist later queue" onSelect={() => act({ type: 'state', state: 'shortlist' })}>
                <ListChecks size={13} /> <span className="flex-1 text-xs">Add to shortlist</span> <Keys k="l" />
              </Row>
              <Row value="star favourite" onSelect={() => act({ type: 'star' })}>
                <Star size={13} /> <span className="flex-1 text-xs">Toggle star</span> <Keys k="f" />
              </Row>
              <Row value="archive dismiss done" onSelect={() => act({ type: 'state', state: 'archived' })}>
                <Archive size={13} /> <span className="flex-1 text-xs">Archive</span> <Keys k="e" />
              </Row>
              <Row value="tag label" onSelect={() => act({ type: 'tag' })}>
                <TagIcon size={13} /> <span className="flex-1 text-xs">Tag…</span> <Keys k="t" />
              </Row>
              <Row value="collection add to board" onSelect={() => act({ type: 'collect' })}>
                <Layers size={13} /> <span className="flex-1 text-xs">Add to collection…</span> <Keys k="c" />
              </Row>
              <Row value="ai summary summarise" onSelect={() => act({ type: 'summarize' })}>
                <Sparkles size={13} /> <span className="flex-1 text-xs">AI summary</span> <Keys k="a" />
              </Row>
              <Row value="translate chinese english" onSelect={() => act({ type: 'translate' })}>
                <Languages size={13} /> <span className="flex-1 text-xs">Translate</span> <Keys k="r" />
              </Row>
              <Row value="trash delete remove" onSelect={() => act({ type: 'state', state: 'trash' })}>
                <Trash2 size={13} className="text-danger" /> <span className="flex-1 text-xs text-danger">Move to trash</span>
              </Row>
            </Command.Group>
          )}

          <Command.Group heading={<GroupHeading>Go to</GroupHeading>}>
            <Row value="inbox" onSelect={() => act({ type: 'navigate', view: 'inbox' })}>
              <Inbox size={13} /> <span className="flex-1 text-xs">Inbox</span> <Keys k="g i" />
            </Row>
            <Row value="today" onSelect={() => act({ type: 'navigate', view: 'today' })}>
              <Newspaper size={13} /> <span className="flex-1 text-xs">Today</span> <Keys k="g t" />
            </Row>
            <Row value="saved" onSelect={() => act({ type: 'navigate', view: 'saved' })}>
              <Bookmark size={13} /> <span className="flex-1 text-xs">Saved</span> <Keys k="g s" />
            </Row>
            <Row value="briefing digest daily" onSelect={() => act({ type: 'navigate', view: 'digest' })}>
              <Sparkles size={13} /> <span className="flex-1 text-xs">Briefing</span> <Keys k="g d" />
            </Row>
            <Row value="trends analytics charts" onSelect={() => act({ type: 'navigate', view: 'analytics' })}>
              <BarChart3 size={13} /> <span className="flex-1 text-xs">Trends</span> <Keys k="g a" />
            </Row>
            <Row value="ask chat question rag" onSelect={() => act({ type: 'navigate', view: 'ask' })}>
              <MessageSquareText size={13} /> <span className="flex-1 text-xs">Ask your library</span> <Keys k="g q" />
            </Row>
            <Row value="sources feeds connectors" onSelect={() => act({ type: 'navigate', view: 'sources' })}>
              <Rss size={13} /> <span className="flex-1 text-xs">Sources</span> <Keys k="g c" />
            </Row>
            <Row value="settings preferences" onSelect={() => act({ type: 'navigate', view: 'settings' })}>
              <SettingsIcon size={13} /> <span className="flex-1 text-xs">Settings</span> <Keys k="g ," />
            </Row>
            {collections?.collections.map((collection) => (
              <Row
                key={collection.id}
                value={`collection ${collection.name}`}
                onSelect={() => act({ type: 'navigate', view: 'collection', id: collection.id })}
              >
                <span className="w-3.5 text-center text-[11px]">{collection.icon ?? '◆'}</span>
                <span className="flex-1 text-xs">{collection.name}</span>
                <span className="tabular font-mono text-[10px] text-fg-quaternary">{collection.itemCount}</span>
              </Row>
            ))}
          </Command.Group>

          <Command.Group heading={<GroupHeading>Filter</GroupHeading>}>
            {Object.entries(SOURCE_META).slice(0, 8).map(([key, meta]) => (
              <Row key={key} value={`filter source ${meta.label}`} onSelect={() => act({ type: 'filter-source', source: key })}>
                <span className="size-[7px] rounded-full" style={{ background: meta.color }} />
                <span className="flex-1 text-xs">Only {meta.label}</span>
              </Row>
            ))}
            {TOPICS.slice(0, 10).map((topic) => (
              <Row key={topic.id} value={`filter topic ${topic.label}`} onSelect={() => act({ type: 'filter-topic', topic: topic.id })}>
                <span className="size-[7px] rounded-full bg-accent-600" />
                <span className="flex-1 text-xs">Topic: {topic.label}</span>
              </Row>
            ))}
          </Command.Group>

          <Command.Group heading={<GroupHeading>Actions</GroupHeading>}>
            <Row value="refresh sources poll fetch" onSelect={() => act({ type: 'refresh' })}>
              <RefreshCw size={13} /> <span className="flex-1 text-xs">Refresh all sources</span> <Keys k="mod+enter" />
            </Row>
            <Row value="generate briefing digest now" onSelect={() => act({ type: 'digest' })}>
              <Sparkles size={13} /> <span className="flex-1 text-xs">Generate a briefing now</span>
            </Row>
            <Row value="rescore recompute signal" onSelect={() => act({ type: 'rescore' })}>
              <BarChart3 size={13} /> <span className="flex-1 text-xs">Recompute all signal scores</span>
            </Row>
            <Row value="export markdown" onSelect={() => act({ type: 'export', format: 'markdown' })}>
              <Download size={13} /> <span className="flex-1 text-xs">Export current view as Markdown</span>
            </Row>
            <Row value="export json" onSelect={() => act({ type: 'export', format: 'json' })}>
              <Download size={13} /> <span className="flex-1 text-xs">Export current view as JSON</span>
            </Row>
            <Row value="export csv" onSelect={() => act({ type: 'export', format: 'csv' })}>
              <Download size={13} /> <span className="flex-1 text-xs">Export current view as CSV</span>
            </Row>
            <Row value="theme dark" onSelect={() => act({ type: 'theme', theme: 'dark' })}>
              <Moon size={13} /> <span className="flex-1 text-xs">Dark theme</span>
            </Row>
            <Row value="theme light" onSelect={() => act({ type: 'theme', theme: 'light' })}>
              <Sun size={13} /> <span className="flex-1 text-xs">Light theme</span>
            </Row>
            <Row value="keyboard shortcuts help" onSelect={() => act({ type: 'shortcuts' })}>
              <Kbd>?</Kbd> <span className="flex-1 text-xs">Keyboard shortcuts</span>
            </Row>
          </Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  )
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-fg-quaternary">{children}</span>
}

function Row({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-fg-secondary
        data-[selected=true]:bg-bg-active data-[selected=true]:text-fg"
    >
      {children}
    </Command.Item>
  )
}

function Keys({ k }: { k: string }) {
  return (
    <span className="flex shrink-0 gap-0.5">
      {formatKeys(k).map((key, index) => (
        <Kbd key={index}>{key}</Kbd>
      ))}
    </span>
  )
}

/* -------------------------------------------------------- shortcuts sheet -- */

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof SHORTCUTS>()
    for (const shortcut of SHORTCUTS) {
      const list = map.get(shortcut.group)
      if (list) list.push(shortcut)
      else map.set(shortcut.group, [shortcut])
    }
    return [...map.entries()]
  }, [])

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Single keys work whenever no text field has focus." width="max-w-2xl">
      <div className="grid gap-x-8 gap-y-5 p-4 sm:grid-cols-2">
        {groups.map(([group, shortcuts]) => (
          <section key={group}>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-fg-quaternary">{group}</h3>
            <dl className="space-y-1">
              {shortcuts.map((shortcut) => (
                <div key={shortcut.keys} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-fg-secondary">{shortcut.label}</dt>
                  <dd className="flex shrink-0 gap-0.5">
                    {shortcut.keys.split(' ').map((key, index) => (
                      <Kbd key={index}>{key}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}

/* --------------------------------------------------------------- tag sheet -- */

export function TagDialog({
  open,
  onClose,
  item,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  item?: ItemSummary
  onSaved: () => void
}) {
  const [tags, setTags] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: api.facets, enabled: open })

  useEffect(() => {
    if (open && item) {
      setTags(item.tags)
      setDraft('')
    }
  }, [open, item])

  if (!item) return null

  const commit = async (next: string[]) => {
    setTags(next)
    try {
      await api.setTags(item.id, next)
      onSaved()
    } catch (error) {
      toast.error('Could not save tags', { description: (error as Error).message })
    }
  }

  const add = (tag: string) => {
    const clean = tag.trim().replace(/^#/, '')
    if (!clean || tags.includes(clean)) return
    void commit([...tags, clean])
    setDraft('')
  }

  const suggestions = (facets?.tags ?? []).map((t) => t.value).filter((t) => !tags.includes(t)).slice(0, 12)

  return (
    <Dialog open={open} onClose={onClose} title="Tags" description={item.title.slice(0, 80)}>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => void commit(tags.filter((t) => t !== tag))}
              className="group inline-flex items-center gap-1 rounded-md border border-accent-600/30 bg-accent-muted px-2 py-1 text-2xs text-accent transition-colors hover:border-danger/40 hover:text-danger"
            >
              #{tag}
              <span className="opacity-50 group-hover:opacity-100">×</span>
            </button>
          ))}
          {!tags.length && <span className="text-xs text-fg-quaternary">No tags yet.</span>}
        </div>

        <Input
          autoFocus
          value={draft}
          placeholder="Add a tag and press Enter…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add(draft)
            if (event.key === 'Backspace' && !draft && tags.length) void commit(tags.slice(0, -1))
          }}
        />

        {suggestions.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-quaternary">Existing tags</p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => add(tag)}
                  className="rounded-md border border-border-subtle bg-bg-subtle px-2 py-1 text-2xs text-fg-tertiary transition-colors hover:border-border hover:text-fg"
                >
                  #{tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------- collection sheet -- */

export function CollectDialog({
  open,
  onClose,
  itemIds,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  itemIds: string[]
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const { data } = useQuery({ queryKey: ['collections'], queryFn: api.collections, enabled: open })

  const addTo = async (collectionId: string) => {
    try {
      await api.addToCollection(collectionId, itemIds)
      toast.success(`Added ${itemIds.length} item${itemIds.length === 1 ? '' : 's'}`)
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
      onSaved()
      onClose()
    } catch (error) {
      toast.error('Could not add to collection', { description: (error as Error).message })
    }
  }

  const create = async () => {
    if (!name.trim()) return
    const { collection } = await api.createCollection({ name: name.trim() })
    await addTo(collection.id)
    setName('')
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to collection"
      description={`${itemIds.length} item${itemIds.length === 1 ? '' : 's'} selected`}
    >
      <div className="space-y-1 p-2">
        {data?.collections.map((collection) => (
          <button
            key={collection.id}
            type="button"
            onClick={() => void addTo(collection.id)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-hover"
          >
            <span className="w-4 text-center text-xs">{collection.icon ?? '◆'}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-fg">{collection.name}</span>
              {collection.description && (
                <span className="block truncate text-[10px] text-fg-quaternary">{collection.description}</span>
              )}
            </span>
            <span className="tabular font-mono text-[10px] text-fg-quaternary">{collection.itemCount}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2 border-t border-border-subtle p-3">
        <Input
          value={name}
          placeholder="New collection…"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void create()}
        />
        <Button variant="primary" icon={<Plus size={13} />} onClick={() => void create()} disabled={!name.trim()}>
          Create
        </Button>
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------- share card -- */

export function ShareDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item?: ItemSummary }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [busy, setBusy] = useState(false)
  if (!item) return null

  const svgUrl = `/api/export/card/${item.id}?theme=${theme}`

  /**
   * Rasterise in-page rather than server-side: no headless browser, no canvas
   * binding, and the bitmap the user gets is exactly the SVG they previewed.
   */
  const downloadPng = async () => {
    setBusy(true)
    try {
      const response = await fetch(svgUrl)
      const svgText = await response.text()
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const image = new Image()
      image.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Could not render the card'))
        image.src = url
      })
      // 2x for retina.
      const canvas = document.createElement('canvas')
      canvas.width = 2400
      canvas.height = 1260
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)

      const link = document.createElement('a')
      link.download = `sift-${item.id}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
      toast.success('Card downloaded')
    } catch (error) {
      toast.error('Could not export the card', { description: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const copyMarkdown = () => {
    const md = `[${item.title}](${item.url}) — signal ${item.score}${item.author?.handle ? ` · @${item.author.handle}` : ''}`
    void navigator.clipboard.writeText(md).then(() => toast.success('Markdown copied'))
  }

  return (
    <Dialog open={open} onClose={onClose} title="Share" description="Rendered locally — nothing is uploaded." width="max-w-2xl">
      <div className="p-4">
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-inset">
          <img src={svgUrl} alt="Share card preview" className="block w-full" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {(['dark', 'light'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                className={cx(
                  'rounded-[5px] px-2.5 py-1 text-2xs capitalize transition-colors',
                  theme === option ? 'bg-bg-active text-fg' : 'text-fg-tertiary hover:text-fg',
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <Button icon={busy ? <Spinner size={13} /> : <Download size={13} />} onClick={() => void downloadPng()} disabled={busy}>
            Download PNG
          </Button>
          <Button icon={<Copy size={13} />} onClick={copyMarkdown}>
            Copy Markdown
          </Button>
          <Button
            icon={<Copy size={13} />}
            onClick={() => void navigator.clipboard.writeText(item.url).then(() => toast.success('Link copied'))}
          >
            Copy link
          </Button>
          <a
            href={svgUrl}
            download={`sift-${item.id}.svg`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2.5 text-xs font-medium text-fg transition-colors hover:bg-bg-hover"
          >
            <Download size={13} /> SVG
          </a>
        </div>
      </div>
    </Dialog>
  )
}
