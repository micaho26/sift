/**
 * Analytics over the local corpus.
 *
 * Everything here is a SQL aggregate over data the user already owns — nothing is
 * sent anywhere. The interesting output is *momentum*: not "which topics are big"
 * (always the same few) but "which topics are growing", which is what actually
 * tells you something you did not already know.
 */
import type { AnalyticsResponse, EntityType, SourceKind, TopicTrend, TrendPoint } from '@sift/core'
import { all, get } from '../db/index.ts'

export type AnalyticsRange = { from: number; to: number; buckets?: number }

function bucketSize(from: number, to: number, buckets: number): number {
  return Math.max(3_600_000, Math.ceil((to - from) / Math.max(1, buckets)))
}

/** `COALESCE(published_at, captured_at)` — items without a publish date still count. */
const WHEN = 'COALESCE(published_at, captured_at)'

export function analytics(range: AnalyticsRange): AnalyticsResponse {
  const { from, to } = range
  const buckets = range.buckets ?? 30
  const size = bucketSize(from, to, buckets)

  const totals = get<{
    items: number
    saved: number
    read: number
    sources: number
    avg_score: number
    reading_time: number
  }>(
    `SELECT
        count(*)                                                    AS items,
        SUM(CASE WHEN state IN ('saved','shortlist') OR starred = 1 THEN 1 ELSE 0 END) AS saved,
        SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END)        AS read,
        count(DISTINCT source)                                      AS sources,
        AVG(score)                                                  AS avg_score,
        SUM(CASE WHEN read_at IS NOT NULL THEN reading_time ELSE 0 END) AS reading_time
      FROM items
      WHERE duplicate_of IS NULL AND state != 'trash' AND ${WHEN} BETWEEN ? AND ?`,
    from,
    to,
  )

  const volume = all<TrendPoint>(
    `SELECT (${WHEN} / ?) * ? AS bucket, count(*) AS count, AVG(score) AS avgScore
       FROM items
      WHERE duplicate_of IS NULL AND state != 'trash' AND ${WHEN} BETWEEN ? AND ?
      GROUP BY bucket ORDER BY bucket`,
    size,
    size,
    from,
    to,
  ).map((row) => ({ ...row, avgScore: Math.round((row.avgScore ?? 0) * 10) / 10 }))

  const bySource = all<{ source: SourceKind; count: number; avgScore: number }>(
    `SELECT source, count(*) AS count, AVG(score) AS avgScore
       FROM items
      WHERE duplicate_of IS NULL AND state != 'trash' AND ${WHEN} BETWEEN ? AND ?
      GROUP BY source ORDER BY count DESC`,
    from,
    to,
  ).map((row) => ({ ...row, avgScore: Math.round((row.avgScore ?? 0) * 10) / 10 }))

  const topics = topicTrends(from, to, size)

  const topAuthors = all<{ handle: string; name: string; count: number; avgScore: number; saves: number }>(
    `SELECT i.author_handle AS handle,
            COALESCE(MAX(i.author_name), i.author_handle) AS name,
            count(*) AS count,
            AVG(i.score) AS avgScore,
            SUM(CASE WHEN i.state IN ('saved','shortlist') OR i.starred = 1 THEN 1 ELSE 0 END) AS saves
       FROM items i
      WHERE i.author_handle IS NOT NULL AND i.duplicate_of IS NULL AND ${WHEN.replace(/published_at/g, 'i.published_at').replace(/captured_at/g, 'i.captured_at')} BETWEEN ? AND ?
      GROUP BY i.author_handle
      ORDER BY AVG(i.score) * MIN(count(*), 8) DESC
      LIMIT 12`,
    from,
    to,
  ).map((row) => ({ ...row, avgScore: Math.round((row.avgScore ?? 0) * 10) / 10 }))

  const entities = all<{ name: string; type: EntityType; count: number }>(
    `SELECT e.name, e.type, count(*) AS count
       FROM item_entities e JOIN items i ON i.id = e.item_id
      WHERE i.duplicate_of IS NULL AND COALESCE(i.published_at, i.captured_at) BETWEEN ? AND ?
      GROUP BY e.name, e.type ORDER BY count DESC LIMIT 40`,
    from,
    to,
  )

  const scoreHistogram = all<{ bucket: number; count: number }>(
    `SELECT (CAST(score / 10 AS INTEGER)) * 10 AS bucket, count(*) AS count
       FROM items
      WHERE duplicate_of IS NULL AND state != 'trash' AND ${WHEN} BETWEEN ? AND ?
      GROUP BY bucket ORDER BY bucket`,
    from,
    to,
  )

  return {
    range: { from, to },
    totals: {
      items: totals?.items ?? 0,
      saved: totals?.saved ?? 0,
      read: totals?.read ?? 0,
      sources: totals?.sources ?? 0,
      avgScore: Math.round((totals?.avg_score ?? 0) * 10) / 10,
      readingTimeSec: totals?.reading_time ?? 0,
    },
    volume,
    bySource,
    topics,
    topAuthors,
    entities,
    scoreHistogram,
  }
}

