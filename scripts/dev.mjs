#!/usr/bin/env node
/**
 * `pnpm dev` — one command, everything running, browser open.
 *
 * Starts the API server and the Vite dev server, waits for the server's
 * `sift:ready` line, then opens the app. Output from both is prefixed and
 * interleaved so a single terminal is enough.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tty = process.stdout.isTTY

const c = tty
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      violet: (s) => `\x1b[38;5;141m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    }
  : Object.fromEntries(['dim', 'bold', 'violet', 'cyan', 'green', 'red', 'yellow'].map((k) => [k, (s) => s]))

/** Find a free port starting at `start`, so two checkouts can run side by side. */
function freePort(start) {
  return new Promise((resolve) => {
    const attempt = (port) => {
      if (port > start + 40) return resolve(start)
      const server = createServer()
      server.once('error', () => attempt(port + 1))
      server.once('listening', () => server.close(() => resolve(port)))
      server.listen(port, '127.0.0.1')
    }
    attempt(start)
  })
}

function open(url) {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: platform() === 'win32' }).unref()
  } catch {
    // Headless environment — the URL is printed anyway.
  }
}

const children = []
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => process.exit(code), 200)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/** Pipe a child's output with a coloured prefix, dropping empty lines. */
function pipe(child, label, colour) {
  const prefix = `${colour(label.padEnd(6))} ${c.dim('│')} `
  const forward = (stream, target) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        // Internal readiness signal — consumed, not shown.
        if (line.includes('sift:ready')) continue
        target.write(`${prefix}${line}\n`)
      }
    })
  }
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)
}

async function main() {
  if (!existsSync(join(root, 'node_modules'))) {
    process.stderr.write(`${c.red('✗')} Dependencies are not installed. Run ${c.bold('pnpm install')} first.\n`)
    process.exit(1)
  }

  const apiPort = await freePort(Number(process.env.SIFT_PORT ?? 4471))
  const webPort = await freePort(Number(process.env.SIFT_WEB_PORT ?? 4470))

  process.stdout.write(
    [
      '',
      `  ${c.violet('◆')} ${c.bold('Sift')} ${c.dim('· starting')}`,
      `  ${c.dim(`api :${apiPort}   web :${webPort}`)}`,
      '',
    ].join('\n'),
  )

  // @sift/core is consumed as built output, so it must exist before either app
  // starts. Cheap when already built.
  const build = spawn('pnpm', ['--filter', '@sift/core', 'build'], { cwd: root, stdio: 'ignore' })
  await new Promise((resolve) => build.on('exit', resolve))

  const server = spawn('pnpm', ['--filter', 'sift-server', 'dev'], {
    cwd: root,
    env: { ...process.env, SIFT_PORT: String(apiPort), SIFT_QUIET_BANNER: '1', FORCE_COLOR: tty ? '1' : '0' },
  })
  children.push(server)
  pipe(server, 'server', c.violet)

  const web = spawn('pnpm', ['--filter', 'sift-web', 'dev'], {
    cwd: root,
    env: {
      ...process.env,
      SIFT_PORT: String(apiPort),
      SIFT_WEB_PORT: String(webPort),
      FORCE_COLOR: tty ? '1' : '0',
    },
  })
  children.push(web)
  pipe(web, 'web', c.cyan)

  for (const child of children) {
    child.on('exit', (code) => {
      if (shuttingDown) return
      process.stderr.write(`\n${c.red('✗')} A process exited (code ${code}). Shutting down.\n`)
      shutdown(code ?? 1)
    })
  }

  /**
   * Wait for BOTH servers before announcing anything.
   *
   * The API is usually up in ~10ms while Vite's first dep-optimise pass on a
   * fresh clone takes several seconds. Announcing the web URL on API readiness
   * alone pointed the user (and the browser) at a port nothing was listening on.
   */
  const url = `http://127.0.0.1:${webPort}`
  const deadline = Date.now() + 90_000
  let ready = false
  let webUp = false
  while (Date.now() < deadline && !shuttingDown) {
    try {
      if (!webUp) {
        const web = await fetch(url, { signal: AbortSignal.timeout(1000) })
        webUp = web.ok
      }
      const response = webUp
        ? await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1000) })
        : null
      if (response?.ok) {
        const health = await response.json()
        ready = true
        const line = c.dim('─'.repeat(58))
        process.stdout.write(
          [
            '',
            line,
            `  ${c.green('▸')} ${c.bold('Sift is running')}   ${c.cyan(url)}`,
            `  ${c.dim(`${health.db.items} items · ${health.embeddings.provider}/${health.embeddings.dimensions}d · ${health.ai.configured ? `AI: ${health.ai.provider}` : 'AI: not configured'}`)}`,
            health.db.items === 0
              ? `  ${c.yellow('!')} ${c.dim('Library is empty — run')} ${c.bold('pnpm seed')} ${c.dim('for a demo corpus, or connect sources in the app.')}`
              : '',
            line,
            '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        break
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  if (!ready && !shuttingDown) {
    process.stderr.write(
      `${c.yellow('▲')} ${webUp ? 'The API' : 'The dev server'} did not come up in 90s. Check the log above.\n`,
    )
  } else if (ready && process.env.SIFT_NO_OPEN !== '1') {
    // Both are listening, so this is safe to open immediately.
    open(url)
  }
}

void main().catch((error) => {
  process.stderr.write(`${c.red('✗')} ${error.message}\n`)
  shutdown(1)
})
