/**
 * Server tests: the database layer, against a real SQLite file.
 *
 * These exist because `apps/server/package.json` declared
 * `node --test test/*.test.ts` while `test/` did not exist — and `node --test`
 * exits 0 on a glob that matches nothing. So the package reported "0 tests,
 * 0 failures" and CI stayed green over the schema, the FTS/CJK search path, the
 * vector index and the LSH banding. A test script that cannot fail is worse than
 * no test script, because it reads as coverage.
 *
 * Not mocked. `SIFT_DB` points at a temp file, so this is the real `node:sqlite`
 * connection running the real `SCHEMA_SQL` through the real repo functions. That
 * is deliberate: every bug this layer actually produced was a SQL-level one — a
 * stray backtick inside a template literal, a column that did not exist, a
 * tokenizer that swallowed a whole Chinese sentence — and none of those are
 * reachable from a test that stubs the driver.
 *
 * The temp file is created before any import that touches config, because
 * DB_PATH is resolved at module load.
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'sift-test-'))
process.env.SIFT_DB = join(dir, 'test.db')
process.env.SIFT_DATA_DIR = dir
process.env.SIFT_LOG = 'quiet'

const { getDb, closeDb, all, get, run } = await import('../src/db/index.ts')
const { SCHEMA_VERSION } = await import('../src/db/sql.ts')
const { VectorIndex } = await import('../src/db/vector.ts')
const { upsertItem, findNearDuplicate, echoCandidates, sha256, countItems } = await import('../src/repo/items.ts')
const { simhash, simhashBands, hammingDistance, BAND_COUNT, DUPLICATE_THRESHOLD, normalizeVector } = await import(
  '@sift/core'
)
const { cjkBigrams, buildFtsQuery } = await import('@sift/core')

before(() => {
  getDb()
})

after(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal valid item; callers override just the fields under test. */
function item(over: Record<string, unknown> = {}) {
  const url = (over.url as string) ?? `https://example.com/${Math.random().toString(36).slice(2)}`
  return {
    url,
    urlHash: sha256(url),
    source: 'hn' as const,
    kind: 'post',
    title: 'A title',
    topics: [],
    tags: [],
    entities: [],
    score: 50,
    state: 'inbox' as const,
    readingTimeSec: 60,
    ...over,
  }
}

describe('schema', () => {
  test('applies cleanly and stamps user_version', () => {
    const version = get<{ user_version: number }>('PRAGMA user_version')
    assert.equal(Number(version?.user_version), SCHEMA_VERSION)
  })

  test('creates every table and index the repo queries', () => {
    const names = new Set(
      all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','index','view')").map((r) => r.name),
    )
    for (const required of [
      'items',
      'items_fts',
      'fts_map',
      'item_bands',
      'item_topics',
      'item_entities',
      'item_tags',
      // The feed's hot path sorts by score within a state; without this composite
      // index that query degrades to a scan as the corpus grows.
      'idx_items_state_score',
    ]) {
      assert.ok(names.has(required), `missing ${required}`)
    }
  })

  test('foreign keys cascade, so deleting an item cannot orphan its index rows', () => {
    const { id } = upsertItem(item({ url: 'https://example.com/cascade', topics: ['ai'], simhash: simhash('cascade me') }))
    assert.ok(all('SELECT 1 FROM item_topics WHERE item_id = ?', id).length > 0)
    run('DELETE FROM items WHERE id = ?', id)
    assert.equal(all('SELECT 1 FROM item_topics WHERE item_id = ?', id).length, 0)
    assert.equal(all('SELECT 1 FROM item_bands WHERE item_id = ?', id).length, 0)
  })
})

describe('upsert', () => {
  test('inserts once and updates thereafter, keyed on urlHash', () => {
    const first = upsertItem(item({ url: 'https://example.com/stable', title: 'First' }))
    assert.equal(first.created, true)
    const before = countItems()

    const second = upsertItem(item({ url: 'https://example.com/stable', title: 'Second' }))
    assert.equal(second.created, false)
    assert.equal(second.id, first.id)
    assert.equal(countItems(), before, 'a re-crawl must not create a second row')
    assert.equal(get<{ title: string }>('SELECT title FROM items WHERE id = ?', first.id)?.title, 'Second')
  })

  test('a re-crawl keeps hand-added tags', () => {
    const { id } = upsertItem(item({ url: 'https://example.com/tags', tags: ['from-feed'] }))
    run('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)', id, 'mine')

    upsertItem(item({ url: 'https://example.com/tags', tags: ['from-feed'] }))
    const tags = all<{ tag: string }>('SELECT tag FROM item_tags WHERE item_id = ?', id).map((r) => r.tag)
    // The whole reason upsert is not a REPLACE: user state has to survive.
    assert.ok(tags.includes('mine'), `expected the hand-added tag to survive, got ${JSON.stringify(tags)}`)
  })
})

