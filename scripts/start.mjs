#!/usr/bin/env node
/**
 * `pnpm start` — production mode: build once, then serve the app and the API from
 * a single port. This is the mode to leave running.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tty = process.stdout.isTTY
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const c = { dim: paint('2'), bold: paint('1'), violet: paint('38;5;141'), cyan: paint('36'), red: paint('31') }

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))))
    child.on('error', reject)
  })
}

function open(url) {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: platform() === 'win32' }).unref()
  } catch {
    // Headless — the URL is printed regardless.
  }
}

async function main() {
  const webDist = join(root, 'apps', 'web', 'dist', 'index.html')
  const needsBuild = !existsSync(webDist) || process.argv.includes('--build')

  if (needsBuild) {
    process.stdout.write(`\n  ${c.violet('◆')} ${c.bold('Building Sift')} ${c.dim('(first run only)')}\n\n`)
    await run('pnpm', ['run', 'build'])
  }

  const port = process.env.SIFT_PORT ?? '4471'
  const url = `http://127.0.0.1:${port}`
  process.stdout.write(`\n  ${c.violet('◆')} ${c.bold('Sift')} ${c.dim('·')} ${c.cyan(url)}\n\n`)
  if (process.env.SIFT_NO_OPEN !== '1') setTimeout(() => open(url), 900)

  await run('pnpm', ['--filter', 'sift-server', 'start'], {
    env: { ...process.env, NODE_ENV: 'production', SIFT_PORT: port },
  })
}

void main().catch((error) => {
  process.stderr.write(`\n  ${c.red('✗')} ${error.message}\n`)
  process.exit(1)
})
