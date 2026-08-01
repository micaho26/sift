#!/usr/bin/env node
/**
 * `pnpm db:reset` — delete the local database. Destructive and explicit: requires
 * either a TTY confirmation or `--yes`.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { DB_PATH } from '../config.ts'
import { color, log } from '../log.ts'

const files = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]

async function confirm(): Promise<boolean> {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) return true
  if (!process.stdin.isTTY) {
    log.warn('Refusing to delete the database without --yes when not attached to a terminal.')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(
    `${color.yellow('▲')} This deletes ${color.bold(DB_PATH)} and everything you have captured. Type ${color.bold('reset')} to confirm: `,
  )
  rl.close()
  return answer.trim() === 'reset'
}

const present = files.filter((f) => existsSync(f))
if (!present.length) {
  log.ok('No database to remove.')
  process.exit(0)
}

if (!(await confirm())) {
  log.info('Cancelled. Nothing was deleted.')
  process.exit(0)
}

for (const file of present) {
  try {
    unlinkSync(file)
  } catch (error) {
    log.error(`Could not remove ${file}`, error)
    process.exit(1)
  }
}
log.ok(`Removed ${present.length} file${present.length === 1 ? '' : 's'}. Run \`pnpm seed\` to start over.`)
