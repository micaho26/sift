/**
 * X content script (isolated world).
 *
 * Injects the MAIN-world interceptor, receives the JSON it captures, and also
 * scrapes the DOM as a backstop. Everything it extracts goes to the background
 * worker — this script has no network access to the Sift server itself.
 */
import { itemsFromDom, itemsFromGraphql } from '../lib/extract-x.ts'
import { getSettings, send } from '../lib/bridge.ts'
import type { IngestItem } from '@sift/core'

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  allFrames: false,

  async main(ctx) {
    const CHANNEL = 'sift:x:payload'
    const host = location.hostname
    let harvesting = (await getSettings()).harvest[host] !== false
    let interceptorReady = false

    // React to the toggle without needing a reload.
    chrome.storage.onChanged.addListener((changes) => {
      const next = changes.settings?.newValue as { harvest?: Record<string, boolean> } | undefined
      if (next?.harvest) harvesting = next.harvest[host] !== false
    })

    /* ------------------------------------------------- MAIN-world injection -- */

    // `world: 'MAIN'` on a content script would be simpler, but injecting the
    // built file ourselves works on every Chromium version we care about and
    // keeps the manifest's content_scripts list to one entry per site.
    try {
      const script = document.createElement('script')
      script.src = chrome.runtime.getURL('inject-x.js')
      script.async = false
      ;(document.head ?? document.documentElement).prepend(script)
      script.addEventListener('load', () => script.remove())
    } catch {
      // If injection is blocked by CSP, the DOM path below still works.
    }

    /* ------------------------------------------------------ payload handler -- */

    const seen = new Set<string>()

    /** Only forward what we have not already sent this page-load. */
    function forwardNew(items: IngestItem[], collector: string): void {
      if (!harvesting || !items.length) return
      const fresh = items.filter((item) => {
        if (seen.has(item.url)) return false
        seen.add(item.url)
        return true
      })
      if (!fresh.length) return
      void send({ type: 'ingest', items: fresh, collector }).catch(() => undefined)
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return
      const data = event.data as { channel?: string; url?: string; payload?: unknown } | undefined
      if (!data?.channel) return

      if (data.channel === 'sift:x:ready') {
        interceptorReady = true
        return
      }
      if (data.channel !== CHANNEL || !data.payload) return

      const items = itemsFromGraphql(data.payload)
      // Derive the collector from the operation name, so provenance is visible
      // in the server's logs ("x:HomeTimeline" vs "x:Bookmarks").
      const operation = /\/graphql\/[^/]+\/(\w+)/.exec(data.url ?? '')?.[1] ?? 'graphql'
      forwardNew(items, `x:${operation}`)
    })

    /* ---------------------------------------------------------- DOM backstop -- */

    /**
     * Scan the rendered timeline on a settled scroll. Only used to fill gaps the
     * JSON path missed — `seen` prevents duplicate work, and the interceptor's
     * richer data always arrives first for a given tweet.
     */
    let scanTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleScan = () => {
      if (scanTimer) clearTimeout(scanTimer)
      scanTimer = setTimeout(() => {
        scanTimer = null
        if (!harvesting) return
        // Give the interceptor a chance first; the DOM is the fallback.
        const items = itemsFromDom(document, 40).filter((item) => !seen.has(item.url))
        if (!items.length) return
        forwardNew(items, interceptorReady ? 'x:dom-gap' : 'x:dom')
      }, 900)
    }

    ctx.addEventListener(window, 'scroll', scheduleScan, { passive: true })

    const observer = new MutationObserver(() => scheduleScan())
    const startObserving = () => {
      const timeline = document.querySelector('main') ?? document.body
      if (timeline) observer.observe(timeline, { childList: true, subtree: true })
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true })
    } else {
      startObserving()
    }
    ctx.onInvalidated(() => observer.disconnect())

    // First pass once the timeline has rendered.
    setTimeout(scheduleScan, 2000)
  },
})
