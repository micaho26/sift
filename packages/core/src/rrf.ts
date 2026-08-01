/**
 * Result fusion and diversification for hybrid search.
 *
 * BM25 and vector similarity produce scores on incomparable scales, so they
 * cannot be added. Reciprocal Rank Fusion sidesteps this entirely by combining
 * *ranks*, which is why it beats score normalisation in practice and needs no
 * tuning per corpus.
 *
 * Cormack, Clarke & Buettcher, "Reciprocal Rank Fusion outperforms Condorcet
 * and individual Rank Learning Methods" (SIGIR 2009).
 */

export type RankedList<T> = {
  /** Identifier extracted per element. */
  items: T[]
  /** Optional weight for this retriever's opinion. Defaults to 1. */
  weight?: number
  /** Label recorded in `matchedBy` so the UI can badge match provenance. */
  label?: string
}

export type FusedResult<T> = {
  id: string
  item: T
  score: number
  /** Which retrievers found it, and at what rank. */
  sources: { label: string; rank: number }[]
}

/**
 * `k = 60` is the value from the original paper and remains a good default: it
 * makes the difference between rank 1 and 2 meaningful without letting a single
 * retriever's top hit dominate a document that two retrievers both ranked well.
 */
export const RRF_K = 60

export function reciprocalRankFusion<T>(
  lists: RankedList<T>[],
  getId: (item: T) => string,
  k = RRF_K,
): FusedResult<T>[] {
  const acc = new Map<string, FusedResult<T>>()

  for (const [listIndex, list] of lists.entries()) {
    const weight = list.weight ?? 1
    const label = list.label ?? `r${listIndex}`
    for (const [i, item] of list.items.entries()) {
      const id = getId(item)
      if (!id) continue
      const rank = i + 1
      const contribution = weight / (k + rank)
      const existing = acc.get(id)
      if (existing) {
        existing.score += contribution
        existing.sources.push({ label, rank })
      } else {
        acc.set(id, { id, item, score: contribution, sources: [{ label, rank }] })
      }
    }
  }

  return [...acc.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

/**
 * Maximal Marginal Relevance re-ranking.
 *
 * Relevance alone returns ten near-identical takes on the same story. MMR
 * greedily picks the next result that is relevant *and* unlike what has already
 * been picked. `lambda` 1 = pure relevance, 0 = pure diversity; 0.7 is a good
 * default for a news feed.
 *
 * Carbonell & Goldstein (SIGIR 1998).
 */
export function maximalMarginalRelevance<T>(
  candidates: { item: T; relevance: number; vector: Float32Array | null }[],
  lambda: number,
  limit: number,
  similarity: (a: Float32Array, b: Float32Array) => number,
): T[] {
  if (lambda >= 1 || candidates.length <= 1) return candidates.slice(0, limit).map((c) => c.item)
  const l = Math.max(0, Math.min(1, lambda))

  const pool = [...candidates]
  const selected: typeof candidates = []
  const out: T[] = []

  // Normalise relevance to 0..1 so lambda means the same thing at every scale.
  const maxRel = Math.max(...pool.map((c) => c.relevance), 1e-9)

  while (out.length < limit && pool.length) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!
      let maxSim = 0
      if (c.vector) {
        for (const s of selected) {
          if (!s.vector) continue
          const sim = similarity(c.vector, s.vector)
          if (sim > maxSim) maxSim = sim
        }
      }
      const score = l * (c.relevance / maxRel) - (1 - l) * maxSim
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    const picked = pool.splice(bestIndex, 1)[0]!
    selected.push(picked)
    out.push(picked.item)
  }
  return out
}

/**
 * Cap how many consecutive results may come from the same bucket (author or
 * domain). Cheaper than MMR and fixes the most visible feed pathology: one
 * prolific account owning the top of your inbox.
 */
export function interleaveByBucket<T>(items: T[], getBucket: (item: T) => string, maxRun = 2): T[] {
  if (items.length <= maxRun) return items
  const remaining = [...items]
  const out: T[] = []
  let lastBucket = ''
  let run = 0

  while (remaining.length) {
    let pickIndex = 0
    if (run >= maxRun) {
      const alt = remaining.findIndex((it) => getBucket(it) !== lastBucket)
      if (alt > 0) pickIndex = alt
    }
    const picked = remaining.splice(pickIndex, 1)[0]!
    const bucket = getBucket(picked)
    run = bucket === lastBucket ? run + 1 : 1
    lastBucket = bucket
    out.push(picked)
  }
  return out
}
