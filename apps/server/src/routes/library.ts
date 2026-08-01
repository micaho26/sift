/**
 * Collections, highlights and saved searches.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { SearchQuery } from '@sift/core'
import {
  addToCollection,
  collectionItems,
  createCollection,
  createHighlight,
  createSavedSearch,
  deleteCollection,
  deleteHighlight,
  deleteSavedSearch,
  getCollection,
  listCollections,
  listHighlights,
  listSavedSearches,
  markSavedSearchSeen,
  removeFromCollection,
  updateCollection,
  updateHighlight,
  updateSavedSearch,
} from '../repo/library.ts'
import { search } from '../search.ts'

export const collectionsRoutes = new Hono()
  .get('/', (c) => c.json({ collections: listCollections() }))

  .post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(1000).optional(),
        icon: z.string().max(40).optional(),
        color: z.string().max(40).optional(),
        smartQuery: z.string().max(2000).optional(),
      }),
    ),
    (c) => c.json({ collection: createCollection(c.req.valid('json')) }, 201),
  )

  .get('/:id', async (c) => {
    const collection = getCollection(c.req.param('id'))
    if (!collection) return c.json({ error: 'Collection not found' }, 404)
    // Smart collections resolve their query at read time; manual ones use rows.
    if (collection.smartQuery) {
      const parsed = SearchQuery.safeParse(JSON.parse(collection.smartQuery || '{}'))
      const result = await search(parsed.success ? parsed.data : SearchQuery.parse({}))
      return c.json({ collection, items: result.items, smart: true })
    }
    return c.json({ collection, items: collectionItems(collection.id), smart: false })
  })

  .patch('/:id', zValidator('json', z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    icon: z.string().max(40).optional(),
    color: z.string().max(40).optional(),
    smartQuery: z.string().max(2000).optional(),
  })), (c) => {
    const collection = updateCollection(c.req.param('id'), c.req.valid('json'))
    if (!collection) return c.json({ error: 'Collection not found' }, 404)
    return c.json({ collection })
  })

  .delete('/:id', (c) => {
    const ok = deleteCollection(c.req.param('id'))
    return ok ? c.json({ ok }) : c.json({ error: 'Collection not found' }, 404)
  })

  .post(
    '/:id/items',
    zValidator('json', z.object({ itemIds: z.array(z.string()).min(1).max(500), note: z.string().max(2000).optional() })),
    (c) => {
      const id = c.req.param('id')
      if (!getCollection(id)) return c.json({ error: 'Collection not found' }, 404)
      const { itemIds, note } = c.req.valid('json')
      return c.json({ added: addToCollection(id, itemIds, note) })
    },
  )

  .delete('/:id/items', zValidator('json', z.object({ itemIds: z.array(z.string()).min(1).max(500) })), (c) => {
    return c.json({ removed: removeFromCollection(c.req.param('id'), c.req.valid('json').itemIds) })
  })

export const highlightsRoutes = new Hono()
  .get('/', (c) => c.json({ highlights: listHighlights(c.req.query('itemId') || undefined) }))

  .post(
    '/',
    zValidator(
      'json',
      z.object({
        itemId: z.string().min(1),
        text: z.string().min(1).max(10_000),
        note: z.string().max(10_000).optional(),
        color: z.enum(['yellow', 'green', 'blue', 'purple', 'red']).optional(),
        startOffset: z.number().int().nonnegative().optional(),
        endOffset: z.number().int().nonnegative().optional(),
      }),
    ),
    (c) => c.json({ highlight: createHighlight(c.req.valid('json')) }, 201),
  )

  .patch(
    '/:id',
    zValidator('json', z.object({ note: z.string().max(10_000).optional(), color: z.enum(['yellow', 'green', 'blue', 'purple', 'red']).optional() })),
    (c) => {
      const highlight = updateHighlight(c.req.param('id'), c.req.valid('json'))
      if (!highlight) return c.json({ error: 'Highlight not found' }, 404)
      return c.json({ highlight })
    },
  )

  .delete('/:id', (c) => {
    const ok = deleteHighlight(c.req.param('id'))
    return ok ? c.json({ ok }) : c.json({ error: 'Highlight not found' }, 404)
  })

export const viewsRoutes = new Hono()
  .get('/', (c) => c.json({ views: listSavedSearches() }))

  .post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120),
        query: SearchQuery,
        icon: z.string().max(40).optional(),
        pinned: z.boolean().optional(),
        alerting: z.boolean().optional(),
      }),
    ),
    (c) => c.json({ view: createSavedSearch(c.req.valid('json')) }, 201),
  )

  .patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120).optional(),
        query: SearchQuery.optional(),
        icon: z.string().max(40).optional(),
        pinned: z.boolean().optional(),
        alerting: z.boolean().optional(),
      }),
    ),
    (c) => {
      const view = updateSavedSearch(c.req.param('id'), c.req.valid('json') as never)
      if (!view) return c.json({ error: 'View not found' }, 404)
      return c.json({ view })
    },
  )

  .post('/:id/seen', (c) => {
    markSavedSearchSeen(c.req.param('id'))
    return c.json({ ok: true })
  })

  .delete('/:id', (c) => {
    const ok = deleteSavedSearch(c.req.param('id'))
    return ok ? c.json({ ok }) : c.json({ error: 'View not found' }, 404)
  })
