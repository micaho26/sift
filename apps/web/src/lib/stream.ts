/**
 * Live updates over SSE, plus small shared hooks.
 *
 * The connection is a singleton: one EventSource for the whole tab, fanned out to
 * subscribers. Opening one per component would multiply server-side subscribers by
 * the number of mounted panes.
 */
import { useEffect, useRef, useState } from 'react'
import type { StreamEvent } from '@sift/core'

type Listener = (event: StreamEvent) => void

const listeners = new Set<Listener>()
let source: EventSource | null = null
let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let connected = false
const connectionListeners = new Set<(online: boolean) => void>()

function setConnected(value: boolean): void {
  if (connected === value) return
  connected = value
  for (const listener of connectionListeners) listener(value)
}

function open(): void {
  if (source) return
  try {
    source = new EventSource('/api/stream')
  } catch {
    scheduleReconnect()
    return
  }

  source.onopen = () => {
    setConnected(true)
    reconnectDelay = 1000
  }

  source.onmessage = (message) => {
    // Named events arrive on their own handlers; this catches the unnamed ones.
    dispatch(message.data)
  }

  for (const name of ['items:new', 'items:updated', 'items:removed', 'source:status', 'job', 'ping']) {
    source.addEventListener(name, (event) => dispatch((event as MessageEvent).data))
  }

  source.onerror = () => {
    setConnected(false)
    source?.close()
    source = null
    scheduleReconnect()
  }
}

function dispatch(raw: string): void {
  if (!raw) return
  let event: StreamEvent
  try {
    event = JSON.parse(raw) as StreamEvent
  } catch {
    return
  }
  if (event.type === 'ping') {
    setConnected(true)
    return
  }
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // One bad subscriber must not break the others.
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  // Exponential backoff to 15s. The server is local, so a failure usually means
  // it is restarting — reconnect quickly at first, then stop hammering it.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.8)
    if (listeners.size) open()
  }, reconnectDelay)
}

function close(): void {
  source?.close()
  source = null
  setConnected(false)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

/** Subscribe to server events for the lifetime of a component. */
export function useStream(listener: Listener): void {
  const ref = useRef(listener)
  ref.current = listener

  useEffect(() => {
    const wrapped: Listener = (event) => ref.current(event)
    listeners.add(wrapped)
    open()
    return () => {
      listeners.delete(wrapped)
      if (listeners.size === 0) close()
    }
  }, [])
}

export function useStreamStatus(): boolean {
  const [online, setOnline] = useState(connected)
  useEffect(() => {
    connectionListeners.add(setOnline)
    return () => {
      connectionListeners.delete(setOnline)
    }
  }, [])
  return online
}

/* ---------------------------------------------------------------- helpers -- */

/** Debounce a value. Used for search-as-you-type so we do not query per keystroke. */
export function useDebounced<T>(value: T, delay = 180): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Persisted state, for preferences that should not need a server round-trip. */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = (value: T) => {
    setState(value)
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Private browsing or a full quota — the app still works, just forgets.
    }
  }
  return [state, set]
}

/** Media query as state, for the responsive pane collapse. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false))
  useEffect(() => {
    const list = matchMedia(query)
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export type Theme = 'dark' | 'light' | 'system'

export function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.classList.toggle('light', resolved === 'light')
  document.documentElement.style.colorScheme = resolved
  try {
    localStorage.setItem('sift.theme', theme)
  } catch {
    // Non-fatal.
  }
}

export function currentTheme(): Theme {
  try {
    const stored = localStorage.getItem('sift.theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  } catch {
    // Fall through.
  }
  return 'dark'
}
