/**
 * The reader pane.
 *
 * Three jobs, in priority order: render the item's text well, make every AI
 * action one keystroke away, and show *why* this item scored what it did. The
 * third is what makes the ranking trustworthy rather than magical.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KIND_META,
  SOURCE_META,
  compactNumber,
  displayUrl,
  formatDateTime,
  formatDuration,
  initials,
  timeAgo,
  topicLabel,
  type ItemSummary,
  type ScoreBreakdown,
} from '@sift/core'
import {
  Archive,
  Bookmark,
  BookmarkCheck,
  Copy,
  ExternalLink,
  Highlighter,
  Image as ImageIcon,
  Info,
  Languages,
  Link2,
  ListChecks,
  Loader2,
  Share2,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { api, streamPost } from '../lib/api.ts'
import { Badge, Button, IconButton, ScoreBadge, Skeleton, Tooltip, cx } from './ui.tsx'
import { MiniRow } from './FeedList.tsx'
import { toast } from 'sonner'

/* ------------------------------------------------------------ why popover -- */

const COMPONENT_LABELS: { key: keyof ScoreBreakdown; label: string; hint: string }[] = [
  { key: 'relevance', label: 'Relevance', hint: 'Closeness to your interests and saved items' },
  { key: 'velocity', label: 'Velocity', hint: 'Attention per hour, normalised against this source' },
  { key: 'depth', label: 'Depth', hint: 'Evidence: numbers, code, citations, hedged claims' },
  { key: 'novelty', label: 'Novelty', hint: 'How unlike everything already in your library' },
  { key: 'authority', label: 'Authority', hint: 'Author reach, plus how often you keep their posts' },
  { key: 'recency', label: 'Recency', hint: 'Freshness, with a 36-hour half-life by default' },
]

