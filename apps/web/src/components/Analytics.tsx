/**
 * Trends: what your corpus says that you did not explicitly ask.
 *
 * Charts are hand-drawn SVG. A charting library would be 60 KB for four chart
 * types, and none of them would match the design tokens without overrides.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, BarChart3, Minus, TrendingUp } from 'lucide-react'
import { SOURCE_META, compactNumber, formatDuration, topicLabel } from '@sift/core'
import { api } from '../lib/api.ts'
import { navigate } from '../lib/router.ts'
import { Badge, EmptyState, Skeleton, Sparkline, cx } from './ui.tsx'

const RANGES = [
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
]

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-subtle p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-fg-quaternary">{label}</p>
      <p className={cx('tabular mt-1.5 font-mono text-xl font-semibold', accent ? 'text-accent' : 'text-fg')}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-fg-quaternary">{sub}</p>}
    </div>
  )
}

/** Volume over time, as an area chart with a hover readout. */
function VolumeChart({ data }: { data: { bucket: number; count: number; avgScore: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 100
  const height = 30

  const { path, area, max } = useMemo(() => {
    if (data.length < 2) return { path: '', area: '', max: 0 }
    const maxCount = Math.max(...data.map((d) => d.count), 1)
    const step = width / (data.length - 1)
    const points = data.map((d, index) => [index * step, height - (d.count / maxCount) * (height - 2)] as const)
    // Catmull-Rom-ish smoothing via quadratic midpoints — smoother than
    // straight lines, and cannot overshoot below zero the way a cubic can.
    let line = `M ${points[0]![0]},${points[0]![1]}`
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1]!
      const [x1, y1] = points[i]!
      const mx = (x0 + x1) / 2
      line += ` Q ${x0},${y0} ${mx},${(y0 + y1) / 2}`
      if (i === points.length - 1) line += ` L ${x1},${y1}`
    }
    return { path: line, area: `${line} L ${width},${height} L 0,${height} Z`, max: maxCount }
  }, [data])

  if (!path) {
    return <div className="flex h-[120px] items-center justify-center text-xs text-fg-quaternary">Not enough data yet</div>
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[120px] w-full" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#vol)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        {data.map((point, index) => (
          <rect
            key={point.bucket}
            x={(index / Math.max(1, data.length - 1)) * width - width / data.length / 2}
            y={0}
            width={width / data.length}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}
        {hover !== null && (
          <line
            x1={(hover / Math.max(1, data.length - 1)) * width}
            y1="0"
            x2={(hover / Math.max(1, data.length - 1)) * width}
            y2={height}
            stroke="var(--border-strong)"
            strokeWidth="0.4"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="mt-1 flex items-baseline justify-between text-[10px] text-fg-quaternary">
        <span>{new Date(data[0]!.bucket).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        {hover !== null && data[hover] && (
          <span className="tabular font-mono text-fg-secondary">
            {data[hover]!.count} items · avg {data[hover]!.avgScore}
          </span>
        )}
        <span>peak {max}</span>
      </div>
    </div>
  )
}

function MomentumIcon({ momentum, isNew }: { momentum: number; isNew: boolean }) {
  if (isNew) return <Badge tone="accent">new</Badge>
  if (momentum > 1.25) return <ArrowUp size={11} className="text-success" />
  if (momentum < 0.8) return <ArrowDown size={11} className="text-fg-quaternary" />
  return <Minus size={11} className="text-fg-quaternary" />
}

export function Analytics() {
  const [days, setDays] = useState(30)
  const { data, isLoading } = useQuery({ queryKey: ['analytics', days], queryFn: () => api.analytics(days), staleTime: 60_000 })

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[76px] rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-[160px] rounded-lg" />
        <Skeleton className="h-[280px] rounded-lg" />
      </div>
    )
  }

  if (!data || data.totals.items === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={18} />}
        title="No data in this window"
        description="Trends need a few days of collected items before they say anything useful. Refresh your sources, or widen the range."
      />
    )
  }

  const maxSource = Math.max(...data.bySource.map((s) => s.count), 1)
  const maxEntity = Math.max(...data.entities.map((e) => e.count), 1)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
        {/* range switch */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.015em] text-fg">Trends</h1>
            <p className="mt-0.5 text-xs text-fg-tertiary">
              Computed locally from {compactNumber(data.totals.items)} items. Nothing leaves this machine.
            </p>
          </div>
          <div className="flex rounded-md border border-border p-0.5">
            {RANGES.map((range) => (
              <button
                key={range.days}
                type="button"
                onClick={() => setDays(range.days)}
                className={cx(
                  'rounded-[5px] px-2.5 py-1 font-mono text-2xs transition-colors',
                  days === range.days ? 'bg-bg-active text-fg' : 'text-fg-tertiary hover:text-fg',
                )}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>

        {/* stats */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Items collected" value={compactNumber(data.totals.items)} sub={`across ${data.totals.sources} sources`} />
          <Stat label="Kept" value={compactNumber(data.totals.saved)} sub={`${Math.round((data.totals.saved / Math.max(1, data.totals.items)) * 100)}% of everything seen`} accent />
          <Stat label="Read" value={compactNumber(data.totals.read)} sub={formatDuration(data.totals.readingTimeSec)} />
          <Stat label="Average signal" value={String(data.totals.avgScore)} sub="0–100" />
        </div>

        {/* volume */}
        <section className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
          <h2 className="mb-3 text-xs font-semibold text-fg">Collection volume</h2>
          <VolumeChart data={data.volume} />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* topic momentum */}
          <section className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <h2 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-fg">
              <TrendingUp size={12} className="text-accent" /> Topic momentum
            </h2>
            <p className="mb-3 text-[10px] text-fg-quaternary">
              This period's volume against the previous one. Ranked by growth weighted by size.
            </p>
            <div className="space-y-1">
              {data.topics.slice(0, 10).map((topic) => (
                <button
                  key={topic.topic}
                  type="button"
                  onClick={() => navigate({ view: 'search', id: undefined, item: undefined, query: { q: '', topics: [topic.topic] } })}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">{topicLabel(topic.topic)}</span>
                  <Sparkline values={topic.series} width={52} height={14} className="shrink-0 text-accent-400 opacity-70" />
                  <span className="tabular w-8 shrink-0 text-right font-mono text-[10px] text-fg-quaternary">{topic.total}</span>
                  <span className="flex w-14 shrink-0 items-center justify-end gap-1">
                    <MomentumIcon momentum={topic.momentum} isNew={topic.isNew} />
                    {!topic.isNew && (
                      <span
                        className={cx(
                          'tabular font-mono text-[10px]',
                          topic.momentum > 1.25 ? 'text-success' : topic.momentum < 0.8 ? 'text-fg-quaternary' : 'text-fg-tertiary',
                        )}
                      >
                        {topic.momentum.toFixed(1)}×
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* sources */}
          <section className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <h2 className="mb-3 text-xs font-semibold text-fg">Where it comes from</h2>
            <div className="space-y-2">
              {data.bySource.map((source) => {
                const meta = SOURCE_META[source.source]
                return (
                  <button
                    key={source.source}
                    type="button"
                    onClick={() => navigate({ view: 'search', id: undefined, item: undefined, query: { q: '', sources: [source.source] } })}
                    className="block w-full text-left"
                  >
                    <div className="flex items-baseline justify-between text-2xs">
                      <span className="flex items-center gap-1.5 text-fg-secondary">
                        <span className="size-[6px] rounded-full" style={{ background: meta.color }} />
                        {meta.label}
                      </span>
                      <span className="tabular font-mono text-fg-quaternary">
                        {source.count} · avg {source.avgScore}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-inset">
                      <div
                        className="h-full rounded-full transition-[width] duration-[520ms] ease-[var(--ease-out-expo)]"
                        style={{ width: `${(source.count / maxSource) * 100}%`, background: meta.color, opacity: 0.75 }}
                      />
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          {/* authors */}
          <section className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <h2 className="mb-1 text-xs font-semibold text-fg">Voices worth following</h2>
            <p className="mb-3 text-[10px] text-fg-quaternary">Ranked by average signal, weighted by how much they publish.</p>
            <div className="space-y-1">
              {data.topAuthors.slice(0, 9).map((author) => (
                <button
                  key={author.handle}
                  type="button"
                  onClick={() => navigate({ view: 'search', id: undefined, item: undefined, query: { q: '', authors: [author.handle] } })}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-fg-secondary">{author.name}</span>
                    <span className="text-[10px] text-fg-quaternary">
                      {author.count} items{author.saves > 0 && ` · you kept ${author.saves}`}
                    </span>
                  </span>
                  <span className="tabular shrink-0 font-mono text-xs text-accent">{author.avgScore}</span>
                </button>
              ))}
            </div>
          </section>

          {/* entities */}
          <section className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
            <h2 className="mb-3 text-xs font-semibold text-fg">What is being talked about</h2>
            <div className="flex flex-wrap gap-1.5">
              {data.entities.slice(0, 32).map((entity) => {
                const weight = entity.count / maxEntity
                return (
                  <button
                    key={entity.name}
                    type="button"
                    onClick={() => navigate({ view: 'search', id: undefined, item: undefined, query: { q: entity.name } })}
                    className="rounded-md border px-2 py-1 transition-colors hover:border-accent-600/50"
                    style={{
                      // Size and opacity both encode frequency, so the cloud is
                      // readable in greyscale too.
                      fontSize: `${10 + weight * 3}px`,
                      borderColor: weight > 0.5 ? 'var(--accent-600)' : 'var(--border-subtle)',
                      background: weight > 0.5 ? 'var(--accent-muted)' : 'var(--bg-inset)',
                      color: weight > 0.5 ? 'var(--accent)' : 'var(--fg-tertiary)',
                    }}
                    title={`${entity.name} · ${entity.type} · ${entity.count} mentions`}
                  >
                    {entity.name}
                    <span className="ml-1 opacity-50">{entity.count}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>

        {/* score distribution */}
        <section className="rounded-lg border border-border-subtle bg-bg-subtle p-4">
          <h2 className="mb-1 text-xs font-semibold text-fg">Signal distribution</h2>
          <p className="mb-3 text-[10px] text-fg-quaternary">
            A healthy corpus is right-skewed: most of what arrives is noise, and the tail is what you came for.
          </p>
          <div className="flex h-[90px] items-end gap-1">
            {Array.from({ length: 10 }).map((_, index) => {
              const bucket = data.scoreHistogram.find((h) => h.bucket === index * 10)
              const max = Math.max(...data.scoreHistogram.map((h) => h.count), 1)
              const count = bucket?.count ?? 0
              return (
                <div key={index} className="group flex flex-1 flex-col items-center gap-1">
                  <span className="tabular font-mono text-[9px] text-fg-quaternary opacity-0 transition-opacity group-hover:opacity-100">
                    {count}
                  </span>
                  <div
                    className="w-full rounded-t-sm transition-[height] duration-[520ms] ease-[var(--ease-out-expo)]"
                    style={{
                      height: `${Math.max(2, (count / max) * 62)}px`,
                      background:
                        index >= 8 ? 'var(--band-critical)' : index >= 6 ? 'var(--band-high)' : index >= 4 ? 'var(--accent)' : 'var(--border-strong)',
                      opacity: index >= 4 ? 0.85 : 0.5,
                    }}
                  />
                  <span className="font-mono text-[9px] text-fg-quaternary">{index * 10}</span>
                </div>
              )
            })}
          </div>
        </section>

        <div className="h-8" />
      </div>
    </div>
  )
}
