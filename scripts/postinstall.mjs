#!/usr/bin/env node
/**
 * Post-install: create the local data directory and print the one thing the
 * user needs to know next. Never fails the install — a broken banner must not
 * break `pnpm install`.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const c = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      violet: (s) => `\x1b[38;5;141m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, cyan: (s) => s, violet: (s) => s, green: (s) => s }

try {
  for (const dir of ['data', 'data/models', 'assets/screenshots']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
} catch {
  // A read-only checkout is fine; the server creates what it needs at boot.
}

/**
 * Build @sift/core.
 *
 * Everything else imports it as built output, so on a fresh clone `pnpm seed`
 * and `pnpm test` would fail with a module-not-found until something happened to
 * build it first. Doing it here means no command has a hidden prerequisite.
 */
if (!existsSync(join(root, 'packages/core/dist/index.js'))) {
  const result = spawnSync('pnpm', ['--filter', '@sift/core', 'build'], {
    cwd: root,
    stdio: process.env.CI ? 'inherit' : 'ignore',
  })
  if (result.status !== 0) {
    process.stderr.write(
      '\n  Could not build @sift/core. Run `pnpm --filter @sift/core build` and check the output.\n',
    )
  }
}

// Quiet in CI — nobody reads a banner in a build log.
if (!process.env.CI) {
  const line = c.dim('─'.repeat(58))
  process.stdout.write(
    [
      '',
      `  ${c.violet('◆')} ${c.bold('Sift')} ${c.dim('· signal intelligence for technologists')}`,
      line,
      `  ${c.green('▸')} ${c.bold('pnpm dev')}        ${c.dim('start everything, opens your browser')}`,
      `  ${c.green('▸')} ${c.bold('pnpm seed')}       ${c.dim('load a realistic demo corpus')}`,
      `  ${c.green('▸')} ${c.bold('pnpm build:extension')} ${c.dim('build the Chrome extension')}`,
      line,
      `  ${c.dim('Your data stays in')} ${c.cyan('./data/sift.db')} ${c.dim('— nothing leaves this machine.')}`,
      '',
    ].join('\n'),
  )
}
