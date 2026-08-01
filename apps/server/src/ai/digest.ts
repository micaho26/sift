/**
 * Digest generation.
 *
 * Two implementations behind one function. With an LLM configured you get written
 * prose; without one you get a deterministic template digest assembled from
 * clustered items. The template version is genuinely useful rather than a
 * placeholder — that is what makes the AI layer optional instead of load-bearing.
 */
import {
  Digest,
  cosineSimilarity,
  timeAgo,
  topicLabel,
  type DigestSection,
  type ItemSummary,
} from '@sift/core'
import { all, newId, run } from '../db/index.ts'
import { getVectorIndex, vectorIndexReady } from '../db/vector.ts'
import { hydrate, SUMMARY_COLUMNS, type ItemRow } from '../repo/items.ts'
import { complete, isAiConfigured } from './provider.ts'
import { DIGEST_SYSTEM, renderContext } from './prompts.ts'
import { log } from '../log.ts'

export type DigestOptions = {
  hours?: number
  maxItems?: number
  /** Force the local template path even when an LLM is available. */
  template?: boolean
}

/** Top items in the window, de-echoed and author-diversified. */
function selectItems(hours: number, maxItems: number): ItemSummary[] {
  const from = Date.now() - hours * 3_600_000
  const rows = all<ItemRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM items i
      WHERE i.duplicate_of IS NULL
        AND i.state != 'trash'
        AND COALESCE(i.published_at, i.captured_at) >= ?
      ORDER BY i.score DESC
      LIMIT ?`,
    from,
    maxItems * 4,
  )
  const items = hydrate(rows)

  // At most two items per author, so one prolific account cannot own the digest.
  const perAuthor = new Map<string, number>()
  const selected: ItemSummary[] = []
  for (const item of items) {
    const key = item.author?.handle ?? item.author?.name ?? item.source
    const seen = perAuthor.get(key) ?? 0
    if (seen >= 2) continue
    perAuthor.set(key, seen + 1)
    selected.push(item)
    if (selected.length >= maxItems) break
  }
  return selected
}

/**
 * Group items into themes. Uses embedding similarity when vectors exist, and
 * falls back to shared topics — both produce stable, explainable clusters.
 */
function clusterItems(items: ItemSummary[]): { label: string; items: ItemSummary[] }[] {
  if (!items.length) return []

  const byTopic = new Map<string, ItemSummary[]>()
  for (const item of items) {
    const topic = item.topics[0] ?? 'other'
    const list = byTopic.get(topic)
    if (list) list.push(item)
    else byTopic.set(topic, [item])
  }

  // Merge singleton topics whose members are semantically close to a larger group.
  if (vectorIndexReady()) {
    const index = getVectorIndex()
    const groups = [...byTopic.entries()]
    const singles = groups.filter(([, list]) => list.length === 1)
    const larger = groups.filter(([, list]) => list.length > 1)
    for (const [topic, list] of singles) {
      const vector = index.get(list[0]!.id)
      if (!vector) continue
      let bestTopic: string | null = null
      let bestSim = 0.45
      for (const [otherTopic, otherList] of larger) {
        for (const other of otherList) {
          const otherVector = index.get(other.id)
          if (!otherVector) continue
          const sim = cosineSimilarity(vector, otherVector)
          if (sim > bestSim) {
            bestSim = sim
            bestTopic = otherTopic
          }
        }
      }
      if (bestTopic) {
        byTopic.get(bestTopic)!.push(list[0]!)
        byTopic.delete(topic)
      }
    }
  }

  return [...byTopic.entries()]
    .map(([topic, list]) => ({
      label: topicLabel(topic),
      items: list.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => b.items.length - a.items.length || (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0))
    .slice(0, 5)
}

/** Deterministic digest — no LLM, still readable. */
function templateDigest(items: ItemSummary[], hours: number): { lede: string; sections: DigestSection[] } {
  if (!items.length) {
    return {
      lede: 'Nothing crossed the signal threshold in this period. Either the sources are quiet or the bar is set high — both are fine.',
      sections: [],
    }
  }

  const clusters = clusterItems(items)
  const top = items[0]!
  const sourceCount = new Set(items.map((i) => i.source)).size
  const lede =
    `${items.length} item${items.length === 1 ? '' : 's'} cleared the bar across ${sourceCount} source${sourceCount === 1 ? '' : 's'} in the last ${hours} hours. ` +
    `The highest-signal item scored ${top.score}: ${top.title.slice(0, 140)}. ` +
    `${clusters.length ? `Activity clustered around ${clusters.slice(0, 3).map((c) => c.label.toLowerCase()).join(', ')}.` : ''}`

  const sections: DigestSection[] = clusters.map((cluster) => ({
    heading: cluster.label,
    body: cluster.items
      .slice(0, 4)
      .map((item, index) => {
        const gist = item.aiSummary ?? item.summary ?? item.title
        const author = item.author?.handle ? `@${item.author.handle}` : (item.author?.name ?? item.source)
        return `${index + 1}. **${item.title.slice(0, 160)}** — ${gist.replace(/\s+/g, ' ').slice(0, 220)} _(${author} · ${item.source} · signal ${item.score} · ${timeAgo(item.publishedAt ?? item.capturedAt)})_`
      })
      .join('\n'),
    itemIds: cluster.items.slice(0, 4).map((i) => i.id),
  }))

  return { lede, sections }
}

/** LLM digest. Falls back to the template on any failure. */
async function aiDigest(items: ItemSummary[], hours: number): Promise<{ lede: string; sections: DigestSection[]; generator: 'ai' | 'template' }> {
  const context = renderContext(
    items.map((item) => ({
      title: item.title,
      source: item.source,
      url: item.url,
      publishedAt: item.publishedAt,
      text: item.aiSummary ?? item.summary ?? '',
    })),
  )

  try {
    const text = await complete({
      system: DIGEST_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Write the briefing for the last ${hours} hours from these ${items.length} items.\n\n${context}`,
        },
      ],
      maxTokens: 2000,
      temperature: 0.4,
    })

    const { lede, sections } = parseMarkdownDigest(text, items)
    if (!sections.length) throw new Error('model returned no sections')
    return { lede, sections, generator: 'ai' }
  } catch (error) {
    log.warn(`AI digest failed (${(error as Error).message}); using template digest`)
    return { ...templateDigest(items, hours), generator: 'template' }
  }
}

