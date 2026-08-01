/**
 * The zero-dependency embedder.
 *
 * Sift must be useful the second it starts, with no model download and no API
 * key. This produces a 384-dimensional vector from hashed character n-grams and
 * word tokens — the "hashing trick" (Weinberger et al. 2009). It is not a
 * transformer: it captures lexical and sub-word overlap, not paraphrase. But it
 * is deterministic, instant, offline, works on Chinese and English alike, and
 * makes semantic-ish search and novelty detection work on first run.
 *
 * When the user enables the local transformer model in Settings, the server
 * swaps this out and re-embeds in the background. The interface is identical.
 */
import { normalizeVector } from './simhash.js'
import { cjkBigrams, tokenize } from './text.js'

export const HASH_DIMENSIONS = 384

/** Two independent 32-bit hashes, so sign and bucket are uncorrelated. */
function hash32(str: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Final avalanche (murmur3 fmix32) — without it, short tokens cluster.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** Character 3-grams inside a token, for sub-word robustness ("quantize"/"quantized"). */
function charNgrams(token: string, n = 3): string[] {
  if (token.length <= n) return [token]
  const out: string[] = []
  const padded = `<${token}>`
  for (let i = 0; i <= padded.length - n; i++) out.push(padded.slice(i, i + n))
  return out
}

export type HashEmbedOptions = {
  dimensions?: number
  /** Extra weight on the title, which is the densest signal in a news item. */
  titleWeight?: number
}

/**
 * Embed text into an L2-normalised Float32Array. Cosine similarity between two
 * outputs approximates weighted token-set overlap.
 */
export function hashEmbed(text: string, opts: HashEmbedOptions = {}): Float32Array {
  const dim = opts.dimensions ?? HASH_DIMENSIONS
  const v = new Float32Array(dim)
  if (!text || !text.trim()) return v

  const addFeature = (feature: string, weight: number) => {
    const bucket = hash32(feature, 0x9e3779b9) % dim
    const sign = hash32(feature, 0x85ebca6b) & 1 ? 1 : -1
    v[bucket]! += sign * weight
  }

  const tokens = tokenize(text)
  if (!tokens.length) return v

  // Sub-linear term frequency: the tenth mention of "model" adds little.
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)

  for (const [token, count] of counts) {
    const tf = 1 + Math.log(count)
    addFeature(token, tf)
    // Latin tokens get char-ngrams; CJK bigrams are already sub-word units.
    if (/^[a-z0-9]/.test(token) && token.length > 3) {
      const grams = charNgrams(token)
      const share = (tf * 0.45) / grams.length
      for (const g of grams) addFeature(g, share)
    }
  }

  // Word bigrams carry a little word-order information.
  for (let i = 0; i + 1 < tokens.length; i++) addFeature(`${tokens[i]}_${tokens[i + 1]}`, 0.35)

  return normalizeVector(v)
}

/**
 * Embed a whole item. Title and topics repeat so they dominate the vector,
 * which is what makes "find me more like this" behave the way users expect.
 */
export function hashEmbedItem(
  item: { title?: string; summary?: string; content?: string; topics?: string[]; author?: { name?: string } },
  opts: HashEmbedOptions = {},
): Float32Array {
  const titleWeight = opts.titleWeight ?? 3
  const parts: string[] = []
  const title = item.title?.trim()
  if (title) for (let i = 0; i < titleWeight; i++) parts.push(title)
  if (item.topics?.length) parts.push(item.topics.join(' '))
  if (item.summary) parts.push(item.summary)
  if (item.content) parts.push(item.content.slice(0, 6000))
  // Author name helps "more from this voice" clustering without dominating.
  if (item.author?.name) parts.push(item.author.name)
  return hashEmbed(parts.join('\n'), opts)
}

/** Mean of several vectors, re-normalised — used for the interest centroid. */
export function centroid(vectors: Float32Array[]): Float32Array | null {
  if (!vectors.length) return null
  const dim = vectors[0]!.length
  const out = new Float32Array(dim)
  for (const v of vectors) {
    if (v.length !== dim) continue
    for (let i = 0; i < dim; i++) out[i]! += v[i]!
  }
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length
  return normalizeVector(out)
}

/**
 * Split saved items into up to `k` interest clusters instead of one blurry
 * average. A user who follows both robotics and LLM inference is badly served by
 * a centroid sitting between the two, which resembles neither.
 *
 * Deterministic k-means++ style seeding (farthest-point) — no RNG, so scores are
 * reproducible across restarts.
 */
export function interestClusters(vectors: Float32Array[], k = 3, iterations = 8): Float32Array[] {
  if (!vectors.length) return []
  if (vectors.length <= k) return vectors.map((v) => v.slice())
  const dim = vectors[0]!.length
  const usable = vectors.filter((v) => v.length === dim)
  if (usable.length <= k) return usable.map((v) => v.slice())

  const dot = (a: Float32Array, b: Float32Array) => {
    let s = 0
    for (let i = 0; i < dim; i++) s += a[i]! * b[i]!
    return s
  }

  // Seed 0: the vector closest to the global mean (the "core" interest).
  const global = centroid(usable)!
  let seedIndex = 0
  let bestSim = -Infinity
  usable.forEach((v, i) => {
    const s = dot(v, global)
    if (s > bestSim) {
      bestSim = s
      seedIndex = i
    }
  })
  const centers: Float32Array[] = [usable[seedIndex]!.slice()]

  // Remaining seeds: farthest point from all existing centers.
  while (centers.length < k) {
    let farIndex = -1
    let farScore = Infinity
    usable.forEach((v, i) => {
      let maxSim = -Infinity
      for (const c of centers) {
        const s = dot(v, c)
        if (s > maxSim) maxSim = s
      }
      if (maxSim < farScore) {
        farScore = maxSim
        farIndex = i
      }
    })
    if (farIndex < 0) break
    centers.push(usable[farIndex]!.slice())
  }

  // Lloyd iterations with cosine assignment.
  for (let iter = 0; iter < iterations; iter++) {
    const buckets: Float32Array[][] = centers.map(() => [])
    for (const v of usable) {
      let best = 0
      let bestSim2 = -Infinity
      centers.forEach((c, ci) => {
        const s = dot(v, c)
        if (s > bestSim2) {
          bestSim2 = s
          best = ci
        }
      })
      buckets[best]!.push(v)
    }
    let moved = false
    buckets.forEach((bucket, i) => {
      if (!bucket.length) return
      const next = centroid(bucket)!
      if (dot(next, centers[i]!) < 0.9999) moved = true
      centers[i] = next
    })
    if (!moved) break
  }

  return centers
}
