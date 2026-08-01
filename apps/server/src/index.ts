/**
 * Server entry point.
 *
 * Boot order is deliberate: open the DB, load vectors, resolve the embedder, then
 * listen. Nothing that can fail slowly (a model download, an unreachable Ollama)
 * is allowed to block the port from opening — the UI must be able to paint and
 * explain itself even when a provider is misconfigured.
 */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SIFT_VERSION } from '@sift/core'
import { DEV_WEB_ORIGINS, HOST, IS_PROD, MODELS_DIR, PORT, REPO_ROOT, WEB_DIST, ensureDirs } from './config.ts'
import { closeDb, getDb } from './db/index.ts'
import { initVectorIndex } from './db/vector.ts'
import { configureEmbedder, getEmbedder } from './embed.ts'
import { color, log } from './log.ts'
import { api } from './routes/index.ts'
import { countItems } from './repo/items.ts'
import { getSecret, readSettings } from './repo/settings.ts'
import { ensureDefaultSources } from './repo/sources.ts'
import { rebuildInterestProfile } from './pipeline/interests.ts'
import { startScheduler, stopScheduler } from './connectors/scheduler.ts'

const app = new Hono()

/**
 * CORS. The API binds to loopback and stores no capability a page could not
 * already exercise as the user, so the policy is permissive for extension origins
 * and localhost, and closed to everything else.
 */
app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return '*' // same-origin, curl, or the extension's service worker
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return origin
      if (DEV_WEB_ORIGINS.includes(origin)) return origin
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
      return null
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
    credentials: false,
    maxAge: 86_400,
  }),
)

// Request log, debug level only — a per-request line ruins `pnpm dev` output.
app.use('*', async (c, next) => {
  const started = performance.now()
  await next()
  log.debug(`${c.req.method} ${c.req.path} → ${c.res.status} (${Math.round(performance.now() - started)}ms)`)
})

app.route('/api', api)

app.onError((error, c) => {
  log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, error)
  return c.json({ error: 'Internal error', detail: error.message }, 500)
})

/* ------------------------------------------------------- static web app -- */

if (existsSync(join(WEB_DIST, 'index.html'))) {
  const indexHtml = readFileSync(join(WEB_DIST, 'index.html'), 'utf8')
  // serveStatic wants a path relative to cwd; the server may be started anywhere.
  const rootRelative = relative(process.cwd(), WEB_DIST) || '.'

  app.use('/assets/*', serveStatic({ root: rootRelative }))
  app.use('/*', serveStatic({ root: rootRelative }))
  // SPA fallback: any unmatched non-API route renders the app shell.
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404)
    return c.html(indexHtml)
  })
} else {
  app.get('/', (c) =>
    c.json({
      service: 'sift',
      version: SIFT_VERSION,
      hint: 'The web app is not built. Run `pnpm dev` for the dev server, or `pnpm build && pnpm start` to serve everything from this port.',
      api: '/api/health',
    }),
  )
}

/* ------------------------------------------------------------------- boot -- */

async function boot(): Promise<void> {
  const started = performance.now()
  ensureDirs()

  getDb()
  const created = ensureDefaultSources()

  const settings = readSettings()
  // Resolve the embedder before loading vectors so dimensions agree.
  await configureEmbedder(settings, { openaiKey: getSecret('openai') }, MODELS_DIR)
  const embedder = getEmbedder()
  const index = initVectorIndex(embedder.dimensions)
  await rebuildInterestProfile(true)

  const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    const url = `http://${HOST}:${info.port}`
    const items = countItems()
    const bootMs = Math.round(performance.now() - started)

    if (process.env.SIFT_QUIET_BANNER !== '1') {
      process.stdout.write(
        [
          '',
          `  ${color.violet('◆')} ${color.bold('Sift')} ${color.dim(`v${SIFT_VERSION}`)}  ${color.dim('·')}  ${color.cyan(url)}`,
          `  ${color.dim(`${items} items · ${index.size} vectors · ${embedder.name}/${embedder.dimensions}d · booted in ${bootMs}ms`)}`,
          created ? `  ${color.dim(`seeded ${created} default sources`)}` : '',
          '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    // The dev launcher waits for this exact line before opening the browser.
    process.stdout.write(`sift:ready ${url}\n`)
  })

  startScheduler()

  const shutdown = (signal: string) => {
    log.debug(`Received ${signal}, shutting down`)
    stopScheduler()
    server.close(() => {
      closeDb()
      process.exit(0)
    })
    // Never hang on a stuck socket.
    setTimeout(() => {
      closeDb()
      process.exit(0)
    }, 2500).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => log.error('Uncaught exception', error))
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason))
}

void boot().catch((error) => {
  log.error('Sift failed to start', error)
  if (String(error?.message ?? '').includes('EADDRINUSE')) {
    log.warn(`Port ${PORT} is already in use. Set SIFT_PORT=<port> to use another one.`)
  }
  process.exit(1)
})

export { app, REPO_ROOT, IS_PROD }