/** Split the model's Markdown into sections and resolve `[n]` back to item ids. */
function parseMarkdownDigest(text: string, items: ItemSummary[]): { lede: string; sections: DigestSection[] } {
  const parts = text.split(/^##\s+/m)
  const lede = (parts[0] ?? '').trim()
  const sections: DigestSection[] = []

  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n')
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim()
    const body = (newline === -1 ? '' : part.slice(newline + 1)).trim()
    if (!heading) continue

    const cited = new Set<string>()
    for (const match of body.matchAll(/\[(\d{1,3})\]/g)) {
      const index = Number(match[1]) - 1
      const item = items[index]
      if (item) cited.add(item.id)
    }
    sections.push({ heading: heading.replace(/[#*]/g, '').trim(), body, itemIds: [...cited] })
  }

  return { lede: lede.replace(/^#+\s*/, ''), sections }
}

export async function generateDigest(options: DigestOptions = {}): Promise<Digest> {
  const hours = options.hours ?? 24
  const maxItems = options.maxItems ?? 12
  const items = selectItems(hours, maxItems)

  const useAi = !options.template && isAiConfigured() && items.length > 0
  const { lede, sections, generator } = useAi
    ? await aiDigest(items, hours)
    : { ...templateDigest(items, hours), generator: 'template' as const }

  const now = Date.now()
  const digest: Digest = {
    id: newId('d_'),
    title: `${hours <= 24 ? 'Daily' : hours <= 168 ? 'Weekly' : 'Period'} briefing · ${new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    periodFrom: now - hours * 3_600_000,
    periodTo: now,
    lede,
    sections,
    itemIds: items.map((i) => i.id),
    createdAt: now,
    generator,
  }

  run(
    `INSERT INTO digests (id, title, period_from, period_to, lede, sections_json, item_ids, generator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    digest.id,
    digest.title,
    digest.periodFrom,
    digest.periodTo,
    digest.lede,
    JSON.stringify(digest.sections),
    JSON.stringify(digest.itemIds),
    digest.generator,
    digest.createdAt,
  )

  return digest
}

type DigestRow = {
  id: string
  title: string
  period_from: number
  period_to: number
  lede: string
  sections_json: string
  item_ids: string
  generator: string
  created_at: number
}

function rowToDigest(row: DigestRow): Digest {
  const parse = <T>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  }
  return {
    id: row.id,
    title: row.title,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    lede: row.lede,
    sections: parse<DigestSection[]>(row.sections_json, []),
    itemIds: parse<string[]>(row.item_ids, []),
    generator: row.generator === 'ai' ? 'ai' : 'template',
    createdAt: row.created_at,
  }
}

export function listDigests(limit = 20): Digest[] {
  return all<DigestRow>('SELECT * FROM digests ORDER BY created_at DESC LIMIT ?', limit).map(rowToDigest)
}

export function getDigest(id: string): Digest | null {
  const rows = all<DigestRow>('SELECT * FROM digests WHERE id = ?', id)
  return rows[0] ? rowToDigest(rows[0]) : null
}

export function latestDigest(): Digest | null {
  const rows = all<DigestRow>('SELECT * FROM digests ORDER BY created_at DESC LIMIT 1')
  return rows[0] ? rowToDigest(rows[0]) : null
}
