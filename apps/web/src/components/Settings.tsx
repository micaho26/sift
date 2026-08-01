/**
 * Sources and Settings.
 *
 * Settings is where the ranking becomes the user's rather than ours. The weight
 * sliders are not a power-user escape hatch — they are the mechanism by which a
 * generic scorer becomes personal, so they are front and centre with a live
 * preview of what changes.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
  Zap,
} from 'lucide-react'
import { DEFAULT_WEIGHTS, SOURCE_META, timeAgo, type ScoringWeights, type Settings as SettingsType, type SourceKind } from '@sift/core'
import { api } from '../lib/api.ts'
import { Badge, Button, EmptyState, IconButton, Input, SectionTitle, Slider, Spinner, Switch, cx } from './ui.tsx'
import { toast } from 'sonner'

/* ---------------------------------------------------------------- sources -- */

const ADDABLE: { kind: SourceKind; label: string; placeholder: string; hint: string }[] = [
  { kind: 'rss', label: 'RSS / Atom feed', placeholder: 'https://example.com/feed.xml', hint: 'Any blog or newsletter feed.' },
  { kind: 'reddit', label: 'Subreddit', placeholder: 'LocalLLaMA', hint: 'Public JSON endpoint. No key needed.' },
  { kind: 'hackernews', label: 'Hacker News query', placeholder: 'ai OR llm OR openai', hint: 'Matched against story titles via Algolia.' },
  { kind: 'arxiv', label: 'arXiv query', placeholder: 'cat:cs.AI OR cat:cs.CL', hint: 'arXiv API search syntax.' },
  { kind: 'github', label: 'GitHub repo search', placeholder: 'topic:llm OR topic:ai-agents', hint: 'New repos gaining stars fast.' },
  { kind: 'huggingface', label: 'Hugging Face papers', placeholder: 'papers', hint: 'The community-curated daily list.' },
]

