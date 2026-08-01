/**
 * Runtime configuration. Everything is derived from the repo root so the app
 * works from a fresh clone with no .env file — the single most important
 * property of a local-first tool.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SERVER_PORT } from '@sift/core'

const here = dirname(fileURLToPath(import.meta.url))

/** Walk up until we find the workspace root (the dir holding pnpm-workspace.yaml). */
function findRepoRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Installed standalone: keep data beside the server package.
  return resolve(from, '..', '..')
}

export const REPO_ROOT = process.env.SIFT_ROOT ? resolve(process.env.SIFT_ROOT) : findRepoRoot(here)
export const DATA_DIR = process.env.SIFT_DATA_DIR ? resolve(process.env.SIFT_DATA_DIR) : join(REPO_ROOT, 'data')
export const DB_PATH = process.env.SIFT_DB ? resolve(process.env.SIFT_DB) : join(DATA_DIR, 'sift.db')
export const MODELS_DIR = join(DATA_DIR, 'models')
/** Built web assets, served in production mode so one port runs everything. */
export const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist')

export const PORT = Number(process.env.SIFT_PORT ?? process.env.PORT ?? DEFAULT_SERVER_PORT)
/** Loopback only. Sift never listens on a public interface without opt-in. */
export const HOST = process.env.SIFT_HOST ?? '127.0.0.1'
export const IS_PROD = process.env.NODE_ENV === 'production'

/**
 * Origins allowed to call the API. Extensions send `chrome-extension://<id>`,
 * which we cannot know ahead of time, so those are matched by scheme instead of
 * an allowlist — safe because the API binds to loopback and holds no secrets
 * that a page could not already read from the user's own browser session.
 */
export const DEV_WEB_ORIGINS = [
  'http://localhost:4470',
  'http://127.0.0.1:4470',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, MODELS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/** Log level: `quiet` keeps `pnpm dev` output readable. */
export const LOG_LEVEL = (process.env.SIFT_LOG ?? 'info') as 'debug' | 'info' | 'quiet'
