/**
 * The feed: a virtualised, keyboard-driven list.
 *
 * This is where the product lives or dies. Three things it must get right:
 *  1. Scroll at 60fps with thousands of rows — hence TanStack Virtual.
 *  2. Keyboard focus that *follows* selection without stealing scroll position,
 *     using scrollIntoView({block:'nearest'}) semantics via the virtualiser.
 *  3. Optimistic triage. Pressing `e` must remove the row immediately and offer
 *     undo; waiting 80ms for a round-trip before the row moves feels broken.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  KIND_META,
  SOURCE_META,
  compactNumber,
  displayUrl,
  scoreBand,
  timeAgo,
  topicLabel,
  type ItemSummary,
} from '@sift/core'
import {
  Bookmark,
  BookmarkCheck,
  Check,
  CircleDot,
  ExternalLink,
  Eye,
  Inbox,
  Layers,
  MessageSquare,
  Star,
  Archive as ArchiveIcon,
} from 'lucide-react'
import { Badge, IconButton, ScoreBadge, Skeleton, cx } from './ui.tsx'

export type FeedProps = {
  items: ItemSummary[]
  loading: boolean
  cursorIndex: number
  selected: Set<string>
  openId?: string
  matchedBy?: Record<string, 'keyword' | 'semantic' | 'both'>
  highlightTerms?: string[]
  density: 'comfortable' | 'compact'
  onOpen: (item: ItemSummary, index: number) => void
  onCursor: (index: number) => void
  onToggleSelect: (id: string) => void
  onSave: (item: ItemSummary) => void
  onStar: (item: ItemSummary) => void
  onArchive: (item: ItemSummary) => void
  onLoadMore?: () => void
  hasMore?: boolean
}

const ROW_HEIGHT = { comfortable: 96, compact: 62 } as const

/** Wrap query terms in <mark> without ever injecting HTML from the item. */
function Highlighted({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length || !text) return <>{text}</>
  // Longest first, so "context window" beats "context".
  const sorted = [...terms].filter((t) => t.length >= 2).sort((a, b) => b.length - a.length)
  if (!sorted.length) return <>{text}</>
  const pattern = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  let regex: RegExp
  try {
    regex = new RegExp(`(${pattern})`, 'gi')
  } catch {
    return <>{text}</>
  }
  const parts = text.split(regex)
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-[2px] bg-[var(--warning-muted)] px-[1px] text-fg">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}

const Row = memo(function Row({
  item,
  active,
  isOpen,
  isSelected,
  matched,
  terms,
  density,
  onOpen,
  onHover,
  onToggleSelect,
  onSave,
  onStar,
  onArchive,
}: {
  item: ItemSummary
  active: boolean
  isOpen: boolean
  isSelected: boolean
  matched?: 'keyword' | 'semantic' | 'both'
  terms?: string[]
  density: 'comfortable' | 'compact'
  onOpen: () => void
  onHover: () => void
  onToggleSelect: () => void
  onSave: () => void
  onStar: () => void
  onArchive: () => void
}) {
  const source = SOURCE_META[item.source]
  const kind = KIND_META[item.kind]
  const unread = !item.readAt
  const saved = item.state === 'saved'
  const compact = density === 'compact'
  const preview = item.aiSummary ?? item.summary ?? ''

  const engagement = useMemo(() => {
    const m = item.metrics
    const parts: { icon: typeof Eye; value: number }[] = []
    if (m.likes) parts.push({ icon: Star, value: m.likes })
    if (m.points) parts.push({ icon: CircleDot, value: m.points })
    if (m.stars) parts.push({ icon: Star, value: m.stars })
    if (m.comments ?? m.replies) parts.push({ icon: MessageSquare, value: (m.comments ?? m.replies)! })
    if (m.views) parts.push({ icon: Eye, value: m.views })
    return parts.slice(0, 2)
  }, [item.metrics])

  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onOpen}
      onPointerEnter={onHover}
      className={cx(
        'group relative flex cursor-default gap-3 border-b border-border-subtle px-3',
        compact ? 'items-center py-2' : 'py-2.5',
        'transition-colors duration-[120ms]',
        isOpen ? 'bg-accent-muted/40' : active ? 'bg-bg-hover' : 'hover:bg-bg-subtle',
      )}
    >
      {/* Active-row rail. Communicates keyboard focus without an outline that
          would fight the row's own borders. */}
      <span
        aria-hidden="true"
        className={cx(
          'absolute inset-y-0 left-0 w-[2px] transition-opacity duration-[140ms]',
          isOpen ? 'bg-accent opacity-100' : active ? 'bg-accent opacity-60' : 'opacity-0',
        )}
      />

      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-0.5">
        <button
          type="button"
          aria-label={isSelected ? 'Deselect' : 'Select'}
          onClick={(event) => {
            event.stopPropagation()
            onToggleSelect()
          }}
          className={cx(
            'flex size-4 items-center justify-center rounded-[4px] border transition-all duration-[140ms]',
            isSelected
              ? 'border-accent bg-accent text-accent-fg'
              : 'border-border-strong text-transparent opacity-0 hover:border-accent group-hover:opacity-100',
          )}
        >
          <Check size={10} strokeWidth={3} />
        </button>
        <ScoreBadge score={item.score} size={compact ? 'xs' : 'sm'} showBar={!compact} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {unread && <span aria-label="Unread" className="mt-[5px] size-[5px] shrink-0 rounded-full bg-accent" />}
          <h3
            className={cx(
              'min-w-0 flex-1 text-pretty text-[13.5px] leading-[1.35]',
              compact ? 'line-clamp-1' : 'line-clamp-2',
              unread ? 'font-semibold text-fg' : 'font-medium text-fg-secondary',
            )}
          >
            <Highlighted text={item.title} terms={terms} />
          </h3>
        </div>

        {!compact && preview && (
          <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-fg-tertiary">
            <Highlighted text={preview} terms={terms} />
          </p>
        )}

        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-2xs text-fg-quaternary">
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="size-[6px] rounded-full" style={{ background: source.color }} aria-hidden="true" />
            <span className="text-fg-tertiary">{source.short}</span>
          </span>

          {(item.author?.handle || item.author?.name) && (
            <span className="min-w-0 truncate text-fg-tertiary">
              {item.author.handle ? `@${item.author.handle}` : item.author.name}
            </span>
          )}

          <span className="shrink-0 tabular">{timeAgo(item.publishedAt ?? item.capturedAt)}</span>

          {engagement.map(({ icon: Icon, value }, index) => (
            <span key={index} className="hidden shrink-0 items-center gap-0.5 tabular sm:flex">
              <Icon size={9} />
              {compactNumber(value)}
            </span>
          ))}

          {item.echoCount > 0 && (
            <span className="hidden shrink-0 items-center gap-0.5 md:flex" title={`${item.echoCount} other sources reported this`}>
              <Layers size={9} />
              {item.echoCount}
            </span>
          )}

          {/* Topics degrade first at narrow widths — they are the least load-bearing. */}
          {!compact &&
            item.topics.slice(0, 2).map((topic) => (
              <span key={topic} className="hidden shrink-0 rounded-[4px] bg-bg-inset px-1.5 py-px text-fg-tertiary lg:inline">
                {topicLabel(topic)}
              </span>
            ))}

          {matched === 'semantic' && (
            <Badge tone="info" className="hidden shrink-0 xl:inline-flex">
              semantic
            </Badge>
          )}
          {item.kind !== 'post' && (
            <span className="ml-auto hidden shrink-0 text-fg-quaternary md:inline">{kind.label}</span>
          )}
        </div>
      </div>

      {/* Hover actions. Hidden until hover/focus so the row stays calm at rest. */}
      <div
        className={cx(
          'flex shrink-0 items-start gap-0.5 transition-opacity duration-[140ms]',
          'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          (active || item.starred || saved) && 'opacity-100',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton
          title={saved ? 'Saved' : 'Save (S)'}
          size="xs"
          active={saved}
          onClick={onSave}
        >
          {saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
        </IconButton>
        <IconButton title={item.starred ? 'Unstar (F)' : 'Star (F)'} size="xs" active={item.starred} onClick={onStar}>
          <Star size={13} fill={item.starred ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton title="Archive (E)" size="xs" onClick={onArchive}>
          <ArchiveIcon size={13} />
        </IconButton>
        <IconButton
          title="Open original (O)"
          size="xs"
          onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={13} />
        </IconButton>
      </div>
    </div>
  )
})

export function FeedList({
  items,
  loading,
  cursorIndex,
  selected,
  openId,
  matchedBy,
  highlightTerms,
  density,
  onOpen,
  onCursor,
  onToggleSelect,
  onSave,
  onStar,
  onArchive,
  onLoadMore,
  hasMore,
}: FeedProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: 8,
    getItemKey: (index) => items[index]?.id ?? index,
  })

  // Keep the keyboard cursor visible. 'auto' means "scroll the minimum needed",
  // which preserves the user's mental map of where they were.
  useEffect(() => {
    if (cursorIndex < 0 || cursorIndex >= items.length) return
    virtualizer.scrollToIndex(cursorIndex, { align: 'auto' })
  }, [cursorIndex, items.length, virtualizer])

  // Infinite scroll: fetch the next page when the last row is rendered.
  const virtualItems = virtualizer.getVirtualItems()
  const lastRendered = virtualItems[virtualItems.length - 1]?.index ?? 0
  useEffect(() => {
    if (hasMore && !loading && lastRendered >= items.length - 6 && items.length > 0) onLoadMore?.()
  }, [hasMore, loading, lastRendered, items.length, onLoadMore])

  const handleHover = useCallback(
    (index: number) => {
      // Hover does not move the keyboard cursor — that would make the mouse fight
      // the keyboard. It only prefetches.
      void index
    },
    [],
  )

  if (loading && !items.length) {
    return (
      <div className="divide-y divide-border-subtle" aria-busy="true" aria-label="Loading items">
        {Array.from({ length: 9 }).map((_, index) => (
          <div key={index} className="flex gap-3 px-3 py-3" style={{ opacity: 1 - index * 0.09 }}>
            <Skeleton className="size-6 shrink-0 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-[72%]" />
              <Skeleton className="h-3 w-[48%]" />
              <Skeleton className="h-2.5 w-[30%]" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto overflow-x-hidden" role="listbox" aria-label="Feed" tabIndex={-1}>
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index]
          if (!item) return null
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <Row
                item={item}
                active={virtualRow.index === cursorIndex}
                isOpen={item.id === openId}
                isSelected={selected.has(item.id)}
                matched={matchedBy?.[item.id]}
                terms={highlightTerms}
                density={density}
                onOpen={() => {
                  onCursor(virtualRow.index)
                  onOpen(item, virtualRow.index)
                }}
                onHover={() => handleHover(virtualRow.index)}
                onToggleSelect={() => onToggleSelect(item.id)}
                onSave={() => onSave(item)}
                onStar={() => onStar(item)}
                onArchive={() => onArchive(item)}
              />
            </div>
          )
        })}
      </div>

      {loading && items.length > 0 && (
        <div className="flex items-center justify-center gap-2 py-4 text-2xs text-fg-quaternary">
          <span className="size-1 animate-pulse rounded-full bg-accent" />
          Loading more
        </div>
      )}
      {!hasMore && items.length > 12 && (
        <div className="py-6 text-center text-2xs text-fg-quaternary">
          {items.length} items · end of list
        </div>
      )}
    </div>
  )
}

