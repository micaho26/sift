/**
 * Re-scoring.
 *
 * Scores are derived, not authoritative, so any change to weights, interests or
 * source trust must be able to propagate across the whole corpus. Done in chunks
 * with progress events, because on a large library this is the one operation that
 * can take more than a second and the UI needs to say so.
 */
import { authorAffinity, computeScore } from '@sift/core'
import { all, parseJson, transaction } from '../db/index.ts'
import { decodeVector, getVectorIndex, vectorIndexReady } from '../db/vector.ts'
import { emitJob, emitUpdated } from '../events.ts'
import { log } from '../log.ts'
import { authorStats, updateScore } from '../repo/items.ts'
import { readSettings } from '../repo/settings.ts'
import { sourceTrustFor } from '../repo/sources.ts'
import { getInterestProfile, rebuildInterestProfile } from './interests.ts'

type RescoreRow = {
  id: string
  source: string
  kind: string
  title: string
  summary: string | null
  content: string | null
  metrics_json: string | null
  published_at: number | null
  author_json: string | null
  author_handle: string | null
  echo_count: number
  embedding: Uint8Array | null
}

const CHUNK = 500

export async function rescoreAll(limit = 20_000): Promise<{ rescored: number; tookMs: number }> {
  const started = performance.now()
  emitJob('rescore', 'start', { message: 'Recomputing signal scores' })

  await rebuildInterestProfile(true)
  const settings = readSettings()
  const profile = getInterestProfile()
  const now = Date.now()

  const rows = all<RescoreRow>(
    `SELECT id, source, kind, title, summary, substr(content, 1, 8000) AS content,
            metrics_json, published_at, author_json, author_handle, echo_count, embedding
       FROM items
      WHERE duplicate_of IS NULL
      ORDER BY updated_at DESC
      LIMIT ?`,
    limit,
  )

  const index = vectorIndexReady() ? getVectorIndex() : null
  let rescored = 0
  const changedIds: string[] = []

  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const chunk = rows.slice(offset, offset + CHUNK)
    transaction(() => {
      for (const row of chunk) {
        const author = parseJson<{ followers?: number; verified?: boolean } | undefined>(row.author_json, undefined)
        const stats = authorStats(row.author_handle ?? undefined)
        const vector = row.embedding ? decodeVector(row.embedding) : null

        // Novelty must exclude the item itself, or everything scores 0 novelty.
        const maxSimilarity = vector && index ? index.maxSimilarity(vector, row.id) : 0

        const scored = computeScore({
          source: row.source as never,
          kind: row.kind,
          title: row.title,
          summary: row.summary ?? undefined,
          content: row.content ?? undefined,
          metrics: parseJson(row.metrics_json, {}),
          publishedAt: row.published_at ?? undefined,
          followers: author?.followers ?? stats.followers,
          authorAffinity: authorAffinity(stats.saved, stats.seen),
          verified: author?.verified,
          vector,
          interestVectors: profile.vectors,
          interestKeywords: profile.keywords,
          maxSimilarityToCorpus: maxSimilarity,
          echoCount: row.echo_count,
          sourceTrust: sourceTrustFor(row.source as never),
          weights: settings.weights,
          halfLifeHours: settings.recencyHalfLifeHours,
          now,
        })
        updateScore(row.id, scored.score, scored.breakdown)
        rescored++
        if (changedIds.length < 200) changedIds.push(row.id)
      }
    })
    emitJob('rescore', 'progress', {
      progress: Math.min(1, (offset + CHUNK) / Math.max(1, rows.length)),
      message: `${Math.min(offset + CHUNK, rows.length)} / ${rows.length}`,
    })
    // Yield to the event loop so the API stays responsive mid-rescore.
    await new Promise((resolve) => setImmediate(resolve))
  }

  const tookMs = Math.round(performance.now() - started)
  emitJob('rescore', 'done', { message: `${rescored} items rescored in ${tookMs}ms` })
  emitUpdated(changedIds)
  log.info(`Rescored ${rescored} items in ${tookMs}ms`)
  return { rescored, tookMs }
}
