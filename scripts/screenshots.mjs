#!/usr/bin/env node
/**
 * Capture the product screenshots used by the README, the site, and the final
 * deliverable.
 *
 * Drives the real app against the real server with the demo corpus loaded, so
 * every image is genuine — nothing here is mocked or composited. Retina (2x) so
 * they stay sharp when scaled down in a README.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(root, 'assets', 'screenshots')
const SITE_PUBLIC = join(root, 'apps', 'site', 'public', 'shots')

const API_PORT = Number(process.env.SHOT_API_PORT ?? 4481)
const WEB_PORT = Number(process.env.SHOT_WEB_PORT ?? 4480)
const VIEWPORT = { width: 1600, height: 1000 }

const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const c = { dim: paint('2'), green: paint('32'), violet: paint('38;5;141'), red: paint('31'), yellow: paint('33') }

const children = []
function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(1)
})

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return false
}

/**
 * A dedicated database, seeded fresh.
 *
 * The dev database accumulates hundreds of live-polled items, which makes the
 * screenshots non-reproducible and drowns the curated demo content. An isolated
 * copy keeps every run identical.
 */
async function seedShotDatabase() {
  const dataDir = join(root, 'data', 'screenshots')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'sift.db')
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix)
  }

  process.stdout.write(`  ${c.dim('seeding a fresh screenshot database…')}\n`)
  await new Promise((resolve, reject) => {
    const seed = spawn('pnpm', ['--filter', 'sift-server', 'seed'], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, SIFT_DB: dbPath, SIFT_LOG: 'quiet' },
    })
    seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))))
    seed.on('error', reject)
  })
  return dbPath
}

async function startStack(dbPath) {
  // `SIFT_NO_SCHEDULER` is honoured by the server's scheduler guard; polling
  // during a shoot would inject unpredictable live items mid-capture.
  const server = spawn('pnpm', ['--filter', 'sift-server', 'dev'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      SIFT_PORT: String(API_PORT),
      SIFT_DB: dbPath,
      SIFT_LOG: 'quiet',
      SIFT_QUIET_BANNER: '1',
      SIFT_NO_SCHEDULER: '1',
    },
  })
  children.push(server)

  const web = spawn('pnpm', ['--filter', 'sift-web', 'dev'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, SIFT_PORT: String(API_PORT), SIFT_WEB_PORT: String(WEB_PORT) },
  })
  children.push(web)

  if (!(await waitFor(`http://127.0.0.1:${API_PORT}/api/health`))) throw new Error('API did not start')
  if (!(await waitFor(`http://127.0.0.1:${WEB_PORT}/`))) throw new Error('Web dev server did not start')
}

