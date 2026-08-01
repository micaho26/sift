/**
 * Xiaohongshu content script (isolated world).
 */
import { itemsFromDom, itemsFromState } from '../lib/extract-xhs.ts'
import { getSettings, send } from '../lib/bridge.ts'
import type { IngestItem } from '@sift/core'

export default defineContentScript({
  matches: ['https://www.xiaohongshu.com/*'],
  runAt: 'document_start',
  allFrames: false,

  async main(ctx) {
    const CHANNEL = 'sift:xhs:payload'
    const host = location.hostname
    let harvesting = (await getSettings()).harvest[host] !== false

    chrome.storage.onChanged.addListener((changes) => {
      const next = changes.settings?.newValue as { harvest?: Record<string, boolean> } | undefined
      if (next?.harvest) harvesting = next.harvest[host] !== false
    })

    try {
      const script = document.createElement('script')
      script.src = chrome.runtime.getURL('inject-xhs.js')
      script.async = false
      ;(document.head ?? document.documentElement).prepend(script)
      script.addEventListener('load', () => script.remove())
    } catch {
      // CSP blocked it; the DOM path still works.
    }

    const seen = new Set<string>()

    function forwardNew(items: IngestItem[], collector: string): void {
      if (!harvesting || !items.length) return
      const fresh = items.filter((item) => {
        // A note captured from the grid is later re-captured from its own page
        // with full body text, so allow one upgrade per url.
        const key = item.content && item.content.length > 120 ? `${item.url}#full` : item.url
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!fresh.length) return
      void send({ type: 'ingest', items: fresh, collector }).catch(() => undefined)
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return
      const data = event.data as { channel?: string; url?: string; payload?: unknown } | undefined
      if (data?.channel !== CHANNEL || !data.payload) return

      const items = itemsFromState(data.payload)
      const label = data.url === '__INITIAL_STATE__' ? 'xhs:initial' : 'xhs:api'
      forwardNew(items, label)
    })

    let scanTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleScan = () => {
      if (scanTimer) clearTimeout(scanTimer)
      scanTimer = setTimeout(() => {
        scanTimer = null
        if (!harvesting) return
        forwardNew(itemsFromDom(document, 40), 'xhs:dom')
      }, 900)
    }

    ctx.addEventListener(window, 'scroll', scheduleScan, { passive: true })

    const observer = new MutationObserver(() => scheduleScan())
    const start = () => observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
    ctx.onInvalidated(() => observer.disconnect())

    setTimeout(scheduleScan, 2200)
  },
})
