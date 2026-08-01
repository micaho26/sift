/**
 * The service worker: the only component that talks to the Sift server.
 *
 * Content scripts never post to the server directly. Routing everything through
 * here means one place enforces the handshake, one place holds the badge state,
 * and a page's script can never reach loopback even if the page compromises it.
 */
import { checkKnown, findServer, getSettings, ingest, setSettings, type Message, type StatsResponse } from '../lib/bridge.ts'

let sessionCaptured = 0
let sessionDuplicates = 0
let lastCaptureAt: number | undefined
let lastError: string | undefined

/** Badge shows the session's capture count — quiet, but always answers "is it working?". */
async function updateBadge(): Promise<void> {
  const status = await findServer()
  if (!status.online) {
    await chrome.action.setBadgeText({ text: '!' })
    await chrome.action.setBadgeBackgroundColor({ color: '#f0616d' })
    await chrome.action.setTitle({ title: 'Sift — server not reachable' })
    return
  }
  await chrome.action.setBadgeText({ text: sessionCaptured > 0 ? String(Math.min(sessionCaptured, 999)) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: '#7c5cf6' })
  await chrome.action.setTitle({
    title: sessionCaptured
      ? `Sift — ${sessionCaptured} captured this session`
      : 'Sift — capture the current page (⌥⇧S)',
  })
}

/**
 * Ingest queue.
 *
 * Content scripts fire as the user scrolls, so batches arrive constantly.
 * Coalescing on a 1.5s timer turns forty small POSTs into one, and deduplicating
 * by URL inside the queue means re-observing the same tweet costs nothing.
 */
const queue = new Map<string, { item: Parameters<typeof ingest>[0][number]; collector: string }>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_MS = 1500
const MAX_BATCH = 200

function enqueue(items: Parameters<typeof ingest>[0], collector: string): void {
  for (const item of items) {
    // Later observations of the same URL are better (counts have grown).
    queue.set(item.url, { item, collector })
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => void flush(), FLUSH_MS)
}

async function flush(): Promise<void> {
  flushTimer = null
  if (!queue.size) return

  const batch = [...queue.values()].slice(0, MAX_BATCH)
  for (const entry of batch) queue.delete(entry.item.url)

  const collector = batch[0]?.collector ?? 'extension'
  try {
    const result = await ingest(
      batch.map((entry) => entry.item),
      collector,
    )
    sessionCaptured += result.created
    sessionDuplicates += result.duplicates
    if (result.created > 0) lastCaptureAt = Date.now()
    lastError = undefined
    await updateBadge()
  } catch (error) {
    lastError = (error as Error).message
    await updateBadge()
  }

  // Anything left over (or newly arrived) goes in the next window.
  if (queue.size && !flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_MS)
}

/* ------------------------------------------------------------ page capture -- */

async function capturePage(tab?: chrome.tabs.Tab): Promise<{ ok: boolean; message: string }> {
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!target?.id || !target.url || !/^https?:/.test(target.url)) {
    return { ok: false, message: 'That page cannot be captured.' }
  }

  try {
    // `activeTab` makes this legal without a broad host permission: the user
    // invoked the extension on this tab, which is the grant.
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ['capture.js'],
    })
    const captured = injection?.result as (Parameters<typeof ingest>[0][number] & { extractedFrom?: string }) | undefined
    if (!captured?.url) return { ok: false, message: 'Nothing readable found on this page.' }

    const result = await ingest([captured], 'extension:manual')
    sessionCaptured += result.created
    lastCaptureAt = Date.now()
    await updateBadge()

    const settings = await getSettings()
    const message =
      result.created > 0
        ? `Captured: ${captured.title.slice(0, 60)}`
        : result.duplicates > 0
          ? 'Already in your library'
          : result.updated > 0
            ? 'Updated the existing item'
            : (result.errors[0]?.reason ?? 'Nothing was saved')

    if (settings.notifyOnCapture && result.created > 0) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon/128.png'),
        title: 'Saved to Sift',
        message,
      })
    }
    return { ok: result.created > 0 || result.updated > 0, message }
  } catch (error) {
    lastError = (error as Error).message
    await updateBadge()
    return { ok: false, message: lastError }
  }
}

/* ------------------------------------------------------------------ wiring -- */

export default defineBackground(() => {
  /* ----------------------------------------------------------------- wiring -- */
  // Everything is registered inside defineBackground: WXT statically analyses this
  // module at build time, and a top-level addListener would execute there.

  chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
    void (async () => {
      switch (message.type) {
        case 'ingest': {
          const settings = await getSettings()
          const host = sender.tab?.url ? new URL(sender.tab.url).hostname : ''
          // Respect the per-site harvest switch on the worker side too, so a stale
          // content script cannot keep pushing after the user turned it off.
          if (host && settings.harvest[host] === false) {
            respond({ queued: 0, skipped: 'harvest disabled' })
            return
          }
          enqueue(message.items, message.collector)
          respond({ queued: message.items.length })
          return
        }
        case 'status':
          respond(await findServer())
          return
        case 'capture-page':
          respond(await capturePage())
          return
        case 'harvest-state': {
          const settings = await getSettings()
          respond({ enabled: settings.harvest[message.host] !== false })
          return
        }
        case 'toggle-harvest': {
          const settings = await getSettings()
          const enabled = settings.harvest[message.host] === false
          await setSettings({ harvest: { ...settings.harvest, [message.host]: enabled } })
          respond({ enabled })
          return
        }
        case 'stats':
          respond({ sessionCaptured, sessionDuplicates, lastCaptureAt, lastError } satisfies StatsResponse)
          return
        default:
          respond({ error: 'unknown message' })
      }
    })()
    // Keep the message channel open for the async work above.
    return true
  })

  chrome.commands.onCommand.addListener((command) => {
    if (command === 'capture-page') void capturePage()
    if (command === 'toggle-harvest') {
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!tab?.url) return
        const host = new URL(tab.url).hostname
        const settings = await getSettings()
        const enabled = settings.harvest[host] === false
        await setSettings({ harvest: { ...settings.harvest, [host]: enabled } })
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/128.png'),
          title: `Harvesting ${enabled ? 'on' : 'off'} for ${host}`,
          message: enabled ? 'New posts you scroll past will be collected.' : 'Nothing will be collected automatically here.',
        })
      })()
    }
  })

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'sift-capture') void capturePage(tab)
  })

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: 'sift-capture',
      title: 'Save to Sift',
      contexts: ['page', 'selection', 'link'],
    })
    void updateBadge()
  })

  chrome.runtime.onStartup.addListener(() => void updateBadge())

  void updateBadge()
  // Flush anything queued when the worker is about to be suspended.
  chrome.runtime.onSuspend?.addListener(() => void flush())
})

export { checkKnown }