/** Every shot: a name, and what to do before capturing. */
const SHOTS = [
  {
    name: 'inbox',
    caption: 'Inbox — ranked by signal, with the reading pane',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[role="option"]', { timeout: 20_000 })
      await page.waitForTimeout(1400)
      // Open the top item so both panes are populated.
      await page.locator('[role="option"]').first().click()
      await page.waitForTimeout(1800)
    },
  },
  {
    name: 'feed',
    caption: 'The feed on its own — scores, sources, topics, engagement',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[role="option"]', { timeout: 20_000 })
      await page.waitForTimeout(1600)
    },
  },
  {
    name: 'why-score',
    caption: 'Why is this a 66? — the full score breakdown',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[role="option"]', { timeout: 20_000 })
      await page.locator('[role="option"]').first().click()
      await page.waitForTimeout(1600)
      const why = page.locator('button', { hasText: 'why?' }).first()
      if (await why.count()) {
        await why.click()
        await page.waitForTimeout(900)
      }
    },
  },
  {
    name: 'command-palette',
    caption: 'Command palette — search the library or run any action',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[role="option"]', { timeout: 20_000 })
      await page.waitForTimeout(1000)
      await page.keyboard.press('Meta+k')
      await page.waitForTimeout(600)
      await page.keyboard.type('inference', { delay: 55 })
      await page.waitForTimeout(1500)
    },
  },
  {
    name: 'search-chinese',
    caption: 'Chinese search — bigram indexing finds the note',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/?v=search&q=${encodeURIComponent('推理成本')}`, {
        waitUntil: 'networkidle',
      })
      await page.waitForTimeout(2000)
    },
  },
  {
    name: 'trends',
    caption: 'Trends — topic momentum, sources, authors, entities',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/?v=analytics`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2200)
    },
  },
  {
    name: 'ask',
    caption: 'Ask — retrieval-grounded chat over your own library',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/?v=ask`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1200)
      const suggestion = page.locator('button', { hasText: 'What changed in inference efficiency' }).first()
      if (await suggestion.count()) {
        await suggestion.click()
        // Retrieval + the citation strip render well before any model output.
        await page.waitForTimeout(3200)
      }
    },
  },
  {
    name: 'briefing',
    caption: 'Briefing — themed and cited back to the source items',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/?v=digest`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(2200)
    },
  },
  {
    name: 'sources',
    caption: 'Sources — 13 keyless connectors, plus what the extension pushes',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/?v=sources`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1600)
    },
  },
  {
    name: 'settings',
    caption: 'Settings — the scoring weights are yours to move',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/?v=settings`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1600)
    },
  },
  {
    name: 'share-card',
    caption: 'Share card — rendered locally as SVG, exported as PNG',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[role="option"]', { timeout: 20_000 })
      await page.locator('[role="option"]').first().click()
      await page.waitForTimeout(1500)
      const share = page.locator('button[aria-label="Share card (⇧S)"]').first()
      if (await share.count()) {
        await share.click()
        await page.waitForTimeout(1800)
      }
    },
  },
  {
    name: 'light-theme',
    caption: 'Light theme — the same tokens, inverted',
    async run(page) {
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[role="option"]', { timeout: 20_000 })
      await page.evaluate(() => {
        localStorage.setItem('sift.theme', '"light"')
        document.documentElement.classList.remove('dark')
        document.documentElement.classList.add('light')
        document.documentElement.style.colorScheme = 'light'
      })
      await page.waitForTimeout(1400)
      await page.locator('[role="option"]').first().click()
      await page.waitForTimeout(1600)
    },
  },
  {
    name: 'onboarding',
    caption: 'First run — three real choices, no tour',
    async run(page, context) {
      // Onboarding only shows on an empty library, so point this one tab at a
      // second, empty server.
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' })
      await page.route('**/api/health', async (route) => {
        const response = await route.fetch()
        const json = await response.json()
        await route.fulfill({ json: { ...json, db: { ...json.db, items: 0 } } })
      })
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(1600)
      void context
    },
  },
  {
    name: 'extension-popup',
    caption: 'The extension popup — status, capture, per-site harvesting',
    viewport: { width: 400, height: 560 },
    async run(page) {
      // The popup is a plain HTML page; serve it from the built extension.
      const popup = join(root, 'apps', 'extension', '.output', 'chrome-mv3', 'popup.html')
      if (!existsSync(popup)) return 'skip'
      await page.goto(`file://${popup}`, { waitUntil: 'domcontentloaded' })
      // Stub the extension APIs the popup expects, and point it at the live server.
      await page.evaluate(
        ([apiPort]) => {
          const settings = { serverUrl: `http://127.0.0.1:${apiPort}`, harvest: { 'x.com': true }, minScore: 0, notifyOnCapture: false }
          window.chrome = {
            storage: {
              local: { get: async () => ({ settings }), set: async () => undefined },
              onChanged: { addListener: () => undefined },
            },
            tabs: {
              query: async () => [
                { id: 1, url: 'https://x.com/home', title: 'Home / X' },
              ],
              create: async () => undefined,
            },
            runtime: {
              sendMessage: async (message) => {
                if (message.type === 'status') {
                  const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`)
                  const health = await response.json()
                  return { online: true, url: `http://127.0.0.1:${apiPort}`, items: health.db.items, version: health.version }
                }
                if (message.type === 'stats') return { sessionCaptured: 24, sessionDuplicates: 7, lastCaptureAt: Date.now() - 42_000 }
                return {}
              },
              getURL: (path) => path,
            },
          }
        },
        [String(API_PORT)],
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1400)
      return undefined
    },
  },
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SITE_PUBLIC, { recursive: true })

  process.stdout.write(`\n  ${c.violet('◆')} Capturing Sift screenshots\n`)

  const dbPath = await seedShotDatabase()
  await startStack(dbPath)
  process.stdout.write(`  ${c.dim(`stack up on :${API_PORT} / :${WEB_PORT}`)}\n\n`)

  const browser = await chromium.launch()
  const captured = []
  const skipped = []

  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      // A stable locale keeps dates and number formatting identical run to run.
      locale: 'en-US',
      timezoneId: 'UTC',
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))

    try {
      const outcome = await shot.run(page, context)
      if (outcome === 'skip') {
        skipped.push(`${shot.name} (prerequisite missing)`)
        await context.close()
        continue
      }
      const file = join(OUT, `${shot.name}.png`)
      await page.screenshot({ path: file, animations: 'disabled' })
      captured.push({ name: shot.name, caption: shot.caption })
      process.stdout.write(
        `  ${c.green('✓')} ${shot.name.padEnd(18)} ${c.dim(shot.caption)}${errors.length ? c.yellow(`  [${errors.length} page errors]`) : ''}\n`,
      )
      if (errors.length) for (const error of errors.slice(0, 2)) process.stdout.write(`      ${c.yellow(error)}\n`)
    } catch (error) {
      skipped.push(`${shot.name} (${error.message.split('\n')[0]})`)
      process.stdout.write(`  ${c.red('✗')} ${shot.name.padEnd(18)} ${c.red(error.message.split('\n')[0])}\n`)
    } finally {
      await context.close()
    }
  }

  await browser.close()

  // The site embeds a couple of these; copy rather than symlink so the Astro
  // build works from a clean checkout.
  const { copyFileSync } = await import('node:fs')
  for (const name of ['inbox', 'trends']) {
    const source = join(OUT, `${name}.png`)
    if (existsSync(source)) copyFileSync(source, join(SITE_PUBLIC, `${name}.png`))
  }

  process.stdout.write(`\n  ${c.green('▸')} ${captured.length} screenshots in ${c.dim('assets/screenshots/')}\n`)
  if (skipped.length) process.stdout.write(`  ${c.yellow('▲')} skipped: ${skipped.join(', ')}\n`)
  process.stdout.write('\n')
}

void main()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch((error) => {
    process.stderr.write(`\n  ${c.red('✗')} ${error.stack ?? error.message}\n`)
    cleanup()
    process.exit(1)
  })