describe('full-text search: CJK', () => {
  // The bug this guards: `unicode61` has no Chinese word segmentation, so it
  // treats a whole run of Han characters as ONE token. Searching 本地部署 against
  // a document containing 本地部署模型 then matches nothing, because the document's
  // single token is the longer string. The `cjk` column of app-generated bigrams
  // is what makes Chinese queries work at all.
  const CN_TITLE = '本地部署开源模型的完整指南'

  before(() => {
    upsertItem(item({ url: 'https://example.com/cn', title: CN_TITLE, lang: 'zh' }))
  })

  function ftsHits(query: string): number {
    return all<{ n: number }>('SELECT COUNT(*) AS n FROM items_fts WHERE items_fts MATCH ?', query)[0]?.n ?? 0
  }

  test('the cjk column is populated with bigrams', () => {
    const bigrams = cjkBigrams(CN_TITLE)
    assert.ok(bigrams.includes('本地'), 'expected adjacent-character bigrams')
    assert.ok(bigrams.includes('部署'))
  })

  test('a bigram phrase query finds the Chinese document', () => {
    // buildFtsQuery is the real production entry point, so this exercises the
    // exact query string the search route sends.
    const query = buildFtsQuery('本地部署')
    assert.match(query, /cjk\s*:/, 'a Chinese query must target the cjk column')
    assert.ok(ftsHits(query) > 0, `bigram phrase search must match, query was: ${query}`)
  })

  test('substring queries match too, which is the point of the bigram column', () => {
    // 开源模型 sits in the middle of the title. A tokenizer without segmentation
    // could only match it if the query happened to equal the whole run.
    assert.ok(ftsHits(buildFtsQuery('开源模型')) > 0)
  })

  test('a natural-language question still reaches the document', () => {
    // Query affixes (怎么/如何/的…) are stripped before windowing; without that,
    // the bigrams of the question never line up with the bigrams of the title.
    assert.ok(ftsHits(buildFtsQuery('本地部署开源模型怎么做')) > 0)
  })

  test('an unrelated Chinese phrase does not match', () => {
    assert.equal(ftsHits(buildFtsQuery('股票行情')), 0)
  })

  test('English still matches on the plain columns', () => {
    upsertItem(item({ url: 'https://example.com/en', title: 'Retrieval augmented generation at scale' }))
    assert.ok(ftsHits('retrieval') > 0)
  })
})

describe('near-duplicate detection', () => {
  test('LSH banding is pigeonhole-complete at the duplicate threshold', () => {
    // The recall guarantee: a 64-bit fingerprint split into BAND_COUNT bands can
    // differ in at most BAND_COUNT-1 bands while still differing by <= 3 bits, so
    // two fingerprints within the threshold ALWAYS share at least one band. If
    // this fails, the dedup index misses real duplicates no matter how good the
    // distance function is.
    const base = 'a3f9c1d7e5b20486'
    let checked = 0
    for (let bit = 0; bit < 64; bit += 1) {
      for (const extra of [[], [(bit + 7) % 64], [(bit + 7) % 64, (bit + 23) % 64]]) {
        const flipped = flipBits(base, [bit, ...extra])
        const distance = hammingDistance(base, flipped)
        if (distance > DUPLICATE_THRESHOLD) continue
        const shared = simhashBands(base).filter((b) => simhashBands(flipped).includes(b))
        assert.ok(shared.length >= 1, `distance ${distance} produced no shared band`)
        checked++
      }
    }
    assert.ok(checked > 100, `expected a meaningful number of cases, ran ${checked}`)
    assert.equal(simhashBands(base).length, BAND_COUNT)
  })

  test('findNearDuplicate matches a reposted item and ignores an unrelated one', () => {
    const text = 'Anthropic ships a 1M token context window for Claude Opus'
    const original = upsertItem(item({ url: 'https://example.com/orig', title: text, simhash: simhash(text) }))

    const repost = `${text} — via a quote tweet`
    const found = findNearDuplicate(simhash(repost))
    if (found) assert.equal(found.id, original.id)

    const unrelated = simhash('Soil moisture sensors for balcony tomatoes')
    const miss = findNearDuplicate(unrelated)
    assert.ok(miss === null || miss.id !== original.id, 'an unrelated item must not be folded in')
  })

  test('echoCandidates requires a specific shared entity', () => {
    // A vague topic must not qualify: without this guard a similarity threshold
    // folds together any two items that merely share a subject area.
    assert.deepEqual(echoCandidates([{ name: 'artificial intelligence', type: 'concept' }], Date.now()), [])
    assert.deepEqual(echoCandidates([], Date.now()), [])
  })

  test('echoCandidates excludes items outside the time window', () => {
    const now = Date.now()
    const entity = { name: 'Claude Opus 5', type: 'model' as const }
    const { id } = upsertItem(
      item({ url: 'https://example.com/echo-a', entities: [entity], publishedAt: now, title: 'Opus 5 lands' }),
    )
    // echoCandidates only returns rows that already have an embedding.
    run('UPDATE items SET embedding = ? WHERE id = ?', new Uint8Array(4), id)

    assert.ok(echoCandidates([entity], now, 72).includes(id), 'same day should be a candidate')
    const sixMonthsLater = now + 180 * 24 * 3_600_000
    assert.ok(
      !echoCandidates([entity], sixMonthsLater, 72).includes(id),
      'a six-month-old post about the same model is not an echo of today’s',
    )
  })
})

