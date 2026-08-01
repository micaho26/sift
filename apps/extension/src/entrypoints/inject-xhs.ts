/**
 * MAIN-world interceptor for Xiaohongshu.
 *
 * Same principle as the X interceptor: observe the JSON the page already fetched
 * rather than issuing our own requests. Xiaohongshu signs its API calls with
 * per-request `x-s` headers computed in page script, so re-requesting from an
 * extension context would fail anyway — reading what the page received is both
 * the only workable path and the least invasive one.
 *
 * Also forwards `window.__INITIAL_STATE__`, which holds the server-rendered
 * feed on first paint before any XHR happens.
 */
import { XHS_ENDPOINTS } from '../lib/extract-xhs.ts'

export default defineUnlistedScript(() => {
  const CHANNEL = 'sift:xhs:payload'
  const MAX_BODY = 6_000_000

  function forward(url: string, payload: unknown): void {
    try {
      window.postMessage({ channel: CHANNEL, url, payload }, window.location.origin)
    } catch {
      // Non-cloneable payload; skip.
    }
  }

  function forwardText(url: string, body: string): void {
    if (!body || body.length > MAX_BODY) return
    try {
      forward(url, JSON.parse(body))
    } catch {
      // Not JSON.
    }
  }

  /* ----------------------------------------------------------------- fetch -- */

  const originalFetch = window.fetch
  window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>) {
    const response = await originalFetch.apply(this, args)
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String((args[0] as URL) ?? '')
      if (XHS_ENDPOINTS.test(url)) {
        response
          .clone()
          .text()
          .then((text) => forwardText(url, text))
          .catch(() => undefined)
      }
    } catch {
      // Never break the page's request.
    }
    return response
  }

  /* -------------------------------------------------------- XMLHttpRequest -- */

  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  type Tracked = XMLHttpRequest & { __siftUrl?: string }

  XMLHttpRequest.prototype.open = function patchedOpen(this: Tracked, method: string, url: string | URL, ...rest: unknown[]) {
    this.__siftUrl = String(url)
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as never)
  }

  XMLHttpRequest.prototype.send = function patchedSend(this: Tracked, ...args: unknown[]) {
    const url = this.__siftUrl
    if (url && XHS_ENDPOINTS.test(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') forwardText(url, this.responseText)
          else if (this.responseType === 'json' && this.response) forward(url, this.response)
        } catch {
          // Ignore.
        }
      })
    }
    // eslint-disable-next-line prefer-rest-params
    return originalSend.apply(this, arguments as never)
  }

  /* ---------------------------------------------------------- initial state -- */

  // The first screen of notes is server-rendered into a global, before any XHR.
  const readInitialState = () => {
    const state = (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__
    if (state) forward('__INITIAL_STATE__', state)
  }
  readInitialState()
  // It may be assigned after this script runs; check once more when idle.
  setTimeout(readInitialState, 1200)

  window.postMessage({ channel: 'sift:xhs:ready' }, window.location.origin)
})
