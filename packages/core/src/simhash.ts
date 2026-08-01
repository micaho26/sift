/**
 * Near-duplicate detection via 64-bit SimHash + LSH banding.
 *
 * Exact-URL dedup catches the same link twice. It does *not* catch the twenty
 * accounts that all posted "OpenAI just released o5" with slightly different
 * wording — which is the actual failure mode of an AI news feed. SimHash gives
 * us a fingerprint whose Hamming distance tracks textual similarity, and the
 * band index turns "compare against every item" into a single indexed lookup.
 *
 * Charikar, "Similarity Estimation Techniques from Rounding Algorithms" (2002);
 * band scheme after Manku et al., "Detecting Near-Duplicates for Web Crawling" (2007).
 */
import { tokenize } from './text.js'

const MASK64 = 0xffffffffffffffffn

/** FNV-1a 64-bit over a token, as BigInt. */
function hashToken(token: string): bigint {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < token.length; i++) {
    h ^= BigInt(token.charCodeAt(i) & 0xffff)
    h = (h * prime) & MASK64
  }
  return h
}

/**
 * Weighted-shingle SimHash. Uses token *bigrams* (word pairs) so word order
 * matters — "model beats human" and "human beats model" get different prints.
 */
export function simhash(text: string): string {
  const tokens = tokenize(text)
  if (tokens.length === 0) return '0'.repeat(16)

  // Word-level shingles of size 2, plus unigrams at half weight.
  const features = new Map<string, number>()
  for (let i = 0; i < tokens.length; i++) {
    const uni = tokens[i]!
    features.set(uni, (features.get(uni) ?? 0) + 1)
    if (i + 1 < tokens.length) {
      const bi = `${uni}${tokens[i + 1]}`
      features.set(bi, (features.get(bi) ?? 0) + 2)
    }
  }

  const v = new Float64Array(64)
  for (const [feature, weight] of features) {
    const h = hashToken(feature)
    for (let bit = 0; bit < 64; bit++) {
      const set = (h >> BigInt(bit)) & 1n
      v[bit]! += set === 1n ? weight : -weight
    }
  }

  let out = 0n
  for (let bit = 0; bit < 64; bit++) if (v[bit]! > 0) out |= 1n << BigInt(bit)
  return out.toString(16).padStart(16, '0')
}

/** Popcount for a 64-bit BigInt. */
function popcount64(x: bigint): number {
  let n = 0
  let v = x
  while (v) {
    v &= v - 1n
    n++
  }
  return n
}

/** Hamming distance between two 16-hex-char SimHashes. 0 = identical text. */
export function hammingDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64
  try {
    return popcount64((BigInt(`0x${a}`) ^ BigInt(`0x${b}`)) & MASK64)
  } catch {
    return 64
  }
}

/** Distance ≤ 3 out of 64 bits ≈ >95% textual overlap in practice. */
export const DUPLICATE_THRESHOLD = 3

export function isNearDuplicate(a: string, b: string, threshold = DUPLICATE_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold
}

export const BAND_COUNT = 4
export const BAND_BITS = 16

/**
 * Split a fingerprint into 4 x 16-bit bands. Two prints within Hamming distance
 * 3 must agree on at least one band (pigeonhole), so an equality index over
 * bands is a complete-recall candidate generator.
 *
 * Returned strings are prefixed with the band position so all four can live in
 * one index without colliding across bands.
 */
export function simhashBands(hex: string): string[] {
  if (!hex || hex.length !== 16) return []
  const bands: string[] = []
  for (let i = 0; i < BAND_COUNT; i++) {
    bands.push(`${i}:${hex.slice(i * 4, i * 4 + 4)}`)
  }
  return bands
}

/** Jaccard similarity over token sets — the exact measure, for verification. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 && sb.size === 0) return 1
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/** Cosine similarity for dense float vectors. Returns 0 on shape mismatch. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** L2-normalise in place and return the same array (so cosine == dot product). */
export function normalizeVector(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  if (n === 0) return v
  const inv = 1 / Math.sqrt(n)
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv
  return v
}

/** Float32Array -> raw little-endian bytes, for a SQLite BLOB column. */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

/** Raw bytes -> Float32Array. Copies, so the DB buffer can be released. */
export function blobToVector(buf: Uint8Array | Buffer | ArrayBuffer): Float32Array {
  if (buf instanceof ArrayBuffer) return new Float32Array(buf.slice(0))
  const view = new Uint8Array(buf.byteLength)
  view.set(buf as Uint8Array)
  return new Float32Array(view.buffer)
}
