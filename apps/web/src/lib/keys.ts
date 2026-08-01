/**
 * Keyboard system.
 *
 * Single-key shortcuts when no text field has focus, ⌘-combos otherwise. The
 * whole app is operable without the mouse, which is the difference between a tool
 * you use for ten minutes and one you triage two hundred items in.
 *
 * Design rules:
 *  - Never shadow a browser default the user relies on (⌘T, ⌘W, ⌘L, ⌘R).
 *  - Single keys mirror the verbs people already know from mail clients:
 *    j/k to move, e to archive, s to save, / to search.
 *  - A `g`-prefixed chord jumps to a view, as in Gmail and Linear.
 */
import { useEffect, useRef } from 'react'

export type Shortcut = {
  /** Lowercase key, or 'g x' for a chord. */
  keys: string
  label: string
  group: 'Navigate' | 'Triage' | 'Item' | 'AI' | 'View' | 'Global'
  /** Rendered in the shortcut sheet; omit to hide. */
  hint?: string
}

/** The canonical map, also rendered by the `?` sheet — one source of truth. */
export const SHORTCUTS: Shortcut[] = [
  { keys: 'j', label: 'Next item', group: 'Navigate' },
  { keys: 'k', label: 'Previous item', group: 'Navigate' },
  { keys: '↵', label: 'Open in reader', group: 'Navigate' },
  { keys: 'esc', label: 'Close reader / clear selection', group: 'Navigate' },
  { keys: 'o', label: 'Open original in a new tab', group: 'Navigate' },

  { keys: 's', label: 'Save', group: 'Triage' },
  { keys: 'l', label: 'Add to shortlist', group: 'Triage' },
  { keys: 'e', label: 'Archive', group: 'Triage' },
  { keys: 'f', label: 'Star', group: 'Triage' },
  { keys: 'u', label: 'Toggle read', group: 'Triage' },
  { keys: '#', label: 'Move to trash', group: 'Triage' },
  { keys: 'x', label: 'Toggle multi-select', group: 'Triage' },

  { keys: 't', label: 'Tag…', group: 'Item' },
  { keys: 'c', label: 'Add to collection…', group: 'Item' },
  { keys: 'y', label: 'Copy link', group: 'Item' },
  { keys: '⇧S', label: 'Share card…', group: 'Item' },
  { keys: 'w', label: 'Why this score?', group: 'Item' },

  { keys: 'a', label: 'AI summary', group: 'AI' },
  { keys: 'r', label: 'Translate', group: 'AI' },
  { keys: 'i', label: 'Key takeaways', group: 'AI' },

  { keys: 'g i', label: 'Go to Inbox', group: 'View' },
  { keys: 'g t', label: 'Go to Today', group: 'View' },
  { keys: 'g l', label: 'Go to Shortlist', group: 'View' },
  { keys: 'g s', label: 'Go to Saved', group: 'View' },
  { keys: 'g a', label: 'Go to Trends', group: 'View' },
  { keys: 'g q', label: 'Go to Ask', group: 'View' },
  { keys: 'g d', label: 'Go to Briefing', group: 'View' },
  { keys: 'g c', label: 'Go to Sources', group: 'View' },
  { keys: 'g ,', label: 'Go to Settings', group: 'View' },

  { keys: '⌘K', label: 'Command palette', group: 'Global' },
  { keys: '/', label: 'Focus search', group: 'Global' },
  { keys: '⌘⏎', label: 'Refresh all sources', group: 'Global' },
  { keys: '⌘\\', label: 'Toggle sidebar', group: 'Global' },
  { keys: '⌘⇧L', label: 'Toggle theme', group: 'Global' },
  { keys: '?', label: 'Keyboard shortcuts', group: 'Global' },
]

/** True when the event target is somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (element.isContentEditable) return true
  // cmdk renders its input inside a dialog; treat the whole dialog as typing.
  return Boolean(element.closest('[data-typing-scope="true"]'))
}

export type KeyHandler = (event: KeyboardEvent) => void | boolean

/**
 * Register global shortcuts. Handlers are keyed by a normalised descriptor:
 *   'j', 'shift+s', 'mod+k', 'g i'
 * `mod` is ⌘ on Apple platforms and Ctrl elsewhere.
 */
export function useHotkeys(map: Record<string, KeyHandler>, enabled = true): void {
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!enabled) return
    // Chord state: 'g' then a second key within the timeout.
    let pending: string | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null

    const clearPending = () => {
      pending = null
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const handlers = mapRef.current
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const mod = isMac ? event.metaKey : event.ctrlKey
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase()

      // ⌘-combos work even while typing (that is the point of a modifier).
      if (mod) {
        const descriptor = `mod+${event.shiftKey ? 'shift+' : ''}${key === 'enter' ? 'enter' : key}`
        const handler = handlers[descriptor]
        if (handler) {
          const handled = handler(event)
          if (handled !== false) {
            event.preventDefault()
            event.stopPropagation()
          }
        }
        return
      }

      // Everything below is single-key, so bail out while the user is typing.
      if (isTypingTarget(event.target)) {
        // Escape must still work in a text field, to leave it.
        if (key === 'escape' && handlers['escape']) {
          const handled = handlers['escape'](event)
          if (handled !== false) event.preventDefault()
        }
        return
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return

      // Second half of a chord.
      if (pending) {
        const descriptor = `${pending} ${key}`
        clearPending()
        const handler = handlers[descriptor]
        if (handler) {
          const handled = handler(event)
          if (handled !== false) event.preventDefault()
          return
        }
        // Unrecognised chord: swallow it rather than acting on the second key,
        // which would make a typo destructive.
        return
      }

      // Start of a chord.
      if (key === 'g' && Object.keys(handlers).some((k) => k.startsWith('g '))) {
        pending = 'g'
        pendingTimer = setTimeout(clearPending, 1200)
        event.preventDefault()
        return
      }

      const descriptor = event.shiftKey && key.length === 1 ? `shift+${key}` : key
      const handler = handlers[descriptor] ?? (event.shiftKey ? undefined : handlers[key])
      if (handler) {
        const handled = handler(event)
        if (handled !== false) event.preventDefault()
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      clearPending()
    }
  }, [enabled])
}

/** Pretty-print a descriptor for display: 'mod+k' -> '⌘K'. */
export function formatKeys(descriptor: string): string[] {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
  return descriptor.split(' ').flatMap((part) =>
    part
      .split('+')
      .map((token) => {
        if (token === 'mod') return isMac ? '⌘' : 'Ctrl'
        if (token === 'shift') return '⇧'
        if (token === 'alt') return isMac ? '⌥' : 'Alt'
        if (token === 'enter') return '↵'
        if (token === 'escape') return 'Esc'
        if (token === 'arrowup') return '↑'
        if (token === 'arrowdown') return '↓'
        return token.length === 1 ? token.toUpperCase() : token
      })
      .join(''),
  )
}
