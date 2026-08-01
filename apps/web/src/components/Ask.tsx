/**
 * Ask: retrieval-augmented chat over the user's own library.
 *
 * The design constraint that shapes everything here — every claim must be
 * traceable. Citations arrive *before* the first token, rendered as real, clickable
 * items, so the user can see what the model was shown and check it. An answer with
 * no visible provenance is worse than no answer, because it looks the same as a
 * good one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, MessageSquareText, Quote, RotateCcw, Square, Sparkles } from 'lucide-react'
import { SOURCE_META, type ChatCitation } from '@sift/core'
import { api, streamChat } from '../lib/api.ts'
import { navigate } from '../lib/router.ts'
import { Badge, Button, EmptyState, IconButton, ScoreBadge, Textarea, cx } from './ui.tsx'

type Turn = {
  role: 'user' | 'assistant'
  content: string
  citations?: ChatCitation[]
  streaming?: boolean
  error?: string
}

const SUGGESTIONS = [
  'What changed in inference efficiency this month?',
  'Summarise everything I saved about agent security',
  'Which open-weights releases did I capture, and how do they compare?',
  '我收藏的内容里，关于本地部署有哪些结论？',
]

/** Renders `[3]` as a clickable citation chip inline in the answer. */
function AnswerText({ text, citations, onOpen }: { text: string; citations: ChatCitation[]; onOpen: (id: string) => void }) {
  const parts = text.split(/(\[\d{1,3}\])/g)
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\[(\d{1,3})\]$/.exec(part)
        if (!match) return <span key={index}>{part}</span>
        const citation = citations[Number(match[1]) - 1]
        if (!citation) return <span key={index}>{part}</span>
        return (
          <button
            key={index}
            type="button"
            onClick={() => onOpen(citation.itemId)}
            title={citation.title}
            className="mx-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[4px] border border-accent-600/40 bg-accent-muted px-1 align-baseline font-mono text-[9px] font-semibold text-accent transition-colors hover:border-accent hover:brightness-125"
          >
            {match[1]}
          </button>
        )
      })}
    </>
  )
}

