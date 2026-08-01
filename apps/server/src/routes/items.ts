/**
 * Item routes: read, triage, tag, annotate, delete.
 *
 * Triage endpoints accept arrays throughout. Every one of them is reachable from a
 * multi-select in the UI, and a client that has to loop is a client that produces
 * N round-trips and a half-applied state when one fails.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { ItemState, explainScore } from '@sift/core'
import { emitRemoved, emitUpdated } from '../events.ts'
import { similarItems } from '../search.ts'
import { collectionsForItem, listHighlights } from '../repo/library.ts'
import { invalidateInterestProfile } from '../pipeline/interests.ts'
import {
  deleteItems,
  emptyTrash,
  findById,
  findManyByIds,
  logEvent,
  markRead,
  setAiFields,
  setStarred,
  setState,
  setTags,
  stateCounts,
} from '../repo/items.ts'

const ids = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })

export const itemsRoutes = new Hono()

  /** Sidebar badge counts. */
  .get('/counts', (c) => c.json(stateCounts()))

  .get('/:id', (c) => {
    const item = findById(c.req.param('id'))
    if (!item) return c.json({ error: 'Item not found' }, 404)
    return c.json({
      item,
      highlights: listHighlights(item.id),
      collections: collectionsForItem(item.id),
      // Recomputed rather than stored: cheap, and always matches current copy.
      why: item.scoreBreakdown ? explainScore(item.scoreBreakdown) : [],
      similar: similarItems(item.id, 6),
    })
  })

  /** Batch fetch preserving the caller's order — used after a search. */
  .post('/batch', zValidator('json', ids), (c) => {
    return c.json({ items: findManyByIds(c.req.valid('json').ids) })
  })

  .post('/state', zValidator('json', ids.extend({ state: ItemState })), (c) => {
    const { ids: itemIds, state } = c.req.valid('json')
    const changed = setState(itemIds, state)
    emitUpdated(itemIds)
    // Saving changes what "relevant" means, so the interest model must be redone.
    if (state === 'saved' || state === 'shortlist') invalidateInterestProfile()
    return c.json({ changed, state })
  })

  .post('/star', zValidator('json', ids.extend({ starred: z.boolean() })), (c) => {
    const { ids: itemIds, starred } = c.req.valid('json')
    const changed = setStarred(itemIds, starred)
    emitUpdated(itemIds)
    if (starred) invalidateInterestProfile()
    return c.json({ changed, starred })
  })

  .post(
    '/read',
    zValidator('json', ids.extend({ read: z.boolean().default(true), dwellSec: z.number().min(0).max(86_400).default(0) })),
    (c) => {
      const { ids: itemIds, read, dwellSec } = c.req.valid('json')
      const changed = markRead(itemIds, read, dwellSec)
      emitUpdated(itemIds)
      return c.json({ changed, read })
    },
  )

  .put('/:id/tags', zValidator('json', z.object({ tags: z.array(z.string()).max(64) })), (c) => {
    const id = c.req.param('id')
    if (!findById(id)) return c.json({ error: 'Item not found' }, 404)
    const tags = setTags(id, c.req.valid('json').tags)
    emitUpdated([id])
    return c.json({ tags })
  })

  /** Manual override of the AI fields — the user always gets the last word. */
  .put(
    '/:id/ai',
    zValidator(
      'json',
      z.object({
        summary: z.string().max(8000).optional(),
        translation: z.string().max(200_000).optional(),
        takeaways: z.array(z.string().max(400)).max(12).optional(),
      }),
    ),
    (c) => {
      const id = c.req.param('id')
      if (!findById(id)) return c.json({ error: 'Item not found' }, 404)
      setAiFields(id, c.req.valid('json'))
      emitUpdated([id])
      return c.json({ ok: true })
    },
  )

  .delete('/', zValidator('json', ids), (c) => {
    const { ids: itemIds } = c.req.valid('json')
    const removed = deleteItems(itemIds)
    emitRemoved(itemIds)
    logEvent('item.delete', undefined, { count: removed })
    return c.json({ removed })
  })

  .post('/trash/empty', (c) => {
    const removed = emptyTrash(0)
    return c.json({ removed })
  })

  .get('/:id/similar', (c) => {
    const limit = Math.min(24, Number(c.req.query('limit') ?? 8) || 8)
    return c.json({ items: similarItems(c.req.param('id'), limit) })
  })
