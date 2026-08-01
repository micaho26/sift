/**
 * The interest profile — Sift's model of what you care about.
 *
 * Built from two sources, because neither alone is enough:
 *  - stated interests from Settings (works on day one, but people describe
 *    themselves badly),
 *  - revealed preference from what you actually saved (accurate, but empty at
 *    first).
 *
 * Saved items are clustered rather than averaged. A user who follows both
 * robotics and inference optimisation is served terribly by a single centroid
 * sitting between the two, which resembles neither. Cached because it is read on
 * every single ingested item.
 */
import { centroid, deriveInterestKeywords, interestClusters } from '@sift/core'
import { all } from '../db/index.ts'
import { decodeVector } from '../db/vector.ts'
import { getEmbedder } from '../embed.ts'
import { log } from '../log.ts'
import { readSettings } from '../repo/settings.ts'

export type InterestProfile = {
  vectors: Float32Array[]
  keywords: string[]
  /** Number of saved items the profile was built from. */
  sampleSize: number
  builtAt: number
}

const EMPTY: InterestProfile = { vectors: [], keywords: [], sampleSize: 0, builtAt: 0 }

let cached: InterestProfile = EMPTY
/** Rebuild at most this often, even if invalidated repeatedly. */
const MIN_REBUILD_INTERVAL_MS = 30_000
let dirty = true

export function invalidateInterestProfile(): void {
  dirty = true
}

export function getInterestProfile(): InterestProfile {
  return cached
}

/**
 * Recompute the profile. Async because stated interests must be embedded, which
 * may hit a remote provider.
 */
export async function rebuildInterestProfile(force = false): Promise<InterestProfile> {
  if (!force && !dirty && Date.now() - cached.builtAt < MIN_REBUILD_INTERVAL_MS) return cached

  const settings = readSettings()
  const embedder = getEmbedder()

  // Revealed preference: what the user kept, most recent first.
  const savedRows = all<{
    id: string
    title: string
    embedding: Uint8Array | null
  }>(
    `SELECT id, title, embedding FROM items
      WHERE (state IN ('saved','shortlist') OR starred = 1)
        AND embedding IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 400`,
  )

  const savedVectors: Float32Array[] = []
  for (const row of savedRows) {
    if (!row.embedding) continue
    const vector = decodeVector(row.embedding)
    if (vector.length === embedder.dimensions) savedVectors.push(vector)
  }

  // Stated interests, embedded individually so each is its own anchor.
  const statedVectors: Float32Array[] = []
  const statedTexts = settings.interests.map((s) => s.trim()).filter((s) => s.length >= 2)
  if (statedTexts.length) {
    try {
      const embedded = await embedder.embed(statedTexts)
      for (const vector of embedded) if (vector.length === embedder.dimensions) statedVectors.push(vector)
    } catch (error) {
      log.debug(`Could not embed stated interests: ${(error as Error).message}`)
    }
  }

  // Up to 3 clusters from behaviour, plus every stated interest as its own anchor.
  const behaviourClusters = savedVectors.length >= 2 ? interestClusters(savedVectors, 3) : savedVectors
  const vectors = [...statedVectors, ...behaviourClusters].filter((v) => v.length === embedder.dimensions)

  // A single fallback centroid keeps relevance meaningful when there is exactly
  // one signal to go on.
  if (!vectors.length && savedVectors.length === 1) {
    const only = centroid(savedVectors)
    if (only) vectors.push(only)
  }

  const savedTitles = all<{ title: string }>(
    `SELECT title FROM items WHERE state IN ('saved','shortlist') OR starred = 1 ORDER BY updated_at DESC LIMIT 200`,
  )
  const savedTopics = all<{ topic: string }>(
    `SELECT tp.topic AS topic FROM item_topics tp
       JOIN items i ON i.id = tp.item_id
      WHERE i.state IN ('saved','shortlist') OR i.starred = 1
      GROUP BY tp.topic ORDER BY count(*) DESC LIMIT 12`,
  )

  const keywords = deriveInterestKeywords(
    settings.interests,
    savedTitles.map((r) => ({ title: r.title, topics: [] })),
  )
  for (const row of savedTopics) if (!keywords.includes(row.topic)) keywords.push(row.topic)

  cached = {
    vectors,
    keywords: keywords.slice(0, 64),
    sampleSize: savedVectors.length,
    builtAt: Date.now(),
  }
  dirty = false
  log.debug(`Interest profile rebuilt: ${vectors.length} anchors, ${keywords.length} keywords, ${savedVectors.length} saved samples`)
  return cached
}
