/**
 * The popup.
 *
 * Answers three questions in one glance, because that is all a popup gets:
 * is Sift reachable, is this site being harvested, and did anything land.
 * One primary action; everything else is a toggle or a link.
 */
import { useCallback, useEffect, useState } from 'react'

import { getSettings, send, setSettings, type ServerStatus, type Settings, type StatsResponse } from '../../lib/bridge.ts'

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

const SUPPORTED: Record<string, { label: string; colour: string; note: string }> = {
  'x.com': { label: 'X', colour: '#e7e9ea', note: 'Reads the timeline your browser already loaded.' },
  'twitter.com': { label: 'X', colour: '#e7e9ea', note: 'Reads the timeline your browser already loaded.' },
  'www.xiaohongshu.com': { label: '小红书', colour: '#ff2e4d', note: '读取当前页面已加载的笔记数据。' },
}

function timeAgo(timestamp?: number): string {
  if (!timestamp) return ''
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

export function Popup() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [settings, setLocalSettings] = useState<Settings | null>(null)
  const [host, setHost] = useState('')
  const [pageTitle, setPageTitle] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null)

  const refresh = useCallback(async () => {
    const [serverStatus, currentStats, currentSettings] = await Promise.all([
      send<ServerStatus>({ type: 'status' }),
      send<StatsResponse>({ type: 'stats' }),
      getSettings(),
    ])
    setStatus(serverStatus)
    setStats(currentStats)
    setLocalSettings(currentSettings)
  }, [])

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.url) {
        try {
          setHost(new URL(tab.url).hostname)
        } catch {
          setHost('')
        }
      }
      setPageTitle(tab?.title ?? '')
      await refresh()
    })()
  }, [refresh])

  const supported = SUPPORTED[host]
  const harvesting = settings ? settings.harvest[host] !== false : true

  const capture = async () => {
    setCapturing(true)
    setFlash(null)
    try {
      const result = await send<{ ok: boolean; message: string }>({ type: 'capture-page' })
      setFlash(result)
      await refresh()
    } catch (error) {
      setFlash({ ok: false, message: (error as Error).message })
    } finally {
      setCapturing(false)
    }
  }

  const toggleHarvest = async () => {
    if (!host || !settings) return
    const next = { ...settings.harvest, [host]: !harvesting }
    setLocalSettings(await setSettings({ harvest: next }))
  }

  return (
    <div className="animate-pop">
      {/* header */}
      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        <svg width="15" height="15" viewBox="0 0 24 24" className="text-accent">
          <path d="M2 12 L12 2 L22 12 L12 22 Z" fill="currentColor" />
        </svg>
        <span className="text-[13px] font-semibold tracking-tight">Sift</span>

        <span className="ml-auto flex items-center gap-1.5">
          <span
            className={cx(
              'size-[6px] rounded-full',
              status === null ? 'bg-fg-quaternary' : status.online ? 'bg-success' : 'bg-danger',
            )}
          />
          <span className="text-[10px] text-fg-quaternary">
            {status === null ? 'checking…' : status.online ? `${status.items ?? 0} items` : 'offline'}
          </span>
        </span>
      </header>

      {/* server offline */}
      {status && !status.online && (
        <div className="border-b border-border-subtle bg-[oklch(30%_0.09_18/0.28)] px-3 py-2.5">
          <p className="text-[11px] font-medium text-danger">Sift server not reachable</p>
          <p className="mt-1 text-[10px] leading-relaxed text-fg-tertiary">
            Start it in the Sift repo with <code className="font-mono text-fg-secondary">pnpm dev</code>, then reopen this
            popup. Captures are dropped while it is down rather than queued, so nothing is silently lost.
          </p>
        </div>
      )}

      {/* current page */}
      <div className="px-3 py-3">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-fg-quaternary">This page</p>
        <p className="line-clamp-2 text-[12px] leading-snug text-fg-secondary">{pageTitle || host || 'No page'}</p>
        <p className="mt-1 truncate font-mono text-[10px] text-fg-quaternary">{host}</p>

        <button
          type="button"
          onClick={() => void capture()}
          disabled={capturing || !status?.online}
          className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[12px] font-medium text-white transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
        >
          {capturing ? 'Saving…' : 'Save this page'}
          <kbd className="rounded border border-white/25 px-1 font-mono text-[9px] opacity-80">⌥⇧S</kbd>
        </button>

        {flash && (
          <p className={cx('mt-2 text-[11px] leading-snug', flash.ok ? 'text-success' : 'text-warning')}>{flash.message}</p>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-fg-quaternary">
          Select text first to capture just that passage.
        </p>
      </div>

      {/* harvesting */}
      {supported && (
        <div className="border-t border-border-subtle px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="size-[7px] rounded-full" style={{ background: supported.colour }} />
            <span className="flex-1 text-[12px] font-medium">Auto-collect from {supported.label}</span>
            <button
              type="button"
              role="switch"
              aria-checked={harvesting}
              onClick={() => void toggleHarvest()}
              className={cx(
                'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors',
                harvesting ? 'border-accent bg-accent' : 'border-border bg-bg-inset',
              )}
            >
              <span
                className={cx(
                  'absolute top-[2px] size-[12px] rounded-full bg-white transition-transform',
                  harvesting ? 'translate-x-[16px]' : 'translate-x-[2px]',
                )}
              />
            </button>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-fg-quaternary">
            {harvesting
              ? `${supported.note} Posts you scroll past are scored and filed automatically.`
              : 'Off — nothing is collected here until you turn this back on.'}
          </p>
        </div>
      )}

      {!supported && host && (
        <div className="border-t border-border-subtle px-3 py-2.5">
          <p className="text-[10px] leading-relaxed text-fg-quaternary">
            Automatic collection runs on X and 小红书. Everywhere else, use the button above.
          </p>
        </div>
      )}

      {/* session stats */}
      {stats && (stats.sessionCaptured > 0 || stats.sessionDuplicates > 0 || stats.lastError) && (
        <div className="border-t border-border-subtle px-3 py-2.5">
          <div className="flex items-baseline gap-3 text-[10px] text-fg-quaternary">
            <span>
              <span className="font-mono text-[12px] text-fg-secondary">{stats.sessionCaptured}</span> new
            </span>
            <span>
              <span className="font-mono text-[12px] text-fg-tertiary">{stats.sessionDuplicates}</span> already had
            </span>
            {stats.lastCaptureAt && <span className="ml-auto">{timeAgo(stats.lastCaptureAt)}</span>}
          </div>
          {stats.lastError && <p className="mt-1.5 text-[10px] leading-snug text-warning">{stats.lastError}</p>}
        </div>
      )}

      {/* footer */}
      <footer className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
        <button
          type="button"
          onClick={() => {
            if (status?.online) void chrome.tabs.create({ url: status.url })
          }}
          disabled={!status?.online}
          className="rounded-md px-1.5 py-1 text-[11px] text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
        >
          Open Sift ↗
        </button>
        <span className="ml-auto font-mono text-[9px] text-fg-quaternary">
          {status?.version ? `v${status.version}` : ''} · local only
        </span>
      </footer>
    </div>
  )
}