/** The row used inside compact lists (collections, similar items, citations). */
export function MiniRow({
  item,
  onClick,
  active,
}: {
  item: ItemSummary
  onClick?: () => void
  active?: boolean
}) {
  const source = SOURCE_META[item.source]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-[120ms]',
        active ? 'bg-accent-muted/40' : 'hover:bg-bg-hover',
      )}
    >
      <ScoreBadge score={item.score} size="xs" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-xs font-medium leading-snug text-fg-secondary">{item.title}</span>
        <span className="mt-1 flex items-center gap-1.5 text-2xs text-fg-quaternary">
          <span className="size-[5px] rounded-full" style={{ background: source.color }} />
          {source.short}
          <span className="tabular">{timeAgo(item.publishedAt ?? item.capturedAt)}</span>
          <span className="truncate">{displayUrl(item.url, 24)}</span>
        </span>
      </span>
    </button>
  )
}

/** Shown when a feed has no items — different copy per view. */
export function FeedEmpty({ view, onAction }: { view: string; onAction?: () => void }) {
  const copy: Record<string, { title: string; description: string; cta?: string }> = {
    inbox: {
      title: 'Inbox clear',
      description:
        'Nothing is waiting. New items arrive automatically from your sources, or push them in from the browser extension.',
      cta: 'Refresh sources',
    },
    today: {
      title: 'Nothing today yet',
      description: 'Items published in the last 24 hours will appear here as your sources are polled.',
      cta: 'Refresh sources',
    },
    shortlist: {
      title: 'Shortlist empty',
      description: 'Press L on anything in the inbox to queue it here for a closer look later.',
    },
    saved: {
      title: 'Nothing saved',
      description: 'Press S to keep something. Saved items also teach Sift what you care about, which sharpens scoring.',
    },
    starred: { title: 'No stars', description: 'Press F to star the things you will want to find again by name.' },
    archive: { title: 'Archive empty', description: 'Archived and low-signal items land here. They stay fully searchable.' },
    search: { title: 'No matches', description: 'Try fewer words, or switch the mode to semantic to search by meaning.' },
    collection: { title: 'Empty collection', description: 'Press C on any item to file it here.' },
  }
  const chosen = copy[view] ?? copy.inbox!
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border-subtle bg-bg-subtle text-fg-quaternary">
        <Inbox size={18} />
      </div>
      <h3 className="text-sm font-semibold text-fg">{chosen.title}</h3>
      <p className="text-pretty mt-1.5 max-w-[40ch] text-xs leading-relaxed text-fg-tertiary">{chosen.description}</p>
      {chosen.cta && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-bg-hover"
        >
          {chosen.cta}
        </button>
      )}
    </div>
  )
}