/**
 * Topic momentum: this period's volume over the previous period's, with Laplace
 * smoothing so a topic going 0 → 3 does not report infinite growth.
 */
function topicTrends(from: number, to: number, size: number): TopicTrend[] {
  const span = to - from
  const prevFrom = from - span

  const current = all<{ topic: string; total: number; avgScore: number }>(
    `SELECT tp.topic, count(*) AS total, AVG(i.score) AS avgScore
       FROM item_topics tp JOIN items i ON i.id = tp.item_id
      WHERE i.duplicate_of IS NULL AND i.state != 'trash'
        AND COALESCE(i.published_at, i.captured_at) BETWEEN ? AND ?
      GROUP BY tp.topic ORDER BY total DESC LIMIT 20`,
    from,
    to,
  )
  if (!current.length) return []

  const previous = new Map(
    all<{ topic: string; total: number }>(
      `SELECT tp.topic, count(*) AS total
         FROM item_topics tp JOIN items i ON i.id = tp.item_id
        WHERE i.duplicate_of IS NULL AND COALESCE(i.published_at, i.captured_at) BETWEEN ? AND ?
        GROUP BY tp.topic`,
      prevFrom,
      from,
    ).map((row) => [row.topic, row.total]),
  )

  const topics = current.map((row) => {
    const series = all<{ bucket: number; count: number }>(
      `SELECT (COALESCE(i.published_at, i.captured_at) / ?) * ? AS bucket, count(*) AS count
         FROM item_topics tp JOIN items i ON i.id = tp.item_id
        WHERE tp.topic = ? AND i.duplicate_of IS NULL
          AND COALESCE(i.published_at, i.captured_at) BETWEEN ? AND ?
        GROUP BY bucket ORDER BY bucket`,
      size,
      size,
      row.topic,
      from,
      to,
    ).map((r) => r.count)

    const before = previous.get(row.topic) ?? 0
    // Momentum is only meaningful against a comparable window. On a fresh install
    // the previous period is empty, and reporting "17.5x growth" there is noise
    // dressed as insight — so an absent baseline reports 1.0 (flat) and the UI
    // labels the topic "new" from `hadBaseline`.
    const hadBaseline = previous.size > 0
    // +2 smoothing so 0 -> 4 reads as 3.0x rather than infinity.
    const momentum = hadBaseline ? Math.round(((row.total + 2) / (before + 2)) * 100) / 100 : 1

    const sampleItemIds = all<{ id: string }>(
      `SELECT i.id FROM item_topics tp JOIN items i ON i.id = tp.item_id
        WHERE tp.topic = ? AND i.duplicate_of IS NULL
          AND COALESCE(i.published_at, i.captured_at) BETWEEN ? AND ?
        ORDER BY i.score DESC LIMIT 5`,
      row.topic,
      from,
      to,
    ).map((r) => r.id)

    return {
      topic: row.topic,
      total: row.total,
      momentum,
      isNew: !hadBaseline || before === 0,
      avgScore: Math.round((row.avgScore ?? 0) * 10) / 10,
      series,
      sampleItemIds,
    }
  })

  // Rank by momentum weighted by volume — a 5x jump on 2 items is not news.
  return topics.sort((a, b) => b.momentum * Math.log1p(b.total) - a.momentum * Math.log1p(a.total))
}

/** Reading activity by hour of day and day of week — the "when do I read" heatmap. */
export function activityHeatmap(from: number, to: number): { dow: number; hour: number; count: number }[] {
  return all<{ dow: number; hour: number; count: number }>(
    `SELECT CAST(strftime('%w', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
            CAST(strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
            count(*) AS count
       FROM events
      WHERE type IN ('item.read','item.save') AND ts BETWEEN ? AND ?
      GROUP BY dow, hour`,
    from,
    to,
  )
}

/** Per-day counts of captures, saves and reads — the streak strip. */
export function dailyActivity(days = 30): { day: string; captured: number; saved: number; read: number }[] {
  const from = Date.now() - days * 86_400_000
  return all<{ day: string; captured: number; saved: number; read: number }>(
    `SELECT date(captured_at / 1000, 'unixepoch', 'localtime') AS day,
            count(*) AS captured,
            SUM(CASE WHEN state IN ('saved','shortlist') OR starred = 1 THEN 1 ELSE 0 END) AS saved,
            SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read
       FROM items
      WHERE captured_at >= ?
      GROUP BY day ORDER BY day`,
    from,
  )
}
