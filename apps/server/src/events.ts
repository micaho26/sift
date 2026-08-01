/**
 * Server-sent-event bus.
 *
 * One in-process emitter, many browser tabs. Events are fire-and-forget: a slow
 * or dead client is dropped rather than allowed to apply backpressure to the
 * ingestion pipeline. Coalescing matters — a 200-item extension batch must
 * produce one `items:new` event, not 200 of them, or the feed thrashes.
 */
import type { StreamEvent } from '@sift/core'
import { log } from './log.ts'

type Subscriber = {
  id: number
  send: (event: StreamEvent) => void
}

let nextId = 1
const subscribers = new Set<Subscriber>()

/** Pending `items:new` ids, flushed on a short timer to coalesce bursts. */
let pendingNew: { ids: string[]; topScore: number } | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
const COALESCE_MS = 250

export function subscribe(send: (event: StreamEvent) => void): () => void {
  const subscriber: Subscriber = { id: nextId++, send }
  subscribers.add(subscriber)
  log.debug(`SSE client ${subscriber.id} connected (${subscribers.size} total)`)
  return () => {
    subscribers.delete(subscriber)
    log.debug(`SSE client ${subscriber.id} disconnected (${subscribers.size} total)`)
  }
}

export function subscriberCount(): number {
  return subscribers.size
}

export function emit(event: StreamEvent): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.send(event)
    } catch {
      // A write failure means the socket is gone; stop tracking it.
      subscribers.delete(subscriber)
    }
  }
}

/** Coalesced new-item notification. */
export function emitNewItems(ids: string[], topScore: number): void {
  if (!ids.length) return
  if (!pendingNew) pendingNew = { ids: [], topScore: 0 }
  pendingNew.ids.push(...ids)
  pendingNew.topScore = Math.max(pendingNew.topScore, topScore)

  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const batch = pendingNew
    pendingNew = null
    if (!batch) return
    emit({ type: 'items:new', count: batch.ids.length, ids: batch.ids.slice(0, 200), topScore: batch.topScore })
  }, COALESCE_MS)
  // Never hold the process open just for a pending flush.
  flushTimer.unref?.()
}

export function emitUpdated(ids: string[]): void {
  if (ids.length) emit({ type: 'items:updated', ids })
}

export function emitRemoved(ids: string[]): void {
  if (ids.length) emit({ type: 'items:removed', ids })
}

export function emitJob(
  name: string,
  state: 'start' | 'progress' | 'done' | 'error',
  extra: { progress?: number; message?: string } = {},
): void {
  emit({ type: 'job', name, state, ...extra })
}

export function emitSourceStatus(
  id: string,
  state: 'running' | 'ok' | 'error',
  extra: { message?: string; collected?: number } = {},
): void {
  emit({ type: 'source:status', id, state, ...extra })
}