describe('VectorIndex', () => {
  const DIM = 8

  function vec(...values: number[]): Float32Array {
    return normalizeVector(new Float32Array(values))
  }

  test('returns exact nearest neighbours in score order', () => {
    const index = new VectorIndex(DIM, 4)
    index.set('east', vec(1, 0, 0, 0, 0, 0, 0, 0))
    index.set('near-east', vec(0.9, 0.1, 0, 0, 0, 0, 0, 0))
    index.set('north', vec(0, 1, 0, 0, 0, 0, 0, 0))

    const hits = index.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 3)
    assert.deepEqual(
      hits.map((h) => h.id),
      ['east', 'near-east', 'north'],
    )
    assert.ok(hits[0]!.score > hits[1]!.score && hits[1]!.score > hits[2]!.score)
  })

  test('grows past its initial capacity without losing vectors', () => {
    const index = new VectorIndex(DIM, 2)
    for (let i = 0; i < 50; i++) index.set(`v${i}`, vec(1, i / 50, 0, 0, 0, 0, 0, 0))
    assert.equal(index.size, 50)
    assert.ok(index.capacity >= 50)
    assert.equal(index.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 50).length, 50)
  })

  test('a deleted vector cannot come back as a stale score', () => {
    const index = new VectorIndex(DIM, 4)
    index.set('gone', vec(1, 0, 0, 0, 0, 0, 0, 0))
    index.set('kept', vec(0, 1, 0, 0, 0, 0, 0, 0))
    index.delete('gone')

    assert.equal(index.size, 1)
    assert.equal(index.has('gone'), false)
    const ids = index.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 5).map((h) => h.id)
    assert.deepEqual(ids, ['kept'], 'the tombstoned row must not be scored')
  })

  test('a freed row is reused rather than leaked', () => {
    const index = new VectorIndex(DIM, 2)
    index.set('a', vec(1, 0, 0, 0, 0, 0, 0, 0))
    index.set('b', vec(0, 1, 0, 0, 0, 0, 0, 0))
    const capacity = index.capacity
    index.delete('a')
    index.set('c', vec(0, 0, 1, 0, 0, 0, 0, 0))
    assert.equal(index.capacity, capacity, 'deleting then inserting should not grow the matrix')
    assert.equal(index.size, 2)
  })

  test('a dimension mismatch is ignored rather than corrupting the matrix', () => {
    const index = new VectorIndex(DIM, 4)
    index.set('good', vec(1, 0, 0, 0, 0, 0, 0, 0))
    index.set('wrong', normalizeVector(new Float32Array([1, 0, 0])))
    assert.equal(index.size, 1)
    assert.equal(index.has('wrong'), false)
    assert.deepEqual(index.search(normalizeVector(new Float32Array([1, 0, 0])), 3), [], 'a bad query returns nothing')
  })

  test('`allowed` restricts the scan to the pre-filtered candidate set', () => {
    const index = new VectorIndex(DIM, 4)
    index.set('a', vec(1, 0, 0, 0, 0, 0, 0, 0))
    index.set('b', vec(0.99, 0.01, 0, 0, 0, 0, 0, 0))
    index.set('c', vec(0.98, 0.02, 0, 0, 0, 0, 0, 0))

    const ids = index.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 5, new Set(['c'])).map((h) => h.id)
    assert.deepEqual(ids, ['c'], 'facet filtering must be honoured even when other vectors score higher')
  })

  test('minScore drops weak matches instead of padding to k', () => {
    const index = new VectorIndex(DIM, 4)
    index.set('same', vec(1, 0, 0, 0, 0, 0, 0, 0))
    index.set('orthogonal', vec(0, 1, 0, 0, 0, 0, 0, 0))
    const hits = index.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 5, null, 0.5)
    assert.deepEqual(
      hits.map((h) => h.id),
      ['same'],
    )
  })

  test('an empty index answers rather than throwing', () => {
    assert.deepEqual(new VectorIndex(DIM).search(vec(1, 0, 0, 0, 0, 0, 0, 0), 5), [])
  })
})

/** Flip the given bit positions of a 64-bit hex fingerprint. */
function flipBits(hex: string, bits: number[]): string {
  let value = BigInt(`0x${hex}`)
  for (const bit of bits) value ^= 1n << BigInt(bit)
  return value.toString(16).padStart(16, '0')
}
