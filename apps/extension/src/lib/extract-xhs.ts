/**
 * Xiaohongshu (小红书) extraction.
 *
 * Same two-path strategy as X, adapted to what this platform actually exposes:
 *
 *  1. **State + API JSON**. The page ships `window.__INITIAL_STATE__` and fetches
 *     `/api/sns/web/v1/feed` for note bodies. Both are read where available; the
 *     shape is walked rather than pathed, since it changes between releases.
 *
 *  2. **DOM**. The explore grid and the note page both render enough to build a
 *     useful item — title, author, like count, cover image.
 *
 * Note ids here are 24-hex strings and the `xsec_token` query parameter is a
 * per-session capability, not part of the note's identity, so it is stripped
 * before the URL becomes a dedup key (server-side canonicalisation does this too).
 */
import type { IngestItem } from '@sift/core'

type Unknown = Record<string, unknown>

function isObject(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    // Counts arrive as "1.2万", "3243", "10+".
    const wan = /^([\d.]+)\s*万$/.exec(value.trim())
    if (wan) return Math.round(Number(wan[1]) * 10_000)
    const yi = /^([\d.]+)\s*亿$/.exec(value.trim())
    if (yi) return Math.round(Number(yi[1]) * 100_000_000)
    const plain = Number(value.replace(/[,+\s]/g, ''))
    if (Number.isFinite(plain)) return plain
  }
  return undefined
}

const NOTE_ID = /^[0-9a-f]{16,32}$/i

/**
 * Recursively find note-shaped objects. The signature is a 24-hex `note_id`
 * (or `id`) alongside a `title` or `desc` field.
 */
export function findNoteNodes(root: unknown, limit = 120): Unknown[] {
  const found: Unknown[] = []
  const seen = new Set<unknown>()

  const visit = (node: unknown, depth: number) => {
    if (found.length >= limit || depth > 12 || !isObject(node)) return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1)
      return
    }

    const id = node.note_id ?? node.noteId ?? node.id
    const hasNoteId = typeof id === 'string' && NOTE_ID.test(id)
    const hasBody = typeof node.title === 'string' || typeof node.desc === 'string'
    // `type` is 'normal' | 'video' on real notes and absent on wrappers.
    const hasType = node.type === 'normal' || node.type === 'video'

    if (hasNoteId && (hasBody || hasType)) {
      found.push(node)
      return
    }

    for (const value of Object.values(node)) visit(value, depth + 1)
  }

  visit(root, 0)
  return found
}

function extractAuthor(node: Unknown): { name?: string; handle?: string; avatarUrl?: string } {
  for (const key of ['user', 'author', 'userInfo', 'user_info']) {
    const candidate = node[key]
    if (!isObject(candidate)) continue
    const name =
      (typeof candidate.nickname === 'string' && candidate.nickname) ||
      (typeof candidate.nick_name === 'string' && candidate.nick_name) ||
      (typeof candidate.name === 'string' && candidate.name) ||
      undefined
    const handle =
      (typeof candidate.user_id === 'string' && candidate.user_id) ||
      (typeof candidate.userId === 'string' && candidate.userId) ||
      (typeof candidate.id === 'string' && candidate.id) ||
      undefined
    const avatarUrl =
      (typeof candidate.avatar === 'string' && candidate.avatar) ||
      (typeof candidate.images === 'string' && candidate.images) ||
      undefined
    if (name || handle) return { name, handle, avatarUrl }
  }
  return {}
}

function extractInteract(node: Unknown): IngestItem['metrics'] {
  const interact =
    (isObject(node.interact_info) && (node.interact_info as Unknown)) ||
    (isObject(node.interactInfo) && (node.interactInfo as Unknown)) ||
    node

  return {
    likes: num(interact.liked_count ?? interact.likedCount ?? interact.likes),
    collects: num(interact.collected_count ?? interact.collectedCount ?? interact.collects),
    comments: num(interact.comment_count ?? interact.commentCount ?? interact.comments),
    reposts: num(interact.share_count ?? interact.shareCount ?? interact.shares),
    views: num(interact.view_count ?? interact.viewCount),
  }
}

function extractCover(node: Unknown): IngestItem['media'] {
  const media: NonNullable<IngestItem['media']> = []

  const pushUrl = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('http') && media.length < 8) {
      media.push({ type: 'image', url: value })
    }
  }

  for (const key of ['cover', 'image_list', 'imageList', 'images']) {
    const candidate = node[key]
    if (typeof candidate === 'string') pushUrl(candidate)
    else if (isObject(candidate) && !Array.isArray(candidate)) {
      pushUrl(candidate.url ?? candidate.url_default ?? candidate.urlDefault ?? candidate.info_list)
    } else if (Array.isArray(candidate)) {
      for (const entry of candidate.slice(0, 8)) {
        if (typeof entry === 'string') pushUrl(entry)
        else if (isObject(entry)) pushUrl(entry.url ?? entry.url_default ?? entry.urlDefault)
      }
    }
  }
  return media
}

