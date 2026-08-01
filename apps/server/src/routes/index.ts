/**
 * The API router, plus the SSE stream and health endpoints.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { SIFT_SERVICE, SIFT_VERSION, type HealthResponse, type StreamEvent } from '@sift/core'
import { dbSizeBytes } from '../db/index.ts'
import { getVectorIndex, vectorIndexReady } from '../db/vector.ts'
import { getEmbedder } from '../embed.ts'
import { subscribe, subscriberCount } from '../events.ts'
import { aiStatus } from '../ai/provider.ts'
import { countItems } from '../repo/items.ts'
import { itemsRoutes } from './items.ts'
import { ingestRoutes, searchRoutes } from './search.ts'
import { collectionsRoutes, highlightsRoutes, viewsRoutes } from './library.ts'
import { settingsRoutes, sourcesRoutes } from './sources.ts'
import { aiRoutes, digestRoutes } from './ai.ts'
import { analyticsRoutes, exportRoutes } from './analytics.ts'

const bootedAt = Date.now()

export const api = new Hono()

  /**
   * Health doubles as the extension's handshake: `service: "sift"` is how the
   * content script confirms the port it found is really us and not some other
   * process that happens to answer on 4471.
   */
  .get('/health', (c) => {
    const embedder = getEmbedder()
    const response: HealthResponse = {
      ok: true,
      version: SIFT_VERSION,
      service: SIFT_SERVICE,
      db: {
        items: countItems(),
        sizeBytes: dbSizeBytes(),
        vectorSearch: vectorIndexReady() && getVectorIndex().size > 0,
        fullTextSearch: true,
      },
      embeddings: { provider: embedder.name, ready: embedder.ready, dimensions: embedder.dimensions },
      ai: { provider: aiStatus().provider, configured: aiStatus().configured },
      uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    }
    return c.json(response)
  })

  /** Live updates. One connection per tab; heartbeat keeps proxies from idling out. */
  .get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false
      const send = (event: StreamEvent) => {
        if (closed) return
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      }
      const unsubscribe = subscribe(send)
      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })

      await stream.writeSSE({ event: 'ping', data: JSON.stringify({ type: 'ping', t: Date.now() }) })
      // Hold the stream open with a periodic comment frame.
      while (!closed) {
        await stream.sleep(25_000)
        if (closed) break
        await stream.writeSSE({ event: 'ping', data: JSON.stringify({ type: 'ping', t: Date.now() }) })
      }
    }),
  )

  .get('/stats/clients', (c) => c.json({ subscribers: subscriberCount() }))

  .route('/items', itemsRoutes)
  .route('/search', searchRoutes)
  .route('/ingest', ingestRoutes)
  .route('/collections', collectionsRoutes)
  .route('/highlights', highlightsRoutes)
  .route('/views', viewsRoutes)
  .route('/sources', sourcesRoutes)
  .route('/settings', settingsRoutes)
  .route('/ai', aiRoutes)
  .route('/digests', digestRoutes)
  .route('/analytics', analyticsRoutes)
  .route('/export', exportRoutes)

export type ApiRoutes = typeof api
