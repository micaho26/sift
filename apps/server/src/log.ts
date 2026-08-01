/** Minimal structured logger with colour when attached to a TTY. */
import { LOG_LEVEL } from './config.ts'

const tty = process.stdout.isTTY === true
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)

export const color = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  yellow: paint('33'),
  green: paint('32'),
  cyan: paint('36'),
  violet: paint('38;5;141'),
}

function stamp(): string {
  return color.dim(new Date().toTimeString().slice(0, 8))
}

const quiet = LOG_LEVEL === 'quiet'
const debugOn = LOG_LEVEL === 'debug'

export const log = {
  info(message: string): void {
    if (quiet) return
    process.stdout.write(`${stamp()} ${color.violet('◆')} ${message}\n`)
  },
  ok(message: string): void {
    if (quiet) return
    process.stdout.write(`${stamp()} ${color.green('✓')} ${message}\n`)
  },
  warn(message: string): void {
    process.stderr.write(`${stamp()} ${color.yellow('▲')} ${message}\n`)
  },
  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `\n${error.stack ?? error.message}` : error ? `\n${String(error)}` : ''
    process.stderr.write(`${stamp()} ${color.red('✗')} ${message}${detail}\n`)
  },
  debug(message: string): void {
    if (!debugOn) return
    process.stdout.write(`${stamp()} ${color.dim('·')} ${color.dim(message)}\n`)
  },
}