export function Ask({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: aiStatus } = useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus })
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health })

  // Follow the stream, but only while the user is already near the bottom —
  // yanking the viewport away from something they scrolled up to read is rude.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160
    if (nearBottom) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [turns])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = useCallback(
    (question: string) => {
      const trimmed = question.trim()
      if (!trimmed || streaming) return

      const history: Turn[] = [...turns, { role: 'user', content: trimmed }]
      setTurns([...history, { role: 'assistant', content: '', streaming: true }])
      setDraft('')
      setStreaming(true)

      const controller = new AbortController()
      abortRef.current = controller

      void streamChat(
        {
          messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
          topK: 12,
        },
        {
          onCitations: (citations) =>
            setTurns((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last) next[next.length - 1] = { ...last, citations }
              return next
            }),
          onDelta: (chunk) =>
            setTurns((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last) next[next.length - 1] = { ...last, content: last.content + chunk }
              return next
            }),
          onError: (message) =>
            setTurns((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last) next[next.length - 1] = { ...last, error: message, streaming: false }
              return next
            }),
          onDone: () => {
            setTurns((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last) next[next.length - 1] = { ...last, streaming: false }
              return next
            })
            setStreaming(false)
          },
        },
        controller.signal,
      )
    },
    [turns, streaming],
  )

  const stop = () => {
    abortRef.current?.abort()
    setStreaming(false)
    setTurns((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last) next[next.length - 1] = { ...last, streaming: false }
      return next
    })
  }

  const empty = turns.length === 0
  const itemCount = health?.db.items ?? 0

  return (
    <div className="flex h-full flex-col">
      <header className="hairline-b flex h-11 shrink-0 items-center gap-2 px-4">
        <MessageSquareText size={14} className="text-accent" />
        <h1 className="text-[13px] font-semibold text-fg">Ask your library</h1>
        {aiStatus && (
          <Badge tone={aiStatus.configured ? 'success' : 'neutral'}>
            {aiStatus.configured ? `${aiStatus.provider} · ${aiStatus.model}` : 'retrieval only'}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {turns.length > 0 && (
            <IconButton title="New conversation" onClick={() => setTurns([])}>
              <RotateCcw size={14} />
            </IconButton>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[72ch] px-6 py-6">
          {empty ? (
            <div className="pt-6">
              <div className="mb-5 flex size-10 items-center justify-center rounded-xl border border-accent-600/25 bg-accent-muted text-accent">
                <Sparkles size={18} />
              </div>
              <h2 className="text-balance text-lg font-semibold tracking-[-0.015em] text-fg">
                Ask anything about the {itemCount ? itemCount.toLocaleString() : ''} items you have collected.
              </h2>
              <p className="text-pretty mt-2 max-w-[54ch] text-xs leading-relaxed text-fg-tertiary">
                Answers are grounded in your own corpus and cite the items they came from. Nothing is answered from
                outside your library — if it is not in there, Sift says so.
                {!aiStatus?.configured && (
                  <>
                    {' '}
                    Without an AI provider configured, this returns the matching items instead of written prose.{' '}
                    <button
                      type="button"
                      onClick={() => navigate({ view: 'settings', id: undefined, item: undefined })}
                      className="text-accent underline decoration-dotted underline-offset-2"
                    >
                      Add a key in Settings
                    </button>
                    .
                  </>
                )}
              </p>

              <div className="mt-5 space-y-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    className="group flex w-full items-center gap-2.5 rounded-lg border border-border-subtle bg-bg-subtle px-3 py-2.5 text-left text-xs text-fg-secondary transition-colors hover:border-border hover:bg-bg-hover hover:text-fg"
                  >
                    <ArrowUp size={12} className="shrink-0 rotate-45 text-fg-quaternary transition-colors group-hover:text-accent" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {turns.map((turn, index) =>
                turn.role === 'user' ? (
                  <div key={index} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-bg-elevated px-3.5 py-2.5 text-[13px] leading-relaxed text-fg">
                      {turn.content}
                    </p>
                  </div>
                ) : (
                  <div key={index} className="animate-fade-in">
                    {/* Citations render before the first token arrives, so the
                        user sees the evidence base while the answer is written. */}
                    {turn.citations && turn.citations.length > 0 && (
                      <div className="mb-3">
                        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-quaternary">
                          <Quote size={9} /> {turn.citations.length} sources from your library
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {turn.citations.map((citation, citationIndex) => (
                            <button
                              key={citation.itemId}
                              type="button"
                              onClick={() => onOpenItem(citation.itemId)}
                              className="group flex max-w-[280px] items-center gap-1.5 rounded-md border border-border-subtle bg-bg-subtle px-1.5 py-1 text-left transition-colors hover:border-accent-600/40 hover:bg-bg-hover"
                            >
                              <span className="flex size-[15px] shrink-0 items-center justify-center rounded-[4px] bg-accent-muted font-mono text-[9px] font-semibold text-accent">
                                {citationIndex + 1}
                              </span>
                              <span className="min-w-0 truncate text-[11px] text-fg-tertiary group-hover:text-fg-secondary">
                                {citation.title}
                              </span>
                              <span
                                className="size-[5px] shrink-0 rounded-full"
                                style={{ background: SOURCE_META[citation.source].color }}
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div
                      className={cx(
                        'prose-sift max-w-none text-[13.5px] leading-[1.7]',
                        turn.streaming && !turn.content && 'text-fg-quaternary',
                      )}
                    >
                      {turn.content ? (
                        <p className={cx('whitespace-pre-wrap', turn.streaming && 'streaming-caret')}>
                          <AnswerText text={turn.content} citations={turn.citations ?? []} onOpen={onOpenItem} />
                        </p>
                      ) : turn.streaming ? (
                        <p className="flex items-center gap-2 text-xs">
                          <span className="size-1 animate-pulse rounded-full bg-accent" />
                          Searching your library…
                        </p>
                      ) : null}
                    </div>

                    {turn.error && (
                      <p className="mt-2 rounded-md border border-danger/25 bg-danger-muted px-2.5 py-1.5 text-xs text-danger">
                        {turn.error}
                      </p>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
          <div className="h-4" />
        </div>
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-border-subtle bg-bg px-6 py-3">
        <div className="mx-auto max-w-[72ch]">
          <div className="relative rounded-xl border border-border bg-bg-inset transition-colors focus-within:border-accent-600">
            <Textarea
              ref={inputRef}
              value={draft}
              rows={1}
              placeholder="Ask about anything you have collected…"
              onChange={(event) => {
                setDraft(event.target.value)
                // Grow to fit, capped so the composer never eats the transcript.
                const element = event.target as HTMLTextAreaElement
                element.style.height = 'auto'
                element.style.height = `${Math.min(160, element.scrollHeight)}px`
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  send(draft)
                }
              }}
              className="max-h-[160px] border-0 bg-transparent py-2.5 pr-11 focus:ring-0"
            />
            <div className="absolute bottom-1.5 right-1.5">
              {streaming ? (
                <IconButton title="Stop" size="md" onClick={stop}>
                  <Square size={13} fill="currentColor" />
                </IconButton>
              ) : (
                <button
                  type="button"
                  onClick={() => send(draft)}
                  disabled={!draft.trim()}
                  aria-label="Send"
                  className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-fg transition-all duration-[140ms] hover:brightness-110 active:scale-90 disabled:opacity-30"
                >
                  <ArrowUp size={14} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-fg-quaternary">
            Grounded in your library only · <kbd className="font-mono">⇧↵</kbd> for a new line
          </p>
        </div>
      </div>
    </div>
  )
}

/** The briefing view — a generated digest with citations back into the corpus. */
export function DigestView({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const [generating, setGenerating] = useState(false)
  const { data, refetch } = useQuery({ queryKey: ['digest-latest'], queryFn: api.latestDigest })
  const { data: itemsData } = useQuery({
    queryKey: ['digest-items', data?.digest?.id],
    queryFn: () => api.itemsByIds(data!.digest!.itemIds),
    enabled: Boolean(data?.digest?.itemIds.length),
  })

  const generate = async (hours: number) => {
    setGenerating(true)
    try {
      await api.generateDigest({ hours, maxItems: 12 })
      await refetch()
    } finally {
      setGenerating(false)
    }
  }

  const digest = data?.digest
  const itemById = new Map((itemsData?.items ?? []).map((item) => [item.id, item]))

  if (!digest) {
    return (
      <EmptyState
        icon={<Sparkles size={18} />}
        title="No briefing yet"
        description="A briefing groups the period's highest-signal items into themes and cites each one. Sift generates one automatically each morning."
        action={
          <Button variant="primary" onClick={() => void generate(24)} disabled={generating}>
            {generating ? 'Generating…' : 'Generate one now'}
          </Button>
        }
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[74ch] px-6 py-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Badge tone={digest.generator === 'ai' ? 'accent' : 'neutral'}>
                {digest.generator === 'ai' ? 'AI-written' : 'assembled locally'}
              </Badge>
              <span className="text-2xs text-fg-quaternary">
                {new Date(digest.periodFrom).toLocaleDateString()} → {new Date(digest.periodTo).toLocaleDateString()}
              </span>
            </div>
            <h1 className="text-balance text-2xl font-semibold leading-tight tracking-[-0.02em] text-fg">{digest.title}</h1>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" onClick={() => void generate(24)} disabled={generating}>
              {generating ? '…' : 'Today'}
            </Button>
            <Button size="sm" onClick={() => void generate(168)} disabled={generating}>
              Week
            </Button>
            <a
              href={`/api/export/digest-card/${digest.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center rounded-md border border-border bg-bg-elevated px-2.5 text-xs font-medium text-fg transition-colors hover:bg-bg-hover"
            >
              Card
            </a>
          </div>
        </div>

        <p className="text-pretty text-[15px] leading-[1.7] text-fg-secondary">{digest.lede}</p>

        <div className="mt-7 space-y-7">
          {digest.sections.map((section, index) => (
            <section key={index}>
              <h2 className="mb-2 text-base font-semibold tracking-[-0.015em] text-fg">{section.heading}</h2>
              <div className="prose-sift max-w-none text-[13.5px]">
                {section.body.split('\n').map((line, lineIndex) => (
                  <p key={lineIndex} className="whitespace-pre-wrap">
                    <AnswerText
                      text={line}
                      citations={digest.itemIds.map((id) => {
                        const item = itemById.get(id)
                        return {
                          itemId: id,
                          title: item?.title ?? id,
                          url: item?.url ?? '',
                          source: item?.source ?? 'web',
                          snippet: '',
                          score: item?.score ?? 0,
                        }
                      })}
                      onOpen={onOpenItem}
                    />
                  </p>
                ))}
              </div>
              {section.itemIds.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {section.itemIds.map((id) => {
                    const item = itemById.get(id)
                    if (!item) return null
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onOpenItem(id)}
                        className="flex max-w-[300px] items-center gap-1.5 rounded-md border border-border-subtle bg-bg-subtle px-1.5 py-1 transition-colors hover:border-accent-600/40"
                      >
                        <ScoreBadge score={item.score} size="xs" />
                        <span className="truncate text-[11px] text-fg-tertiary">{item.title}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          ))}
        </div>

        <div className="h-16" />
      </div>
    </div>
  )
}
