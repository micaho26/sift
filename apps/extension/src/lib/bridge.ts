/**
 * Shared extension state and the client for the local Sift server.
 *
 * Discovery matters more than it looks: the user may have started Sift on a
 * different port, so rather than hardcode one we probe a small range and confirm
 * the handshake (`service: "sift"`) before trusting whatever answered. Posting
 * captured content to a stranger's localhost port would be a real leak.
 */
import type { IngestItem, IngestResult } from '@sift/core'

/**
 * Kept in sync with `DEFAULT_SERVER_PORT` in @sift/core by hand, deliberately.
 * Importing the value would pull the whole core bundle — zod schemas, the AI
 * taxonomy's compiled regexes — into a content script that runs on every page
 * load. One duplicated integer is the cheaper trade.
 */
const DEFAULT_SERVER_PORT = 4471

export type Settings = {
  serverUrl: string
  /** Sites where background harvesting is on. */
  harvest: Record<string, boolean>
  /** Only send posts that clear this local pre-score. 0 = send everything. */
  minScore: number
  notifyOnCapture: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: `http://127.0.0.1:${DEFAULT_SERVER_PORT}`,
  harvest: { 'x.com': true, 'www.xiaohongshu.com': true },
  minScore: 0,
  notifyOnCapture: false,
}

const PORT_CANDIDATES = [DEFAULT_SERVER_PORT, 4471, 4472, 4473, 5471, 8787]

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...((stored.settings as Partial<Settings>) ?? {}) }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ settings: next })
  return next
}

export type ServerStatus = {
  online: boolean
  url: string
  items?: number
  version?: string
  error?: string
}

/** Verify a candidate URL really is a Sift server. */
async function probe(url: string): Promise<ServerStatus | null> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (!response.ok) return null
    const health = (await response.json()) as { service?: string; version?: string; db?: { items?: number } }
    // The handshake is the whole point of this function.
    if (health.service !== 'sift') return null
    return { online: true, url, items: health.db?.items, version: health.version }
  } catch {
    return null
  }
}

export async function findServer(): Promise<ServerStatus> {
  const settings = await getSettings()

  const direct = await probe(settings.serverUrl)
  if (direct) return direct

  for (const port of PORT_CANDIDATES) {
    const url = `http://127.0.0.1:${port}`
    if (url === settings.serverUrl) continue
    const found = await probe(url)
    if (found) {
      await setSettings({ serverUrl: url })
      return found
    }
  }

  return {
    online: false,
    url: settings.serverUrl,
    error: 'No Sift server found. Start it with `pnpm dev` in the Sift repo.',
  }
}

export async function ingest(items: IngestItem[], collector: string): Promise<IngestResult> {
  const status = await findServer()
  if (!status.online) throw new Error(status.error ?? 'Sift server is unreachable')

  const response = await fetch(`${status.url}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items, collector }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Sift returned ${response.status}: ${detail.slice(0, 200)}`)
  }
  return (await response.json()) as IngestResult
}

/** Which of these URLs does the library already contain? Drives the "saved" state. */
export async function checkKnown(urls: string[]): Promise<Record<string, { id: string; state: string; score: number }>> {
  if (!urls.length) return {}
  const status = await findServer()
  if (!status.online) return {}
  try {
    const response = await fetch(`${status.url}/api/ingest/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: urls.slice(0, 300) }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return {}
    const data = (await response.json()) as { known?: Record<string, { id: string; state: string; score: number }> }
    return data.known ?? {}
  } catch {
    return {}
  }
}

/* --------------------------------------------------------------- messaging -- */

export type Message =
  | { type: 'ingest'; items: IngestItem[]; collector: string }
  | { type: 'status' }
  | { type: 'capture-page' }
  | { type: 'harvest-state'; host: string }
  | { type: 'toggle-harvest'; host: string }
  | { type: 'stats' }

export type StatsResponse = {
  sessionCaptured: number
  sessionDuplicates: number
  lastCaptureAt?: number
  lastError?: string
}

export function send<T = unknown>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>
}