export function noteToItem(node: Unknown): IngestItem | null {
  const rawId = node.note_id ?? node.noteId ?? node.id
  const id = typeof rawId === 'string' && NOTE_ID.test(rawId) ? rawId.toLowerCase() : null
  if (!id) return null

  const title = typeof node.title === 'string' ? node.title.trim() : ''
  const desc = typeof node.desc === 'string' ? node.desc.trim() : ''
  if (!title && !desc) return null

  const author = extractAuthor(node)
  const time = num(node.time ?? node.create_time ?? node.createTime ?? node.last_update_time)
  // Xiaohongshu timestamps are sometimes seconds, sometimes milliseconds.
  const publishedAt = time ? (time < 1e12 ? time * 1000 : time) : undefined

  return {
    url: `https://www.xiaohongshu.com/explore/${id}`,
    source: 'xiaohongshu',
    sourceId: id,
    kind: node.type === 'video' ? 'video' : 'note',
    title: (title || desc.split('\n')[0] || '').slice(0, 300),
    content: [title, desc].filter(Boolean).join('\n\n') || undefined,
    lang: 'zh',
    author: author.name || author.handle
      ? {
          name: author.name ?? author.handle ?? '',
          handle: author.handle,
          url: author.handle ? `https://www.xiaohongshu.com/user/profile/${author.handle}` : undefined,
          avatarUrl: author.avatarUrl,
        }
      : undefined,
    metrics: extractInteract(node),
    media: extractCover(node),
    publishedAt,
  }
}

export function itemsFromState(payload: unknown, limit = 80): IngestItem[] {
  const nodes = findNoteNodes(payload, limit * 2)
  const items: IngestItem[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    const item = noteToItem(node)
    if (!item || seen.has(item.url)) continue
    seen.add(item.url)
    items.push(item)
    if (items.length >= limit) break
  }
  return items
}

/* ------------------------------------------------------------ DOM fallback -- */

function parseChineseCount(text: string | null | undefined): number | undefined {
  if (!text) return undefined
  return num(text.trim())
}

/** Read the explore grid and the open note. */
export function itemsFromDom(root: ParentNode = document, limit = 60): IngestItem[] {
  const items: IngestItem[] = []
  const seen = new Set<string>()

  // --- grid cards --------------------------------------------------------- //
  const cards = [...root.querySelectorAll('section.note-item, div.note-item, a.cover[href*="/explore/"]')]
  for (const card of cards) {
    const anchor =
      card instanceof HTMLAnchorElement ? card : card.querySelector<HTMLAnchorElement>('a[href*="/explore/"], a[href*="/discovery/item/"]')
    const href = anchor?.getAttribute('href')
    const match = href ? /(?:\/explore\/|\/discovery\/item\/)([0-9a-f]{16,32})/i.exec(href) : null
    if (!match) continue
    const id = match[1]!.toLowerCase()
    const url = `https://www.xiaohongshu.com/explore/${id}`
    if (seen.has(url)) continue

    const title = card.querySelector('.title, .footer .title span, [class*="title"]')?.textContent?.trim()
    if (!title) continue
    const author = card.querySelector('.author .name, .author-wrapper .name, [class*="author"] .name')?.textContent?.trim()
    const likes = parseChineseCount(card.querySelector('.like-wrapper .count, [class*="like"] .count')?.textContent)
    const cover = card.querySelector<HTMLImageElement>('img')?.src

    seen.add(url)
    items.push({
      url,
      source: 'xiaohongshu',
      sourceId: id,
      kind: 'note',
      title: title.slice(0, 300),
      content: title,
      lang: 'zh',
      author: author ? { name: author } : undefined,
      metrics: { likes },
      media: cover ? [{ type: 'image', url: cover }] : undefined,
    })
    if (items.length >= limit) break
  }

  // --- the open note ------------------------------------------------------ //
  const noteMatch = /(?:\/explore\/|\/discovery\/item\/)([0-9a-f]{16,32})/i.exec(location.pathname)
  if (noteMatch) {
    const id = noteMatch[1]!.toLowerCase()
    const url = `https://www.xiaohongshu.com/explore/${id}`
    const title = document.querySelector('#detail-title, .title, [class*="detail-title"]')?.textContent?.trim()
    const desc = document.querySelector('#detail-desc, .desc, [class*="detail-desc"]')?.textContent?.trim()
    if (title || desc) {
      const author = document.querySelector('.author-container .username, .info .name, [class*="username"]')?.textContent?.trim()
      const likes = parseChineseCount(document.querySelector('.like-wrapper .count, [class*="like-active"] + .count')?.textContent)
      const collects = parseChineseCount(document.querySelector('.collect-wrapper .count')?.textContent)
      const comments = parseChineseCount(document.querySelector('.chat-wrapper .count')?.textContent)
      const images = [...document.querySelectorAll<HTMLImageElement>('.swiper-slide img, .note-slider img')]
        .map((img) => img.src)
        .filter((src) => src.startsWith('http'))
        .slice(0, 8)

      // The open note is authoritative — replace any grid stub for the same id.
      const existing = items.findIndex((item) => item.url === url)
      const item: IngestItem = {
        url,
        source: 'xiaohongshu',
        sourceId: id,
        kind: 'note',
        title: (title ?? desc ?? '').slice(0, 300),
        content: [title, desc].filter(Boolean).join('\n\n'),
        lang: 'zh',
        author: author ? { name: author } : undefined,
        metrics: { likes, collects, comments },
        media: images.map((src) => ({ type: 'image' as const, url: src })),
      }
      if (existing >= 0) items[existing] = item
      else items.unshift(item)
    }
  }

  return items
}

/** API paths worth intercepting. */
export const XHS_ENDPOINTS = /\/api\/sns\/web\/v\d\/(feed|homefeed|note\/|search\/notes|user_posted)/
