/**
 * First run.
 *
 * The hardest state to design for: a tool whose entire value is a corpus, and
 * there is no corpus. Three real choices, no tour, no modal carousel — and the
 * demo-data path exists so the product can be *judged* before it is configured.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowRight, Check, Database, Loader2, Puzzle, Rss, Sparkles } from 'lucide-react'
import { api } from '../lib/api.ts'
import { navigate } from '../lib/router.ts'
import { Badge, Button, cx } from './ui.tsx'
import { toast } from 'sonner'

const INTEREST_PRESETS = [
  'LLM inference optimisation',
  'AI agents and tool use',
  'Open-weights model releases',
  'Prompt injection and AI security',
  'Local and on-device models',
  'RL post-training',
  'Multimodal and vision models',
  'AI coding tools',
  'Robotics and embodied AI',
  'Chips and compute',
  'Evals and benchmarks',
  'AI policy and regulation',
]

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [interests, setInterests] = useState<string[]>([])

  const saveInterests = useMutation({
    mutationFn: () => api.saveSettings({ interests }),
  })

  const seedSources = useMutation({
    mutationFn: async () => {
      await api.seedDefaultSources()
      return api.refreshAll()
    },
    onSuccess: (result) => {
      toast.success(`Collected ${result.collected} items from public sources`)
      onDone()
      navigate({ view: 'inbox', id: undefined, item: undefined })
    },
    onError: (error) => toast.error('Could not reach the sources', { description: (error as Error).message }),
  })

  const toggle = (interest: string) =>
    setInterests((prev) => (prev.includes(interest) ? prev.filter((i) => i !== interest) : [...prev, interest]))

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl">
        {/* brand */}
        <div className="mb-7 flex items-center gap-2.5">
          <svg width="22" height="22" viewBox="0 0 24 24" className="text-accent">
            <path d="M2 12 L12 2 L22 12 L12 22 Z" fill="currentColor" />
          </svg>
          <div>
            <h1 className="text-base font-semibold tracking-[-0.015em] text-fg">Sift</h1>
            <p className="text-[10px] uppercase tracking-wider text-fg-quaternary">Signal intelligence for technologists</p>
          </div>
          <Badge tone="success" className="ml-auto">
            local-first
          </Badge>
        </div>

        {step === 0 && (
          <div className="animate-slide-up">
            <h2 className="text-balance text-2xl font-semibold leading-tight tracking-[-0.02em] text-fg">
              Your library is empty. Let's fix that in about twenty seconds.
            </h2>
            <p className="text-pretty mt-3 text-[13px] leading-relaxed text-fg-secondary">
              Sift collects AI news from across the web, scores every item for how much it actually deserves your
              attention, and keeps everything in one SQLite file on this machine. No account, no cloud, no telemetry.
            </p>

            <div className="mt-6 space-y-2">
              <Choice
                icon={<Rss size={16} />}
                title="Connect the curated sources"
                description="13 public feeds — Hacker News, arXiv, GitHub, Hugging Face papers, Simon Willison, Import AI, Interconnects, r/LocalLLaMA and more. No API keys."
                badge="recommended"
                onClick={() => setStep(1)}
              />
              <Choice
                icon={<Database size={16} />}
                title="Load a demo corpus instead"
                description="37 realistic items across X, Xiaohongshu, HN, arXiv and GitHub — including duplicates and engagement bait, so you can see the scoring and dedup actually working."
                onClick={() => {
                  toast.info('Run `pnpm seed` in your terminal', {
                    description: 'The demo corpus ships with the repo and loads in about a second.',
                    duration: 8000,
                  })
                }}
              />
              <Choice
                icon={<Puzzle size={16} />}
                title="Install the browser extension"
                description="Capture from X and Xiaohongshu using your own logged-in session. Load it unpacked from apps/extension/.output/chrome-mv3."
                onClick={() => navigate({ view: 'sources', id: undefined, item: undefined })}
              />
            </div>

            <p className="mt-5 text-[11px] leading-relaxed text-fg-quaternary">
              Everything is reversible. You can add, remove and re-weight sources at any time, and delete the whole
              database with one command.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="animate-slide-up">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">Step 2 of 2</p>
            <h2 className="text-balance text-xl font-semibold leading-tight tracking-[-0.02em] text-fg">
              What do you actually want to hear about?
            </h2>
            <p className="text-pretty mt-2 text-[13px] leading-relaxed text-fg-secondary">
              This seeds the relevance term in the signal score. Pick as many as you like — Sift also learns from what
              you save, so a rough answer now is fine and it gets sharper on its own.
            </p>

            <div className="mt-5 flex flex-wrap gap-1.5">
              {INTEREST_PRESETS.map((interest) => {
                const active = interests.includes(interest)
                return (
                  <button
                    key={interest}
                    type="button"
                    onClick={() => toggle(interest)}
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-all duration-[140ms]',
                      active
                        ? 'border-accent-600 bg-accent-muted text-accent'
                        : 'border-border-subtle bg-bg-subtle text-fg-tertiary hover:border-border hover:text-fg',
                    )}
                  >
                    {active && <Check size={11} strokeWidth={3} />}
                    {interest}
                  </button>
                )
              })}
            </div>

            <div className="mt-7 flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                trailing={seedSources.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                disabled={seedSources.isPending}
                onClick={() => {
                  if (interests.length) saveInterests.mutate()
                  seedSources.mutate()
                }}
              >
                {seedSources.isPending ? 'Collecting your first items…' : 'Start collecting'}
              </Button>
              <Button size="md" onClick={() => setStep(0)} disabled={seedSources.isPending}>
                Back
              </Button>
              {interests.length > 0 && (
                <span className="text-2xs text-fg-quaternary">{interests.length} selected</span>
              )}
            </div>

            {seedSources.isPending && (
              <p className="mt-3 flex items-center gap-2 text-[11px] text-fg-quaternary">
                <Sparkles size={11} className="text-accent" />
                Fetching from 13 sources, deduplicating, and scoring. This takes a few seconds.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Choice({
  icon,
  title,
  description,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full gap-3 rounded-xl border border-border-subtle bg-bg-subtle p-3.5 text-left transition-all duration-[180ms] ease-[var(--ease-out-quart)] hover:border-accent-600/40 hover:bg-bg-hover"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-inset text-fg-tertiary transition-colors group-hover:border-accent-600/30 group-hover:text-accent">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-fg">{title}</span>
          {badge && <Badge tone="accent">{badge}</Badge>}
        </span>
        <span className="text-pretty mt-1 block text-[11.5px] leading-relaxed text-fg-tertiary">{description}</span>
      </span>
      <ArrowRight
        size={14}
        className="mt-1 shrink-0 text-fg-quaternary transition-transform duration-[180ms] group-hover:translate-x-0.5 group-hover:text-accent"
      />
    </button>
  )
}
