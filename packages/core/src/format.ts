/**
 * Presentation helpers shared by the web app and the extension popup, so a
 * relative timestamp or a compacted count renders identically in both.
 */
import type { ItemKind, SourceKind } from './types.js'

export const SOURCE_META: Record<SourceKind, { label: string; short: string; color: string }> = {
  x: { label: 'X', short: 'X', color: '#e7e9ea' },
  xiaohongshu: { label: '小红书', short: 'XHS', color: '#ff2e4d' },
  hackernews: { label: 'Hacker News', short: 'HN', color: '#ff6600' },
  arxiv: { label: 'arXiv', short: 'arXiv', color: '#b31b1b' },
  github: { label: 'GitHub', short: 'GH', color: '#8b949e' },
  rss: { label: 'RSS', short: 'RSS', color: '#f59e0b' },
  reddit: { label: 'Reddit', short: 'RDT', color: '#ff4500' },
  youtube: { label: 'YouTube', short: 'YT', color: '#ff0033' },
  producthunt: { label: 'Product Hunt', short: 'PH', color: '#da552f' },
  huggingface: { label: 'Hugging Face', short: 'HF', color: '#ffcc4d' },
  web: { label: 'Web', short: 'Web', color: '#7c8896' },
  manual: { label: 'Saved by you', short: 'You', color: '#8b7cf6' },
}

export const KIND_META: Record<ItemKind, { label: string; icon: string }> = {
  post: { label: 'Post', icon: 'message-square' },
  thread: { label: 'Thread', icon: 'list' },
  article: { label: 'Article', icon: 'file-text' },
  paper: { label: 'Paper', icon: 'graduation-cap' },
  repo: { label: 'Repo', icon: 'git-branch' },
  video: { label: 'Video', icon: 'play' },
  note: { label: 'Note', icon: 'sticky-note' },
  discussion: { label: 'Discussion', icon: 'messages-square' },
  release: { label: 'Release', icon: 'package' },
  model: { label: 'Model', icon: 'box' },
}

/** 12500 -> "12.5K", 3400000 -> "3.4M". Locale-independent by design. */
export function compactNumber(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) {
    const v = n / 1000
    return `${abs < 10_000 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}K`
  }
  if (abs < 1_000_000_000) {
    const v = n / 1_000_000
    return `${abs < 10_000_000 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}M`
  }
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`
}

const RELATIVE_UNITS: [limitSec: number, divisor: number, suffix: string, suffixZh: string][] = [
  [60, 1, 's', '秒'],
  [3600, 60, 'm', '分钟'],
  [86_400, 3600, 'h', '小时'],
  [604_800, 86_400, 'd', '天'],
  [2_629_800, 604_800, 'w', '周'],
  [31_557_600, 2_629_800, 'mo', '个月'],
  [Infinity, 31_557_600, 'y', '年'],
]

/** Compact relative time: "3m", "5h", "2d". `now` is injectable for testing. */
export function timeAgo(timestamp: number | undefined, now = Date.now(), locale: 'en' | 'zh' = 'en'): string {
  if (!timestamp) return '—'
  const diffSec = Math.max(0, Math.round((now - timestamp) / 1000))
  if (diffSec < 45) return locale === 'zh' ? '刚刚' : 'now'
  for (const [limit, divisor, suffix, suffixZh] of RELATIVE_UNITS) {
    if (diffSec < limit) {
      const value = Math.round(diffSec / divisor)
      return locale === 'zh' ? `${value}${suffixZh}前` : `${value}${suffix}`
    }
  }
  return '—'
}

/** Absolute timestamp for tooltips. */
export function formatDateTime(timestamp: number | undefined, locale = 'en-US'): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

/** "3 items" / "1 item" without pulling in an i18n library. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${compactNumber(n)} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`
}

/** Kebab-case slug, CJK-safe (Chinese characters are preserved, not stripped). */
export function slugify(input: string, maxLength = 80): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/['"“”‘’]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'untitled'
  )
}

/** Deterministic hue from a string — stable colours for tags and authors. */
export function stringHue(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 360
}

/** Two-character avatar fallback that works for Latin and CJK names. */
export function initials(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  if (/[一-鿿぀-ヿ가-힯]/.test(trimmed)) return trimmed.slice(0, 1)
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}
