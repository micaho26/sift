/**
 * Settings and secrets.
 *
 * API keys live in the `kv` table but are never returned by the API — the client
 * only ever learns whether a key is *set*. That is enough to render the UI and
 * removes any path by which a page in the user's browser could exfiltrate the key
 * from the local server.
 */
import { Settings, type SettingsInput } from '@sift/core'
import { get, run } from '../db/index.ts'

const SETTINGS_KEY = 'settings'
const SECRET_PREFIX = 'secret:'

export function readSettings(): Settings {
  const row = get<{ value: string }>('SELECT value FROM kv WHERE key = ?', SETTINGS_KEY)
  if (!row) return Settings.parse({})
  try {
    // Parse-with-defaults so a settings file written by an older version still
    // loads after new fields are added.
    return Settings.parse(JSON.parse(row.value))
  } catch {
    return Settings.parse({})
  }
}

export function writeSettings(patch: SettingsInput): Settings {
  const current = readSettings()
  const merged = Settings.parse({
    ...current,
    ...patch,
    weights: { ...current.weights, ...(patch.weights ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    embeddings: { ...current.embeddings, ...(patch.embeddings ?? {}) },
    digest: { ...current.digest, ...(patch.digest ?? {}) },
  })
  run(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SETTINGS_KEY,
    JSON.stringify(merged),
    Date.now(),
  )
  return merged
}

export function getSecret(name: string): string | undefined {
  const row = get<{ value: string }>('SELECT value FROM kv WHERE key = ?', `${SECRET_PREFIX}${name}`)
  return row?.value || undefined
}

export function setSecret(name: string, value: string | null): void {
  const key = `${SECRET_PREFIX}${name}`
  if (!value) {
    run('DELETE FROM kv WHERE key = ?', key)
    return
  }
  run(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    Date.now(),
  )
}

export function hasSecret(name: string): boolean {
  return Boolean(getSecret(name))
}

/** Generic key/value for internal bookkeeping (last digest run, boot count…). */
export function kvGet<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function kvSet(key: string, value: unknown): void {
  run(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    Date.now(),
  )
}
