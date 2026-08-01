/**
 * In-process vector index.
 *
 * A local corpus is tens of thousands of items, not billions, and at that scale
 * an exact brute-force scan over one contiguous Float32Array beats an ANN index
 * on every axis that matters here: no native extension to install, no index to
 * rebuild, no recall cliff, and no stale-index bugs. 100k x 384 dims is ~38M
 * multiply-adds — around 25ms, and vectors are pre-normalised so cosine is just
 * a dot product.
 *
 * The matrix is grown geometrically and rows are tombstoned rather than spliced,
 * so inserts and deletes are O(1) and search stays sequential over memory.
 */
import { all, run } from './index.ts'

export type VectorHit = { id: string; score: number }

export class VectorIndex {
  /** Row-major matrix: row `i` occupies [i*dim, (i+1)*dim). */
  private matrix: Float32Array
  private ids: (string | null)[] = []
  private rowById = new Map<string, number>()
  private freeRows: number[] = []
  private count = 0

  // Declared explicitly rather than as a constructor parameter property: Node's
  // strip-only TypeScript mode rejects parameter properties, and the server runs
  // .ts directly in development.
  readonly dimensions: number

  constructor(dimensions: number, initialCapacity = 1024) {
    this.dimensions = dimensions
    this.matrix = new Float32Array(Math.max(1, initialCapacity) * dimensions)
  }

  get size(): number {
    return this.count
  }

  get capacity(): number {
    return this.matrix.length / this.dimensions
  }

  private grow(minRows: number): void {
    let rows = this.capacity
    while (rows < minRows) rows = Math.max(8, Math.trunc(rows * 1.75))
    const next = new Float32Array(rows * this.dimensions)
    next.set(this.matrix)
    this.matrix = next
  }

  /** Insert or replace one vector. Silently ignores a dimension mismatch. */
  set(id: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) return
    let row = this.rowById.get(id)
    if (row === undefined) {
      row = this.freeRows.pop()
      if (row === undefined) {
        row = this.ids.length
        if (row + 1 > this.capacity) this.grow(row + 1)
        this.ids.push(id)
      } else {
        this.ids[row] = id
      }
      this.rowById.set(id, row)
      this.count++
    }
    this.matrix.set(vector, row * this.dimensions)
  }

  delete(id: string): void {
    const row = this.rowById.get(id)
    if (row === undefined) return
    this.rowById.delete(id)
    this.ids[row] = null
    this.freeRows.push(row)
    this.count--
    // Zeroing matters: a tombstoned row must never contribute a stale score.
    this.matrix.fill(0, row * this.dimensions, (row + 1) * this.dimensions)
  }

  has(id: string): boolean {
    return this.rowById.has(id)
  }

  get(id: string): Float32Array | null {
    const row = this.rowById.get(id)
    if (row === undefined) return null
    return this.matrix.slice(row * this.dimensions, (row + 1) * this.dimensions)
  }

  /**
   * Exact top-k by cosine similarity (== dot product on normalised vectors).
   *
   * `allowed` restricts the scan to a pre-filtered candidate set, which is how
   * faceted search stays fast: SQL narrows to 400 rows, then we only score those.
   */
  search(query: Float32Array, k: number, allowed?: Set<string> | null, minScore = -1): VectorHit[] {
    if (query.length !== this.dimensions || this.count === 0 || k <= 0) return []
    const dim = this.dimensions
    const m = this.matrix

    // Bounded insertion-sorted top-k. For the k<=200 we ever ask for, this beats
    // a heap on constant factors and keeps results already ordered.
    const bestScores: number[] = []
    const bestIds: string[] = []
    let worst = minScore

    const scanRow = (row: number, id: string) => {
      const base = row * dim
      let dot = 0
      // Unrolled by 4: ~20% faster in V8 than a plain loop at this size.
      let i = 0
      const limit = dim - 3
      for (; i < limit; i += 4) {
        dot += m[base + i]! * query[i]! + m[base + i + 1]! * query[i + 1]! + m[base + i + 2]! * query[i + 2]! + m[base + i + 3]! * query[i + 3]!
      }
      for (; i < dim; i++) dot += m[base + i]! * query[i]!

      if (bestScores.length >= k && dot <= worst) return
      let pos = bestScores.length
      while (pos > 0 && bestScores[pos - 1]! < dot) pos--
      bestScores.splice(pos, 0, dot)
      bestIds.splice(pos, 0, id)
      if (bestScores.length > k) {
        bestScores.pop()
        bestIds.pop()
      }
      if (bestScores.length >= k) worst = bestScores[bestScores.length - 1]!
    }

    if (allowed) {
      // Iterate the (smaller) candidate set rather than the whole matrix.
      for (const id of allowed) {
        const row = this.rowById.get(id)
        if (row !== undefined) scanRow(row, id)
      }
    } else {
      for (let row = 0; row < this.ids.length; row++) {
        const id = this.ids[row]
        if (id === null || id === undefined) continue
        scanRow(row, id)
      }
    }

    const out: VectorHit[] = []
    for (let i = 0; i < bestIds.length; i++) {
      if (bestScores[i]! < minScore) break
      out.push({ id: bestIds[i]!, score: bestScores[i]! })
    }
    return out
  }

  /** Highest similarity to anything in the index — the novelty measurement. */
  maxSimilarity(query: Float32Array, exclude?: string): number {
    if (query.length !== this.dimensions || this.count === 0) return 0
    const hits = this.search(query, exclude ? 2 : 1)
    for (const hit of hits) {
      if (exclude && hit.id === exclude) continue
      return Math.max(0, hit.score)
    }
    return 0
  }

  clear(): void {
    this.matrix.fill(0)
    this.ids = []
    this.rowById.clear()
    this.freeRows = []
    this.count = 0
  }

  /** Bytes held by the matrix — surfaced in /health so growth is visible. */
  memoryBytes(): number {
    return this.matrix.byteLength
  }
}

/* ----------------------------------------------------------- persistence -- */

let index: VectorIndex | null = null

/**
 * Load every stored embedding into memory once at boot. At 384 dims a 100k-item
 * corpus is 154 MB — acceptable for a desktop tool, and the alternative (reading
 * BLOBs per query) is ~50x slower.
 */
export function initVectorIndex(dimensions: number): VectorIndex {
  const next = new VectorIndex(dimensions, 4096)
  const rows = all<{ id: string; embedding: Uint8Array | null }>(
    'SELECT id, embedding FROM items WHERE embedding IS NOT NULL AND duplicate_of IS NULL',
  )
  for (const row of rows) {
    if (!row.embedding) continue
    const vector = decodeVector(row.embedding)
    if (vector.length === dimensions) next.set(row.id, vector)
  }
  index = next
  return next
}

export function getVectorIndex(): VectorIndex {
  if (!index) throw new Error('Vector index not initialised — call initVectorIndex() during boot')
  return index
}

export function vectorIndexReady(): boolean {
  return index !== null
}

/** Persist to the BLOB column and mirror into the in-memory index. */
export function saveVector(itemId: string, vector: Float32Array, model: string): void {
  run('UPDATE items SET embedding = ?, embed_model = ? WHERE id = ?', encodeVector(vector), model, itemId)
  index?.set(itemId, vector)
}

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  // Copy: the SQLite-owned buffer may be reused, and an unaligned byteOffset
  // would make the Float32Array view throw.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}
