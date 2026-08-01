/**
 * The background scheduler.
 *
 * A single timer that wakes every 30 seconds and does the least urgent useful
 * work available. Sequential by design — a local tool competing with the user's
 * editor for CPU is worse than one that takes an extra minute to poll a feed.
 */
import type { SourceConfig } from '@sift/core'
import { emitJob, emitSourceStatus } from '../events.ts'
import { log } from '../log.ts'
import { maintenance } from '../db/index.ts'
import { getEmbedder } from '../embed.ts'
import { saveVector } from '../db/vector.ts'
import { itemsMissingEmbedding, emptyTrash } from '../repo/items.ts'
import { dueSources, recordRun } from '../repo/sources.ts'
import { rebuildInterestProfile } from '../pipeline/interests.ts'
import { ingest } from '../pipeline/ingest.ts'
import { runConnector } from './index.ts'
import { kvGet, kvSet, readSettings } from '../repo/settings.ts'
import { generateDigest } from '../ai/digest.ts'

const TICK_MS = 30_000
const MAINTENANCE_INTERVAL_MS = 6 * 3_600_000

let timer: ReturnType<typeof setInterval> | null = null
let running = false

export async function pollSource(source: SourceConfig): Promise<{ collected: number; error?: string }> {
  emitSourceStatus(source.id, 'running')
  try {
    const items = await runConnector(source)
    if (!items.length) {
      recordRun(source.id, { collected: 0 })
      emitSourceStatus(source.id, 'ok', { collected: 0 })
      return { collected: 0 }
    }
    const result = await ingest(items, { collector: `connector:${source.kind}:${source.id}` })
    recordRun(source.id, { collected: result.created })
    emitSourceStatus(source.id, 'ok', { collected: result.created })
    log.debug(`${source.name}: +${result.created} new, ${result.duplicates} dup, ${result.rejected} rejected`)
    return { collected: result.created }
  } catch (error) {
    const message = (error as Error).message
    recordRun(source.id, { error: message })
    emitSourceStatus(source.id, 'error', { message })
    log.warn(`${source.name} failed: ${message}`)
    return { collected: 0, error: message }
  }
}

/** Poll everything that is due. Returns how many items were created. */
export async function pollDueSources(): Promise<number> {
  const due = dueSources()
  if (!due.length) return 0

  emitJob('sources', 'start', { message: `Checking ${due.length} source${due.length === 1 ? '' : 's'}` })
  let total = 0
  for (const [index, source] of due.entries()) {
    const { collected } = await pollSource(source)
    total += collected
    emitJob('sources', 'progress', { progress: (index + 1) / due.length, message: source.name })
  }
  emitJob('sources', 'done', { message: total ? `${total} new item${total === 1 ? '' : 's'}` : 'Up to date' })
  return total
}

/**
 * Embed items that have none, or whose vector came from a different model. Runs
 * in small batches so switching embedding providers backfills gradually instead
 * of blocking the server for minutes.
 */
export async function backfillEmbeddings(batchSize = 64): Promise<number> {
  const embedder = getEmbedder()
  const pending = itemsMissingEmbedding(embedder.model, batchSize)
  if (!pending.length) return 0

  const texts = pending.map((row) => [row.title, row.summary ?? '', (row.content ?? '').slice(0, 4000)].filter(Boolean).join('\n\n'))
  try {
    const vectors = await embedder.embed(texts)
    let written = 0
    for (const [index, row] of pending.entries()) {
      const vector = vectors[index]
      if (!vector || vector.length !== embedder.dimensions) continue
      saveVector(row.id, vector, embedder.model)
      written++
    }
    if (written) log.debug(`Embedded ${written} items with ${embedder.model}`)
    return written
  } catch (error) {
    log.warn(`Embedding backfill failed: ${(error as Error).message}`)
    return 0
  }
}

/** Produce the daily digest once per local day, at the configured hour. */
async function maybeGenerateDigest(): Promise<void> {
  const settings = readSettings()
  if (!settings.digest.enabled) return

  const now = new Date()
  if (now.getHours() < settings.digest.hourLocal) return

  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (kvGet<string>('digest:lastDay', '') === today) return

  try {
    await generateDigest({ hours: 24, maxItems: settings.digest.maxItems })
    kvSet('digest:lastDay', today)
    log.ok('Daily digest ready')
  } catch (error) {
    log.warn(`Digest generation failed: ${(error as Error).message}`)
  }
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    await pollDueSources()
    await backfillEmbeddings()
    await rebuildInterestProfile()
    await maybeGenerateDigest()

    const lastMaintenance = kvGet<number>('maintenance:lastAt', 0)
    if (Date.now() - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
      emptyTrash(30)
      maintenance()
      kvSet('maintenance:lastAt', Date.now())
      log.debug('Ran database maintenance')
    }
  } catch (error) {
    log.error('Scheduler tick failed', error)
  } finally {
    running = false
  }
}

export function startScheduler(): void {
  if (timer) return
  // Screenshot and test runs need a corpus that does not change under them.
  if (process.env.SIFT_NO_SCHEDULER === '1') {
    log.debug('Scheduler disabled by SIFT_NO_SCHEDULER')
    return
  }
  // Delay the first tick so startup stays fast and the UI paints immediately.
  const initial = setTimeout(() => void tick(), 4000)
  initial.unref?.()
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref?.()
  log.debug('Scheduler started')
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Force a full refresh — the UI's "Refresh all" button. */
export async function refreshAll(): Promise<{ collected: number }> {
  const { listSources } = await import('../repo/sources.ts')
  const sources = listSources().filter((s) => s.enabled && s.intervalMinutes > 0)
  emitJob('refresh', 'start', { message: `Refreshing ${sources.length} sources` })
  let collected = 0
  for (const [index, source] of sources.entries()) {
    const result = await pollSource(source)
    collected += result.collected
    emitJob('refresh', 'progress', { progress: (index + 1) / Math.max(1, sources.length), message: source.name })
  }
  await backfillEmbeddings(256)
  await rebuildInterestProfile(true)
  emitJob('refresh', 'done', { message: `${collected} new item${collected === 1 ? '' : 's'}` })
  return { collected }
}
