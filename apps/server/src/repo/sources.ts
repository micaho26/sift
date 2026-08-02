/**
 * Sources: connector configuration plus the per-source trust multiplier that
 * feeds scoring. Trust is cached because it is read once per ingested item.
 */
import { SourceConfig, defaultSourceTrust, type SourceKind } from '@sift/core'
import { all, get, newId, parseJson, run } from '../db/index.ts'

type SourceRow = {
  id: string
  kind: string
  name: string
  target: string
  enabled: number
  interval_minutes: number
  trust: number
  filters_json: string | null
  last_run_at: number | null
  last_error: string | null
  items_collected: number
  created_at: number
  position: number
}

function toConfig(row: SourceRow): SourceConfig {
  return {
    id: row.id,
    kind: row.kind as SourceKind,
    name: row.name,
    target: row.target,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    trust: row.trust,
    filters: parseJson(row.filters_json, {}),
    lastRunAt: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    itemsCollected: row.items_collected,
    createdAt: row.created_at,
  }
}

export function listSources(): SourceConfig[] {
  return all<SourceRow>('SELECT * FROM sources ORDER BY position, created_at').map(toConfig)
}

export function getSource(id: string): SourceConfig | null {
  const row = get<SourceRow>('SELECT * FROM sources WHERE id = ?', id)
  return row ? toConfig(row) : null
}

export function createSource(input: {
  kind: SourceKind
  name: string
  target: string
  intervalMinutes?: number
  trust?: number
  enabled?: boolean
  filters?: SourceConfig['filters']
}): SourceConfig {
  const id = newId('s_')
  const now = Date.now()
  const position = (get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM sources')?.n ?? 1) as number
  run(
    `INSERT INTO sources (id, kind, name, target, enabled, interval_minutes, trust, filters_json, items_collected, created_at, position)
     VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
    id,
    input.kind,
    input.name,
    input.target,
    input.enabled === false ? 0 : 1,
    input.intervalMinutes ?? 30,
    input.trust ?? defaultSourceTrust(input.kind),
    JSON.stringify(input.filters ?? {}),
    now,
    position,
  )
  invalidateTrustCache()
  return getSource(id)!
}

export function updateSource(id: string, patch: Partial<SourceConfig>): SourceConfig | null {
  const existing = getSource(id)
  if (!existing) return null
  run(
    `UPDATE sources SET
        name = ?, target = ?, enabled = ?, interval_minutes = ?, trust = ?, filters_json = ?
      WHERE id = ?`,
    patch.name ?? existing.name,
    patch.target ?? existing.target,
    (patch.enabled ?? existing.enabled) ? 1 : 0,
    patch.intervalMinutes ?? existing.intervalMinutes,
    patch.trust ?? existing.trust,
    JSON.stringify(patch.filters ?? existing.filters),
    id,
  )
  invalidateTrustCache()
  return getSource(id)
}

export function deleteSource(id: string): boolean {
  const result = run('DELETE FROM sources WHERE id = ?', id)
  invalidateTrustCache()
  return result.changes > 0
}

export function recordRun(id: string, outcome: { collected?: number; error?: string }): void {
  run(
    `UPDATE sources SET last_run_at = ?, last_error = ?, items_collected = items_collected + ? WHERE id = ?`,
    Date.now(),
    outcome.error ?? null,
    outcome.collected ?? 0,
    id,
  )
}

/** Sources whose interval has elapsed. `intervalMinutes = 0` means push-only. */
export function dueSources(now = Date.now()): SourceConfig[] {
  return listSources().filter((source) => {
    if (!source.enabled || source.intervalMinutes <= 0) return false
    if (!source.lastRunAt) return true
    return now - source.lastRunAt >= source.intervalMinutes * 60_000
  })
}

/* ----------------------------------------------------------- trust cache -- */

let trustCache: Map<string, number> | null = null

export function invalidateTrustCache(): void {
  trustCache = null
}

/**
 * Effective trust for a source kind: the average of configured trust across that
 * kind's sources, or the built-in default when the user has configured none
 * (the extension pushes X and Xiaohongshu items with no `sources` row at all).
 */
export function sourceTrustFor(kind: SourceKind): number {
  if (!trustCache) {
    trustCache = new Map()
    const rows = all<{ kind: string; trust: number }>('SELECT kind, AVG(trust) AS trust FROM sources GROUP BY kind')
    for (const row of rows) trustCache.set(row.kind, row.trust)
  }
  return trustCache.get(kind) ?? defaultSourceTrust(kind)
}

/**
 * Feeds a new install starts with. Chosen to be genuinely high-signal and to
 * need no API key: every one of these is a public feed or public JSON API.
 */
export const DEFAULT_SOURCES: {
  kind: SourceKind
  name: string
  target: string
  intervalMinutes: number
  trust: number
}[] = [
  { kind: 'hackernews', name: 'Hacker News · AI front page', target: 'ai OR llm OR "language model" OR openai OR anthropic', intervalMinutes: 30, trust: 1.1 },
  { kind: 'arxiv', name: 'arXiv · cs.AI + cs.CL + cs.LG', target: 'cat:cs.AI OR cat:cs.CL OR cat:cs.LG', intervalMinutes: 180, trust: 1.05 },
  { kind: 'github', name: 'GitHub · trending AI repos', target: 'topic:llm OR topic:ai-agents OR topic:machine-learning', intervalMinutes: 240, trust: 1.05 },
  { kind: 'huggingface', name: 'Hugging Face · daily papers', target: 'papers', intervalMinutes: 240, trust: 1 },
  { kind: 'rss', name: "Simon Willison's Weblog", target: 'https://simonwillison.net/atom/everything/', intervalMinutes: 120, trust: 1.15 },
  { kind: 'rss', name: 'Import AI', target: 'https://importai.substack.com/feed', intervalMinutes: 720, trust: 1.1 },
  { kind: 'rss', name: 'Interconnects (Nathan Lambert)', target: 'https://www.interconnects.ai/feed', intervalMinutes: 720, trust: 1.1 },
  { kind: 'rss', name: 'The Gradient', target: 'https://thegradientpub.substack.com/feed', intervalMinutes: 720, trust: 1 },
  { kind: 'rss', name: 'Google Research Blog', target: 'https://research.google/blog/rss/', intervalMinutes: 720, trust: 1.05 },
  { kind: 'rss', name: 'OpenAI News', target: 'https://openai.com/news/rss.xml', intervalMinutes: 360, trust: 1.05 },
  // Anthropic used to be here. It publishes no feed — /rss.xml, /news/rss.xml,
  // /feed.xml and /index.xml all 404, and the news page declares no <link
  // rel="alternate"> — so the source shipped enabled and permanently red. Google
  // DeepMind is the working equivalent for frontier-lab announcements; OpenAI is
  // already covered above.
  { kind: 'rss', name: 'Google DeepMind Blog', target: 'https://deepmind.google/blog/rss.xml', intervalMinutes: 360, trust: 1.05 },
  { kind: 'reddit', name: 'r/LocalLLaMA', target: 'LocalLLaMA', intervalMinutes: 60, trust: 0.95 },
  { kind: 'reddit', name: 'r/MachineLearning', target: 'MachineLearning', intervalMinutes: 120, trust: 0.95 },
]

/** Idempotent: only seeds when the user has no sources at all. */
export function ensureDefaultSources(): number {
  const existing = get<{ n: number }>('SELECT count(*) AS n FROM sources')?.n ?? 0
  if (existing > 0) return 0
  let created = 0
  for (const source of DEFAULT_SOURCES) {
    createSource(source)
    created++
  }
  return created
}
