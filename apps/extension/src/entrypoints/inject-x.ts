/**
 * MAIN-world network interceptor for X.
 *
 * Runs in the page's own JavaScript realm so it can see `window.fetch` and
 * `XMLHttpRequest` as the page uses them. It reads response bodies the page
 * already requested and forwards the JSON to the isolated content script via
 * `postMessage`. It sends nothing, requests nothing, and touches no credentials.
 *
 * Why MAIN world at all: an isolated content script has its own `fetch`, so
 * patching there sees nothing. This is the only way to observe the page's own
 * data without re-requesting it — which would both double the load on X and risk
 * tripping rate limits the user would feel.
 */
import { X_OPERATIONS } from '../lib/extract-x.ts'

export default defineUnlistedScript(() => {
  const CHANNEL = 'sift:x:payload'
  const MAX_BODY = 6_000_000

  function forward(url: string, body: string): void {
    if (!body || body.length > MAX_BODY) return
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return
    }
    try {
      window.postMessage({ channel: CHANNEL, url, payload }, window.location.origin)
    } catch {
      // A structured-clone failure on an exotic payload is not worth surfacing.
    }
  }

  /* ----------------------------------------------------------------- fetch -- */

  const originalFetch = window.fetch
  window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>) {
    const response = await originalFetch.apply(this, args)
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String((args[0] as URL) ?? '')
      if (X_OPERATIONS.test(url)) {
        // Clone before anyone reads it — the page needs an unconsumed body.
        response
          .clone()
          .text()
          .then((text) => forward(url, text))
          .catch(() => undefined)
      }
    } catch {
      // Never let instrumentation break the page's own request.
    }
    return response
  }

  /* -------------------------------------------------------- XMLHttpRequest -- */

  const OriginalXhr = window.XMLHttpRequest
  const originalOpen = OriginalXhr.prototype.open
  const originalSend = OriginalXhr.prototype.send

  type Tracked = XMLHttpRequest & { __siftUrl?: string }

  OriginalXhr.prototype.open = function patchedOpen(
    this: Tracked,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__siftUrl = String(url)
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as never)
  }

  OriginalXhr.prototype.send = function patchedSend(this: Tracked, ...args: unknown[]) {
    const url = this.__siftUrl
    if (url && X_OPERATIONS.test(url)) {
      this.addEventListener('load', () => {
        try {
          // `responseText` throws for responseType 'blob'/'arraybuffer'.
          if (this.responseType === '' || this.responseType === 'text') forward(url, this.responseText)
          else if (this.responseType === 'json' && this.response) forward(url, JSON.stringify(this.response))
        } catch {
          // Ignore.
        }
      })
    }
    // eslint-disable-next-line prefer-rest-params
    return originalSend.apply(this, arguments as never)
  }

  // Announce readiness so the isolated script knows interception is live.
  window.postMessage({ channel: 'sift:x:ready' }, window.location.origin)
})