export function Sources() {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState<SourceKind | null>(null)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [runningId, setRunningId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({ queryKey: ['sources'], queryFn: api.sources })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['sources'] })
    void queryClient.invalidateQueries({ queryKey: ['counts'] })
  }

  const create = useMutation({
    mutationFn: () =>
      api.createSource({
        kind: adding!,
        name: name.trim() || target.trim(),
        target: target.trim(),
        intervalMinutes: adding === 'rss' ? 120 : 60,
      }),
    onSuccess: () => {
      setAdding(null)
      setTarget('')
      setName('')
      invalidate()
      toast.success('Source added — it will be polled shortly')
    },
    onError: (error) => toast.error('Could not add source', { description: (error as Error).message }),
  })

  const runOne = async (id: string) => {
    setRunningId(id)
    try {
      const result = await api.runSource(id)
      invalidate()
      if (result.error) toast.error('Source failed', { description: result.error })
      else toast.success(result.collected ? `${result.collected} new items` : 'No new items')
    } finally {
      setRunningId(null)
    }
  }

  if (isLoading) return <div className="p-6"><Spinner /></div>

  const pollable = data?.sources.filter((s) => s.pollable) ?? []
  const pushOnly = data?.sources.filter((s) => s.pushOnly) ?? []

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.015em] text-fg">Sources</h1>
            <p className="mt-0.5 text-xs text-fg-tertiary">
              Every connector here uses a public, keyless endpoint. X and Xiaohongshu arrive through the browser
              extension instead, because they need your own logged-in session.
            </p>
          </div>
          <Button
            variant="primary"
            icon={<Plus size={13} />}
            onClick={() => setAdding(adding ? null : 'rss')}
          >
            Add source
          </Button>
        </div>

        {adding && (
          <div className="animate-slide-up mb-5 rounded-lg border border-border bg-bg-subtle p-4">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {ADDABLE.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  onClick={() => setAdding(option.kind)}
                  className={cx(
                    'rounded-md border px-2 py-1 text-2xs transition-colors',
                    adding === option.kind
                      ? 'border-accent-600 bg-accent-muted text-accent'
                      : 'border-border-subtle bg-bg-inset text-fg-tertiary hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {(() => {
              const option = ADDABLE.find((o) => o.kind === adding)!
              return (
                <div className="space-y-2">
                  <Input
                    autoFocus
                    value={target}
                    placeholder={option.placeholder}
                    onChange={(event) => setTarget(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && target.trim() && create.mutate()}
                  />
                  <Input value={name} placeholder="Display name (optional)" onChange={(event) => setName(event.target.value)} />
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-fg-quaternary">{option.hint}</p>
                    <div className="flex gap-1.5">
                      <Button onClick={() => setAdding(null)}>Cancel</Button>
                      <Button variant="primary" disabled={!target.trim() || create.isPending} onClick={() => create.mutate()}>
                        {create.isPending ? 'Adding…' : 'Add'}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        )}

        <SectionTitle hint="Polled on a schedule. Trust multiplies the final signal score.">Polled sources</SectionTitle>
        <div className="mb-6 divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle">
          {pollable.map((source) => (
            <div key={source.id} className="group flex items-center gap-3 bg-bg-subtle px-3 py-2.5">
              <span className="size-[7px] shrink-0 rounded-full" style={{ background: SOURCE_META[source.kind].color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-xs font-medium text-fg">{source.name}</p>
                  {source.lastError && (
                    <Badge tone="danger">
                      <CircleAlert size={9} /> error
                    </Badge>
                  )}
                </div>
                <p className="truncate font-mono text-[10px] text-fg-quaternary">{source.target}</p>
                {source.lastError && <p className="mt-0.5 truncate text-[10px] text-danger">{source.lastError}</p>}
              </div>

              <div className="hidden shrink-0 text-right sm:block">
                <p className="tabular font-mono text-[10px] text-fg-tertiary">{source.itemsCollected} collected</p>
                <p className="text-[10px] text-fg-quaternary">
                  {source.lastRunAt ? timeAgo(source.lastRunAt) : 'never run'} · every {source.intervalMinutes}m
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <span className="tabular hidden w-8 text-right font-mono text-[10px] text-fg-quaternary lg:inline">
                  ×{source.trust.toFixed(2)}
                </span>
                <Switch
                  checked={source.enabled}
                  label={`Enable ${source.name}`}
                  onChange={(enabled) => {
                    void api.updateSource(source.id, { enabled }).then(invalidate)
                  }}
                />
                <IconButton title="Poll now" size="xs" disabled={runningId === source.id} onClick={() => void runOne(source.id)}>
                  {runningId === source.id ? <Spinner size={11} /> : <RefreshCw size={11} />}
                </IconButton>
                <IconButton
                  title="Remove"
                  size="xs"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => {
                    void api.deleteSource(source.id).then(() => {
                      invalidate()
                      toast.success('Source removed')
                    })
                  }}
                >
                  <Trash2 size={11} />
                </IconButton>
              </div>
            </div>
          ))}
          {!pollable.length && (
            <div className="bg-bg-subtle p-6">
              <EmptyState
                icon={<Rss size={16} />}
                title="No polled sources"
                description="Add a feed, or restore the curated default set."
                action={
                  <Button
                    variant="primary"
                    onClick={() => {
                      void api.seedDefaultSources().then((result) => {
                        invalidate()
                        toast.success(`${result.created} sources added`)
                      })
                    }}
                  >
                    Add the default set
                  </Button>
                }
              />
            </div>
          )}
        </div>

        <SectionTitle hint="These arrive from the browser extension, which reads what you can already see while logged in.">
          Pushed by the extension
        </SectionTitle>
        <div className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
          <div className="flex flex-wrap gap-2">
            {(['x', 'xiaohongshu', 'manual', 'web'] as SourceKind[]).map((kind) => (
              <span key={kind} className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-inset px-2 py-1 text-2xs text-fg-tertiary">
                <span className="size-[6px] rounded-full" style={{ background: SOURCE_META[kind].color }} />
                {SOURCE_META[kind].label}
              </span>
            ))}
          </div>
          {pushOnly.length > 0 && (
            <p className="mt-2.5 text-[10px] text-fg-quaternary">
              {pushOnly.reduce((sum, s) => sum + s.itemsCollected, 0)} items received so far.
            </p>
          )}
          <p className="mt-2.5 text-[11px] leading-relaxed text-fg-quaternary">
            Load the extension from <code className="font-mono text-fg-tertiary">apps/extension/.output/chrome-mv3</code> at{' '}
            <code className="font-mono text-fg-tertiary">chrome://extensions</code> with developer mode on. It captures from your
            own authenticated session and posts here over loopback — no credentials are shared, and nothing goes to a third
            party.
          </p>
        </div>

        <div className="h-10" />
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- settings -- */

const WEIGHT_META: { key: keyof ScoringWeights; label: string; hint: string }[] = [
  { key: 'relevance', label: 'Relevance', hint: 'Match to your interests and what you keep' },
  { key: 'velocity', label: 'Velocity', hint: 'How fast attention is accruing' },
  { key: 'depth', label: 'Depth', hint: 'Evidence: numbers, code, citations' },
  { key: 'novelty', label: 'Novelty', hint: 'Unlike anything already in your library' },
  { key: 'authority', label: 'Authority', hint: 'Author reach plus your own history with them' },
  { key: 'recency', label: 'Recency', hint: 'Freshness decay' },
]

export function Settings() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [draft, setDraft] = useState<SettingsType | null>(null)
  const [interestInput, setInterestInput] = useState('')
  const [mutedInput, setMutedInput] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (data?.settings && !dirty) setDraft(data.settings)
  }, [data?.settings, dirty])

  const save = useMutation({
    mutationFn: (patch: Partial<SettingsType>) => api.saveSettings(patch),
    onSuccess: (result) => {
      setDirty(false)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      void queryClient.invalidateQueries({ queryKey: ['health'] })
      toast.success(result.rescoring ? 'Saved — rescoring your library in the background' : 'Saved')
      if (result.rescoring) {
        // Scores will have moved, so anything showing them is now stale.
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['search'] }), 1500)
      }
    },
    onError: (error) => toast.error('Could not save', { description: (error as Error).message }),
  })

  if (isLoading || !draft) return <div className="p-6"><Spinner /></div>

  const patch = (changes: Partial<SettingsType>) => {
    setDraft({ ...draft, ...changes } as SettingsType)
    setDirty(true)
  }

  const weightSum = Object.values(draft.weights).reduce((sum, value) => sum + value, 0)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.015em] text-fg">Settings</h1>
            <p className="mt-0.5 text-xs text-fg-tertiary">Stored in your local database. Nothing is synced anywhere.</p>
          </div>
          {dirty && (
            <Button variant="primary" icon={save.isPending ? <Spinner size={13} /> : <Check size={13} />} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </div>

        {/* interests */}
        <section className="mb-7">
          <SectionTitle hint="Seeds the relevance term. Sift also learns from what you save, so this only needs to be roughly right.">
            What you care about
          </SectionTitle>
          <div className="rounded-lg border border-border-subtle bg-bg-subtle p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {draft.interests.map((interest) => (
                <button
                  key={interest}
                  type="button"
                  onClick={() => patch({ interests: draft.interests.filter((i) => i !== interest) })}
                  className="group inline-flex items-center gap-1 rounded-md border border-accent-600/30 bg-accent-muted px-2 py-1 text-2xs text-accent hover:border-danger/40 hover:text-danger"
                >
                  {interest}
                  <span className="opacity-50 group-hover:opacity-100">×</span>
                </button>
              ))}
              {!draft.interests.length && <span className="text-xs text-fg-quaternary">Nothing yet.</span>}
            </div>
            <Input
              value={interestInput}
              placeholder="e.g. LLM inference optimisation — press Enter"
              onChange={(event) => setInterestInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && interestInput.trim()) {
                  patch({ interests: [...draft.interests, interestInput.trim()] })
                  setInterestInput('')
                }
              }}
            />
          </div>
        </section>

        {/* weights */}
        <section className="mb-7">
          <SectionTitle hint="Six components, each 0–1, combined by these weights. Change one and the whole library is rescored.">
            How signal is scored
          </SectionTitle>
          <div className="space-y-3 rounded-lg border border-border-subtle bg-bg-subtle p-4">
            {WEIGHT_META.map(({ key, label, hint }) => (
              <div key={key}>
                <Slider
                  label={label}
                  value={draft.weights[key]}
                  min={0}
                  max={0.5}
                  step={0.01}
                  format={(value) => `${Math.round((value / Math.max(0.01, weightSum)) * 100)}%`}
                  onChange={(value) => patch({ weights: { ...draft.weights, [key]: value } })}
                />
                <p className="mt-0.5 text-[10px] text-fg-quaternary">{hint}</p>
              </div>
            ))}

            <div className="flex items-center justify-between border-t border-border-subtle pt-3">
              <p className="text-[10px] text-fg-quaternary">Weights are normalised, so only their ratios matter.</p>
              <Button
                size="xs"
                onClick={() => patch({ weights: { ...DEFAULT_WEIGHTS } })}
              >
                Reset to defaults
              </Button>
            </div>

            <div className="space-y-3 border-t border-border-subtle pt-3">
              <Slider
                label="Recency half-life"
                value={draft.recencyHalfLifeHours}
                min={4}
                max={336}
                step={4}
                format={(value) => (value >= 48 ? `${Math.round(value / 24)}d` : `${value}h`)}
                onChange={(value) => patch({ recencyHalfLifeHours: value })}
              />
              <Slider
                label="Inbox threshold"
                value={draft.inboxThreshold}
                min={0}
                max={80}
                format={(value) => `${value} / 100`}
                onChange={(value) => patch({ inboxThreshold: value })}
              />
              <p className="text-[10px] text-fg-quaternary">
                Items below the threshold are archived on arrival rather than discarded — they stay fully searchable.
              </p>
            </div>
          </div>
        </section>

        {/* AI */}
        <section className="mb-7">
          <SectionTitle hint="Entirely optional. Without a provider, summaries fall back to local extraction and Ask returns matching items.">
            AI provider
          </SectionTitle>
          <div className="space-y-3 rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <div className="flex flex-wrap gap-1.5">
              {(['none', 'anthropic', 'openai', 'ollama'] as const).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() =>
                    patch({
                      ai: {
                        ...draft.ai,
                        provider,
                        model:
                          provider === 'anthropic'
                            ? 'claude-sonnet-5'
                            : provider === 'openai'
                              ? 'gpt-5'
                              : provider === 'ollama'
                                ? 'llama3.2'
                                : draft.ai.model,
                      },
                    })
                  }
                  className={cx(
                    'rounded-md border px-2.5 py-1 text-2xs capitalize transition-colors',
                    draft.ai.provider === provider
                      ? 'border-accent-600 bg-accent-muted text-accent'
                      : 'border-border-subtle bg-bg-inset text-fg-tertiary hover:text-fg',
                  )}
                >
                  {provider}
                </button>
              ))}
            </div>

            {draft.ai.provider !== 'none' && (
              <>
                <Input value={draft.ai.model} placeholder="Model id" onChange={(event) => patch({ ai: { ...draft.ai, model: event.target.value } })} />

                {(draft.ai.provider === 'anthropic' || draft.ai.provider === 'openai') && (
                  <div className="flex gap-2">
                    <Input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      icon={<KeyRound size={12} />}
                      placeholder={data?.settings.ai.apiKeySet ? 'A key is set — type a new one to replace it' : 'API key'}
                      onChange={(event) => setApiKey(event.target.value)}
                      autoComplete="off"
                    />
                    <IconButton title={showKey ? 'Hide' : 'Show'} onClick={() => setShowKey(!showKey)}>
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </IconButton>
                    <Button
                      disabled={!apiKey.trim()}
                      onClick={() => {
                        const provider = draft.ai.provider as 'anthropic' | 'openai'
                        void api.saveKey(provider, apiKey.trim()).then(() => {
                          setApiKey('')
                          void queryClient.invalidateQueries({ queryKey: ['settings'] })
                          void queryClient.invalidateQueries({ queryKey: ['ai-status'] })
                          toast.success('Key stored locally — it is never returned by the API')
                        })
                      }}
                    >
                      Store
                    </Button>
                  </div>
                )}

                {draft.ai.provider === 'ollama' && (
                  <Input
                    value={draft.ai.baseUrl ?? 'http://127.0.0.1:11434'}
                    placeholder="http://127.0.0.1:11434"
                    onChange={(event) => patch({ ai: { ...draft.ai, baseUrl: event.target.value } })}
                  />
                )}

                <div className="flex items-center justify-between">
                  <span className="text-xs text-fg-secondary">Status</span>
                  <Badge tone={data?.ai.configured ? 'success' : 'warning'}>
                    {data?.ai.configured ? 'ready' : (data?.ai.reason ?? 'not configured')}
                  </Badge>
                </div>
              </>
            )}
          </div>
        </section>

        {/* embeddings */}
        <section className="mb-7">
          <SectionTitle hint="Powers semantic search, novelty detection and duplicate folding.">Embeddings</SectionTitle>
          <div className="space-y-3 rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { value: 'hash', label: 'Built-in', hint: 'Instant, offline, zero setup' },
                  { value: 'local', label: 'Local transformer', hint: 'Needs @huggingface/transformers' },
                  { value: 'ollama', label: 'Ollama', hint: 'nomic-embed-text' },
                  { value: 'openai', label: 'OpenAI', hint: 'text-embedding-3-small' },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => patch({ embeddings: { ...draft.embeddings, provider: option.value } })}
                  title={option.hint}
                  className={cx(
                    'rounded-md border px-2.5 py-1 text-2xs transition-colors',
                    draft.embeddings.provider === option.value
                      ? 'border-accent-600 bg-accent-muted text-accent'
                      : 'border-border-subtle bg-bg-inset text-fg-tertiary hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-fg-quaternary">
              The built-in embedder hashes character n-grams: no download, works offline, and handles Chinese and English
              alike. It captures lexical similarity rather than true paraphrase — switch to a transformer if you want
              "cheaper to run" to match "cost optimisation" by meaning. Changing this re-embeds your library in the
              background.
            </p>
          </div>
        </section>

        {/* appearance + data */}
        <section className="mb-7">
          <SectionTitle>Appearance</SectionTitle>
          <div className="space-y-3 rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-secondary">Density</span>
              <div className="flex rounded-md border border-border p-0.5">
                {(['comfortable', 'compact'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => patch({ density: option })}
                    className={cx(
                      'rounded-[5px] px-2.5 py-1 text-2xs capitalize transition-colors',
                      draft.density === option ? 'bg-bg-active text-fg' : 'text-fg-tertiary hover:text-fg',
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-secondary">Daily briefing</span>
              <Switch
                checked={draft.digest.enabled}
                label="Daily briefing"
                onChange={(enabled) => patch({ digest: { ...draft.digest, enabled } })}
              />
            </div>
          </div>
        </section>

        <section className="mb-7">
          <SectionTitle hint="Muted terms are dropped at ingestion — they never reach the inbox or the index.">Mute</SectionTitle>
          <div className="rounded-lg border border-border-subtle bg-bg-subtle p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {draft.mutedKeywords.map((keyword) => (
                <button
                  key={keyword}
                  type="button"
                  onClick={() => patch({ mutedKeywords: draft.mutedKeywords.filter((k) => k !== keyword) })}
                  className="group inline-flex items-center gap-1 rounded-md border border-border bg-bg-inset px-2 py-1 text-2xs text-fg-tertiary hover:border-danger/40 hover:text-danger"
                >
                  {keyword}
                  <span className="opacity-50 group-hover:opacity-100">×</span>
                </button>
              ))}
              {!draft.mutedKeywords.length && <span className="text-xs text-fg-quaternary">Nothing muted.</span>}
            </div>
            <Input
              value={mutedInput}
              placeholder="Keyword to mute — press Enter"
              onChange={(event) => setMutedInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && mutedInput.trim()) {
                  patch({ mutedKeywords: [...draft.mutedKeywords, mutedInput.trim()] })
                  setMutedInput('')
                }
              }}
            />
          </div>
        </section>

        <section className="mb-7">
          <SectionTitle>Your data</SectionTitle>
          <div className="space-y-2 rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <div className="flex flex-wrap gap-2">
              {(['markdown', 'json', 'csv'] as const).map((format) => (
                <Button
                  key={format}
                  icon={<Download size={13} />}
                  onClick={() => {
                    void (async () => {
                      const response = await api.exportItems({ format, query: { limit: 200 } })
                      const blob = await response.blob()
                      const url = URL.createObjectURL(blob)
                      const link = document.createElement('a')
                      link.href = url
                      link.download = `sift-export.${format === 'markdown' ? 'md' : format}`
                      link.click()
                      URL.revokeObjectURL(url)
                    })()
                  }}
                >
                  Export {format}
                </Button>
              ))}
              <a
                href="/api/export/opml"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2.5 text-xs font-medium text-fg transition-colors hover:bg-bg-hover"
              >
                <Download size={13} /> Feeds as OPML
              </a>
            </div>
            <Button
              icon={<Zap size={13} />}
              onClick={() => {
                void api.rescore().then((result) => {
                  void queryClient.invalidateQueries()
                  toast.success(`Rescored ${result.rescored} items in ${result.tookMs}ms`)
                })
              }}
            >
              Recompute all signal scores
            </Button>
            <p className="flex items-start gap-1.5 pt-1 text-[10px] leading-relaxed text-fg-quaternary">
              <AlertTriangle size={11} className="mt-px shrink-0" />
              Everything lives in <code className="font-mono">./data/sift.db</code>. Back it up by copying that file;
              delete it to start over with <code className="font-mono">pnpm db:reset</code>.
            </p>
          </div>
        </section>

        <div className="h-10" />
      </div>
    </div>
  )
}