function ScoreExplainer({ breakdown, reasons, score }: { breakdown: ScoreBreakdown; reasons: string[]; score: number }) {
  return (
    <div className="w-[320px] p-3">
      <div className="mb-3 flex items-center gap-2.5">
        <ScoreBadge score={score} size="lg" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-fg">Signal score</p>
          <p className="text-2xs text-fg-tertiary">Six weighted components, tunable in Settings</p>
        </div>
      </div>

      <div className="space-y-2">
        {COMPONENT_LABELS.map(({ key, label, hint }) => {
          const value = breakdown[key] as number
          const weight = breakdown.weights[key as string] ?? 0
          return (
            <div key={key as string}>
              <div className="flex items-baseline justify-between text-2xs">
                <Tooltip label={hint}>
                  <span className="cursor-help text-fg-secondary decoration-dotted underline-offset-2 hover:underline">
                    {label}
                  </span>
                </Tooltip>
                <span className="tabular font-mono text-fg-quaternary">
                  {Math.round(value * 100)}
                  <span className="ml-1 opacity-60">×{weight.toFixed(2)}</span>
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-inset">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-[380ms] ease-[var(--ease-out-expo)]"
                  style={{ width: `${Math.round(value * 100)}%`, opacity: 0.35 + weight * 2 }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {breakdown.noise > 0.05 && (
        <div className="mt-3 rounded-md border border-warning/25 bg-warning-muted px-2 py-1.5 text-2xs text-warning">
          Noise penalty −{Math.round(Math.min(0.3, breakdown.noise * 0.4) * 100)}% for engagement-bait patterns
        </div>
      )}

      {reasons.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border-subtle pt-2.5">
          {reasons.map((reason) => (
            <li key={reason} className="flex gap-1.5 text-2xs leading-relaxed text-fg-tertiary">
              <span className="mt-[5px] size-1 shrink-0 rounded-full bg-fg-quaternary" />
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- AI panel -- */

type AiState = { text: string; streaming: boolean; error?: string; kind: 'summary' | 'translation' | null }

function AiOutput({
  state,
  onDismiss,
  onEdit,
}: {
  state: AiState
  onDismiss: () => void
  onEdit?: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(state.text)
  useEffect(() => setDraft(state.text), [state.text])

  if (!state.text && !state.streaming && !state.error) return null

  return (
    <div className="animate-slide-up mb-5 overflow-hidden rounded-lg border border-accent-600/25 bg-[color-mix(in_oklab,var(--accent-muted)_45%,transparent)]">
      <div className="flex items-center gap-2 border-b border-accent-600/20 px-3 py-2">
        <Sparkles size={12} className="text-accent" />
        <span className="text-2xs font-semibold uppercase tracking-wider text-accent">
          {state.kind === 'translation' ? 'Translation' : 'AI summary'}
        </span>
        {state.streaming && <Loader2 size={11} className="animate-spin text-accent" />}
        <div className="ml-auto flex items-center gap-0.5">
          {onEdit && !state.streaming && state.text && (
            <IconButton
              title={editing ? 'Save edit' : 'Edit'}
              size="xs"
              onClick={() => {
                if (editing) onEdit(draft)
                setEditing(!editing)
              }}
            >
              <Highlighter size={11} />
            </IconButton>
          )}
          <IconButton title="Dismiss" size="xs" onClick={onDismiss}>
            <X size={11} />
          </IconButton>
        </div>
      </div>

      <div className="px-3 py-2.5">
        {state.error && (
          <p className="mb-2 text-xs text-danger">
            {state.error}
            <span className="ml-1 text-fg-tertiary">Falling back to a local extractive summary.</span>
          </p>
        )}
        {editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            className="w-full resize-y rounded-md border border-border bg-bg-inset p-2 text-xs text-fg focus:outline-none"
          />
        ) : (
          <p
            className={cx(
              'whitespace-pre-wrap text-[13px] leading-relaxed text-fg-secondary',
              state.streaming && 'streaming-caret',
            )}
          >
            {state.text}
          </p>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- reader -- */

export type ReaderProps = {
  itemId: string
  onClose: () => void
  onNavigate: (direction: 1 | -1) => void
  onStateChange: () => void
  onOpenItem: (id: string) => void
  onShare: (item: ItemSummary) => void
  onTag: (item: ItemSummary) => void
  onCollect: (item: ItemSummary) => void
  registerActions: (actions: ReaderActions | null) => void
}

/** Actions the reader exposes so global hotkeys can drive it. */
export type ReaderActions = {
  summarize: () => void
  translate: () => void
  takeaways: () => void
  toggleWhy: () => void
  copyLink: () => void
}

export function Reader({
  itemId,
  onClose,
  onNavigate,
  onStateChange,
  onOpenItem,
  onShare,
  onTag,
  onCollect,
  registerActions,
}: ReaderProps) {
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const openedAt = useRef(Date.now())
  const [showWhy, setShowWhy] = useState(false)
  const [ai, setAi] = useState<AiState>({ text: '', streaming: false, kind: null })
  const [takeaways, setTakeaways] = useState<string[] | null>(null)
  const [takeawaysLoading, setTakeawaysLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => api.item(itemId),
    staleTime: 30_000,
  })

  const item = data?.item

  // Reset per-item transient state, and reset the dwell timer.
  useEffect(() => {
    setShowWhy(false)
    setAi({ text: '', streaming: false, kind: null })
    setTakeaways(null)
    openedAt.current = Date.now()
    scrollRef.current?.scrollTo({ top: 0 })
    return () => abortRef.current?.abort()
  }, [itemId])

  // Show any previously generated AI output immediately.
  useEffect(() => {
    if (item?.aiSummary) setAi({ text: item.aiSummary, streaming: false, kind: 'summary' })
    if (item?.aiTakeaways?.length) setTakeaways(item.aiTakeaways)
  }, [item?.aiSummary, item?.aiTakeaways])

  // Mark read after 1.2s of dwell — long enough that arrowing past does not
  // count as reading, short enough that a real read always registers.
  useEffect(() => {
    if (!item || item.readAt) return
    const timer = setTimeout(() => {
      void api.markRead([itemId], true, Math.round((Date.now() - openedAt.current) / 1000)).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['counts'] })
        onStateChange()
      })
    }, 1200)
    return () => clearTimeout(timer)
  }, [item, itemId, queryClient, onStateChange])

  const mutateState = useMutation({
    mutationFn: (state: 'saved' | 'shortlist' | 'archived' | 'trash') => api.setState([itemId], state),
    onSuccess: (_result, state) => {
      void queryClient.invalidateQueries({ queryKey: ['item', itemId] })
      void queryClient.invalidateQueries({ queryKey: ['counts'] })
      onStateChange()
      toast.success(state === 'saved' ? 'Saved' : state === 'archived' ? 'Archived' : `Moved to ${state}`)
    },
  })

  const stream = useCallback(
    (path: string, body: unknown, kind: 'summary' | 'translation') => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setAi({ text: '', streaming: true, kind })
      void streamPost(
        path,
        body,
        {
          onDelta: (chunk) => setAi((prev) => ({ ...prev, text: prev.text + chunk })),
          onError: (message) => setAi((prev) => ({ ...prev, error: message, streaming: false })),
          onDone: () => {
            setAi((prev) => ({ ...prev, streaming: false }))
            void queryClient.invalidateQueries({ queryKey: ['item', itemId] })
          },
        },
        controller.signal,
      )
    },
    [itemId, queryClient],
  )

  const summarize = useCallback(() => stream('/ai/summarize', { itemId, force: false }, 'summary'), [stream, itemId])

  const translate = useCallback(() => {
    const target = item?.lang === 'zh' ? 'en' : 'zh'
    stream('/ai/translate', { itemId, target }, 'translation')
  }, [stream, itemId, item?.lang])

  const loadTakeaways = useCallback(async () => {
    if (takeaways?.length) {
      setTakeaways(null)
      return
    }
    setTakeawaysLoading(true)
    try {
      const result = await api.takeaways(itemId)
      setTakeaways(result.takeaways)
    } catch (error) {
      toast.error('Could not extract takeaways', { description: (error as Error).message })
    } finally {
      setTakeawaysLoading(false)
    }
  }, [itemId, takeaways])

  const copyLink = useCallback(() => {
    if (!item) return
    void navigator.clipboard.writeText(item.url).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy'),
    )
  }, [item])

  // Expose actions to the global hotkey map.
  useEffect(() => {
    registerActions({
      summarize,
      translate,
      takeaways: () => void loadTakeaways(),
      toggleWhy: () => setShowWhy((v) => !v),
      copyLink,
    })
    return () => registerActions(null)
  }, [registerActions, summarize, translate, loadTakeaways, copyLink])

  const readingTime = useMemo(() => (item ? formatDuration(item.readingTimeSec) : ''), [item])

  if (isLoading || !item) {
    return (
      <div className="flex h-full flex-col">
        <div className="hairline-b flex h-11 items-center gap-2 px-3">
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex-1 space-y-3 p-6">
          <Skeleton className="h-7 w-[80%]" />
          <Skeleton className="h-4 w-[40%]" />
          <div className="pt-4" />
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-3.5" style={{ width: `${94 - index * 4}%` }} />
          ))}
        </div>
      </div>
    )
  }

  const source = SOURCE_META[item.source]
  const kind = KIND_META[item.kind]
  const saved = item.state === 'saved'
  const metrics = Object.entries(item.metrics).filter(([, value]) => typeof value === 'number' && value > 0)

  return (
    <article className="flex h-full min-w-0 flex-col bg-bg">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <header className="hairline-b flex h-11 shrink-0 items-center gap-1 bg-bg/85 px-2 backdrop-blur-md">
        <IconButton title="Close reader (Esc)" size="sm" onClick={onClose}>
          <X size={15} />
        </IconButton>
        <div className="mx-0.5 h-4 w-px bg-border-subtle" />
        <IconButton title="Previous (K)" size="sm" onClick={() => onNavigate(-1)}>
          <span className="text-xs">↑</span>
        </IconButton>
        <IconButton title="Next (J)" size="sm" onClick={() => onNavigate(1)}>
          <span className="text-xs">↓</span>
        </IconButton>

        <div className="mx-1 h-4 w-px bg-border-subtle" />

        <IconButton title={saved ? 'Saved (S)' : 'Save (S)'} active={saved} onClick={() => mutateState.mutate('saved')}>
          {saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
        </IconButton>
        <IconButton
          title={item.starred ? 'Unstar (F)' : 'Star (F)'}
          active={item.starred}
          onClick={() => {
            void api.setStarred([itemId], !item.starred).then(() => {
              void queryClient.invalidateQueries({ queryKey: ['item', itemId] })
              onStateChange()
            })
          }}
        >
          <Star size={15} fill={item.starred ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton title="Archive (E)" onClick={() => mutateState.mutate('archived')}>
          <Archive size={15} />
        </IconButton>
        <IconButton title="Tag (T)" onClick={() => onTag(item)}>
          <Tag size={15} />
        </IconButton>
        <IconButton title="Add to collection (C)" onClick={() => onCollect(item)}>
          <ListChecks size={15} />
        </IconButton>

        <div className="mx-1 h-4 w-px bg-border-subtle" />

        <IconButton title="AI summary (A)" onClick={summarize}>
          <Sparkles size={15} />
        </IconButton>
        <IconButton title={`Translate to ${item.lang === 'zh' ? 'English' : 'Chinese'} (R)`} onClick={translate}>
          <Languages size={15} />
        </IconButton>
        <IconButton title="Key takeaways (I)" active={Boolean(takeaways)} onClick={() => void loadTakeaways()}>
          {takeawaysLoading ? <Loader2 size={15} className="animate-spin" /> : <ListChecks size={15} />}
        </IconButton>

        <div className="ml-auto flex items-center gap-0.5">
          <IconButton title="Copy link (Y)" onClick={copyLink}>
            <Link2 size={15} />
          </IconButton>
          <IconButton title="Share card (⇧S)" onClick={() => onShare(item)}>
            <Share2 size={15} />
          </IconButton>
          <IconButton title="Move to trash (#)" onClick={() => mutateState.mutate('trash')}>
            <Trash2 size={15} />
          </IconButton>
          <IconButton
            title="Open original (O)"
            onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink size={15} />
          </IconButton>
        </div>
      </header>

      {/* ── body ────────────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[74ch] px-6 py-7 md:px-10">
          {/* meta */}
          <div className="mb-4 flex flex-wrap items-center gap-2 text-2xs">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-subtle px-2 py-1">
              <span className="size-[6px] rounded-full" style={{ background: source.color }} />
              <span className="text-fg-secondary">{source.label}</span>
            </span>
            <Badge>{kind.label}</Badge>
            {item.lang && item.lang !== 'und' && <Badge>{item.lang.toUpperCase()}</Badge>}
            {item.echoCount > 0 && <Badge tone="info">{item.echoCount} other sources</Badge>}
            <span className="text-fg-quaternary" title={formatDateTime(item.publishedAt)}>
              {timeAgo(item.publishedAt ?? item.capturedAt)}
            </span>
            {readingTime && <span className="text-fg-quaternary">· {readingTime} read</span>}

            <span className="relative ml-auto">
              <button
                type="button"
                onClick={() => setShowWhy((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-subtle px-1.5 py-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg"
              >
                <ScoreBadge score={item.score} size="xs" />
                <span>why?</span>
                <Info size={10} />
              </button>
              {showWhy && item.scoreBreakdown && (
                <>
                  <span className="fixed inset-0 z-40" onClick={() => setShowWhy(false)} />
                  <span className="surface-overlay animate-scale-in absolute right-0 top-[calc(100%+6px)] z-50 block rounded-lg">
                    <ScoreExplainer breakdown={item.scoreBreakdown} reasons={data.why} score={item.score} />
                  </span>
                </>
              )}
            </span>
          </div>

          <h1 className="text-balance text-2xl font-semibold leading-[1.22] tracking-[-0.02em] text-fg">{item.title}</h1>

          {/* author */}
          {item.author && (
            <div className="mt-4 flex items-center gap-2.5">
              {item.author.avatarUrl ? (
                <img
                  src={item.author.avatarUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="size-7 rounded-full border border-border-subtle object-cover"
                />
              ) : (
                <span className="flex size-7 items-center justify-center rounded-full border border-border-subtle bg-bg-subtle text-2xs font-semibold text-fg-tertiary">
                  {initials(item.author.name || item.author.handle || '?')}
                </span>
              )}
              <div className="min-w-0 text-xs">
                <p className="truncate font-medium text-fg-secondary">
                  {item.author.name || item.author.handle}
                  {item.author.handle && item.author.name && (
                    <span className="ml-1.5 font-normal text-fg-quaternary">@{item.author.handle}</span>
                  )}
                </p>
                {item.author.followers != null && (
                  <p className="text-2xs text-fg-quaternary">{compactNumber(item.author.followers)} followers</p>
                )}
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto truncate font-mono text-2xs text-fg-quaternary underline decoration-dotted underline-offset-2 hover:text-accent"
              >
                {displayUrl(item.url, 34)}
              </a>
            </div>
          )}

          <div className="my-5 h-px bg-border-subtle" />

          <AiOutput
            state={ai}
            onDismiss={() => setAi({ text: '', streaming: false, kind: null })}
            onEdit={(text) => {
              void api
                .item(itemId)
                .then(() =>
                  fetch(`/api/items/${itemId}/ai`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(ai.kind === 'translation' ? { translation: text } : { summary: text }),
                  }),
                )
                .then(() => {
                  setAi((prev) => ({ ...prev, text }))
                  toast.success('Edit saved')
                })
            }}
          />

          {takeaways && takeaways.length > 0 && (
            <div className="animate-slide-up mb-5 rounded-lg border border-border-subtle bg-bg-subtle p-3">
              <p className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-tertiary">
                <ListChecks size={11} /> Takeaways
              </p>
              <ul className="space-y-1.5">
                {takeaways.map((takeaway, index) => (
                  <li key={index} className="flex gap-2 text-[13px] leading-relaxed text-fg-secondary">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />
                    {takeaway}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* media */}
          {item.media.length > 0 && (
            <div
              className={cx(
                'mb-5 grid gap-2',
                item.media.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
              )}
            >
              {item.media.slice(0, 4).map((media, index) => (
                <a
                  key={index}
                  href={media.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative block overflow-hidden rounded-lg border border-border-subtle bg-bg-inset"
                >
                  {media.type === 'image' || media.type === 'gif' ? (
                    <img
                      src={media.thumbUrl ?? media.url}
                      alt={media.alt ?? ''}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition-transform duration-[380ms] ease-[var(--ease-out-expo)] group-hover:scale-[1.02]"
                    />
                  ) : (
                    <span className="flex aspect-video items-center justify-center text-fg-quaternary">
                      <ImageIcon size={20} />
                    </span>
                  )}
                </a>
              ))}
            </div>
          )}

          {/* body text */}
          <div className="prose-sift" lang={item.lang === 'zh' ? 'zh' : undefined}>
            {(item.content ?? item.summary ?? '').split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>

          {/* highlights */}
          {data.highlights.length > 0 && (
            <section className="mt-8">
              <p className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-tertiary">
                <Highlighter size={11} /> Your highlights
              </p>
              <div className="space-y-2">
                {data.highlights.map((highlight) => (
                  <blockquote
                    key={highlight.id}
                    className="rounded-md border-l-2 border-warning bg-warning-muted/40 px-3 py-2 text-xs leading-relaxed text-fg-secondary"
                  >
                    {highlight.text}
                    {highlight.note && <p className="mt-1.5 text-2xs text-fg-tertiary">— {highlight.note}</p>}
                  </blockquote>
                ))}
              </div>
            </section>
          )}

          {/* facts strip */}
          <footer className="mt-8 space-y-4 border-t border-border-subtle pt-5">
            {metrics.length > 0 && (
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-2xs">
                {metrics.map(([key, value]) => (
                  <span key={key} className="text-fg-quaternary">
                    <span className="tabular font-mono text-fg-secondary">{compactNumber(value as number)}</span> {key}
                  </span>
                ))}
              </div>
            )}

            {(item.topics.length > 0 || item.tags.length > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {item.topics.map((topic) => (
                  <Badge key={topic} tone="accent">
                    {topicLabel(topic)}
                  </Badge>
                ))}
                {item.tags.map((tag) => (
                  <Badge key={tag}>#{tag}</Badge>
                ))}
              </div>
            )}

            {item.entities.length > 0 && (
              <div>
                <p className="mb-1.5 text-2xs uppercase tracking-wider text-fg-quaternary">Mentioned</p>
                <div className="flex flex-wrap gap-1.5">
                  {item.entities.slice(0, 14).map((entity) => (
                    <span
                      key={entity.name}
                      className="rounded-[5px] border border-border-subtle bg-bg-subtle px-1.5 py-0.5 text-2xs text-fg-tertiary"
                      title={entity.type}
                    >
                      {entity.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {data.collections.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-quaternary">
                In:
                {data.collections.map((collection) => (
                  <Badge key={collection.id} tone="info">
                    {collection.icon} {collection.name}
                  </Badge>
                ))}
              </div>
            )}
          </footer>

          {/* similar */}
          {data.similar.length > 0 && (
            <section className="mt-8 border-t border-border-subtle pt-5">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-fg-tertiary">Related in your library</p>
              <div className="-mx-2 space-y-0.5">
                {data.similar.map((similar) => (
                  <MiniRow key={similar.id} item={similar} onClick={() => onOpenItem(similar.id)} />
                ))}
              </div>
            </section>
          )}

          <div className="h-16" />
        </div>
      </div>
    </article>
  )
}

/** Shown in the reader slot when nothing is open. */
export function ReaderPlaceholder({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <svg width="34" height="34" viewBox="0 0 24 24" className="mb-4 text-fg-quaternary opacity-40">
        <path d="M2 12 L12 2 L22 12 L12 22 Z" fill="currentColor" />
      </svg>
      <p className="text-sm font-medium text-fg-tertiary">
        {hasItems ? 'Select an item to read' : 'Nothing to read yet'}
      </p>
      <p className="mt-1.5 max-w-[34ch] text-xs leading-relaxed text-fg-quaternary">
        {hasItems ? (
          <>
            Use <kbd className="font-mono">J</kbd> / <kbd className="font-mono">K</kbd> to move and{' '}
            <kbd className="font-mono">↵</kbd> to open. Press <kbd className="font-mono">?</kbd> for every shortcut.
          </>
        ) : (
          'Connect a source or install the browser extension to start collecting.'
        )}
      </p>
    </div>
  )
}
