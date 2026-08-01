/**
 * Sources and settings.
 *
 * The settings endpoint has one rule worth stating: API keys go in and never come
 * out. `GET /settings` reports `apiKeySet: true`, never the key itself, so no page
 * running in the user's browser can lift a credential out of the local server.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { SOURCES, Settings, SourceKind } from '@sift/core'
import { DEFAULT_SOURCES, createSource, deleteSource, ensureDefaultSources, getSource, listSources, updateSource } from '../repo/sources.ts'
import { hasConnector, PUSH_ONLY_SOURCES } from '../connectors/index.ts'
import { pollSource, refreshAll } from '../connectors/scheduler.ts'
import { configureEmbedder } from '../embed.ts'
import { MODELS_DIR } from '../config.ts'
import { getSecret, readSettings, setSecret, writeSettings } from '../repo/settings.ts'
import { invalidateInterestProfile } from '../pipeline/interests.ts'
import { rescoreAll } from '../pipeline/rescore.ts'
import { aiStatus } from '../ai/provider.ts'

export const sourcesRoutes = new Hono()
  .get('/', (c) =>
    c.json({
      sources: listSources().map((source) => ({
        ...source,
        pollable: hasConnector(source.kind),
        pushOnly: PUSH_ONLY_SOURCES.includes(source.kind),
      })),
      available: SOURCES.map((kind) => ({
        kind,
        pollable: hasConnector(kind as SourceKind),
        pushOnly: PUSH_ONLY_SOURCES.includes(kind as SourceKind),
      })),
      presets: DEFAULT_SOURCES,
    }),
  )

  .post(
    '/',
    zValidator(
      'json',
      z.object({
        kind: SourceKind,
        name: z.string().min(1).max(160),
        target: z.string().min(1).max(2048),
        intervalMinutes: z.number().int().min(0).max(10_080).optional(),
        trust: z.number().min(0).max(2).optional(),
        enabled: z.boolean().optional(),
        filters: z
          .object({
            includeKeywords: z.array(z.string()).optional(),
            excludeKeywords: z.array(z.string()).optional(),
            minEngagement: z.number().int().nonnegative().optional(),
            lang: z.array(z.string()).optional(),
          })
          .optional(),
      }),
    ),
    (c) => c.json({ source: createSource(c.req.valid('json')) }, 201),
  )

  .patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(160).optional(),
        target: z.string().min(1).max(2048).optional(),
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(0).max(10_080).optional(),
        trust: z.number().min(0).max(2).optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    (c) => {
      const source = updateSource(c.req.param('id'), c.req.valid('json') as never)
      if (!source) return c.json({ error: 'Source not found' }, 404)
      return c.json({ source })
    },
  )

  .delete('/:id', (c) => {
    const ok = deleteSource(c.req.param('id'))
    return ok ? c.json({ ok }) : c.json({ error: 'Source not found' }, 404)
  })

  /** Poll one source now. */
  .post('/:id/run', async (c) => {
    const source = getSource(c.req.param('id'))
    if (!source) return c.json({ error: 'Source not found' }, 404)
    const result = await pollSource(source)
    return c.json(result)
  })

  /** Poll everything, then backfill embeddings and rebuild the interest model. */
  .post('/refresh', async (c) => c.json(await refreshAll()))

  .post('/defaults', (c) => c.json({ created: ensureDefaultSources() }))

export const settingsRoutes = new Hono()
  .get('/', (c) => {
    const settings = readSettings()
    return c.json({
      settings: {
        ...settings,
        // Never leak the key; only whether one exists.
        ai: { ...settings.ai, apiKeySet: Boolean(getSecret(settings.ai.provider === 'openai' ? 'openai' : 'anthropic')) },
      },
      ai: aiStatus(settings),
    })
  })

  .put('/', zValidator('json', Settings.partial()), async (c) => {
    const before = readSettings()
    const patch = c.req.valid('json')
    const settings = writeSettings(patch as never)

    // Changing what we care about invalidates the derived model...
    const interestsChanged = JSON.stringify(before.interests) !== JSON.stringify(settings.interests)
    const weightsChanged = JSON.stringify(before.weights) !== JSON.stringify(settings.weights)
    const halfLifeChanged = before.recencyHalfLifeHours !== settings.recencyHalfLifeHours
    if (interestsChanged) invalidateInterestProfile()

    // ...and changing the embedder invalidates every vector, so it is reloaded.
    const embeddingChanged =
      before.embeddings.provider !== settings.embeddings.provider || before.embeddings.model !== settings.embeddings.model
    if (embeddingChanged) {
      await configureEmbedder(settings, { openaiKey: getSecret('openai') }, MODELS_DIR)
    }

    // Rescore in the background: the response must not wait on a full pass.
    if (interestsChanged || weightsChanged || halfLifeChanged) {
      void rescoreAll().catch(() => undefined)
    }

    return c.json({
      settings: { ...settings, ai: { ...settings.ai, apiKeySet: Boolean(getSecret(settings.ai.provider === 'openai' ? 'openai' : 'anthropic')) } },
      rescoring: interestsChanged || weightsChanged || halfLifeChanged,
    })
  })

  /** Write-only key storage. */
  .put(
    '/keys',
    zValidator('json', z.object({ provider: z.enum(['anthropic', 'openai']), key: z.string().max(400).nullable() })),
    (c) => {
      const { provider, key } = c.req.valid('json')
      setSecret(provider, key && key.trim() ? key.trim() : null)
      return c.json({ ok: true, provider, set: Boolean(key && key.trim()) })
    },
  )
