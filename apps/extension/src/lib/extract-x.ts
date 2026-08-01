/**
 * X / Twitter extraction.
 *
 * Two independent paths, because either one alone breaks:
 *
 *  1. **GraphQL responses** (primary). The page fetches its own timeline as JSON;
 *     we read that JSON. It carries exact counts, full untruncated text, author
 *     follower numbers and real timestamps — none of which the DOM reliably has.
 *     Rather than hardcode response paths (which X reshuffles), we walk the object
 *     recursively and pick out anything that *looks* like a Tweet. Shape-tolerant
 *     by construction.
 *
 *  2. **DOM scraping** (fallback). Works even if the JSON shape changes beyond
 *     recognition, at the cost of truncated text and rounded counts.
 *
 * Both read only what the logged-in user is already looking at. Nothing is
 * requested that the page did not request itself, no credentials are touched, and
 * no data leaves the machine.
 */
import type { IngestItem } from '@sift/core'

/* ------------------------------------------------------------- JSON walking -- */

type Unknown = Record<string, unknown>

function isObject(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null
}

/** Parse an X count that may arrive as a number or a string. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,\s]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Recursively collect every object that looks like a tweet.
 *
 * The signature we match on is `legacy.full_text` plus an id — stable across
 * every X response shape since 2022, and unlikely to appear by accident.
 */
export function findTweetNodes(root: unknown, limit = 200): Unknown[] {
  const found: Unknown[] = []
  const seen = new Set<unknown>()

  const visit = (node: unknown, depth: number) => {
    if (found.length >= limit || depth > 14 || !isObject(node)) return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1)
      return
    }

    const legacy = node.legacy
    const typename = node.__typename
    const looksLikeTweet =
      (isObject(legacy) && typeof legacy.full_text === 'string') ||
      (typename === 'Tweet' && isObject(node.legacy)) ||
      typeof node.full_text === 'string'

    if (looksLikeTweet) {
      found.push(node)
      // Do not descend into a matched tweet's own body, but do keep looking at
      // quoted/retweeted children, which are separate items worth capturing.
      for (const key of ['quoted_status_result', 'retweeted_status_result']) {
        if (key in node) visit(node[key], depth + 1)
      }
      return
    }

    for (const value of Object.values(node)) visit(value, depth + 1)
  }

  visit(root, 0)
  return found
}

/** Pull the user object out of whichever nesting this response uses. */
function extractUser(node: Unknown): {
  name?: string
  handle?: string
  followers?: number
  verified?: boolean
  avatarUrl?: string
  bio?: string
} {
  const candidates: unknown[] = [
    (node.core as Unknown | undefined)?.user_results,
    (node.core as Unknown | undefined)?.user_result,
    node.user_results,
    (node.legacy as Unknown | undefined)?.user,
    node.user,
  ]

  for (const candidate of candidates) {
    if (!isObject(candidate)) continue
    // Unwrap `{ result: {...} }`.
    const result = isObject(candidate.result) ? (candidate.result as Unknown) : candidate
    const legacy = isObject(result.legacy) ? (result.legacy as Unknown) : result
    const core = isObject(result.core) ? (result.core as Unknown) : undefined

    const handle =
      (typeof legacy.screen_name === 'string' && legacy.screen_name) ||
      (core && typeof core.screen_name === 'string' && core.screen_name) ||
      undefined
    const name =
      (typeof legacy.name === 'string' && legacy.name) ||
      (core && typeof core.name === 'string' && core.name) ||
      undefined
    if (!handle && !name) continue

    return {
      handle: handle || undefined,
      name: name || handle || undefined,
      followers: num(legacy.followers_count) ?? num((result as Unknown).followers_count),
      verified:
        legacy.verified === true ||
        result.is_blue_verified === true ||
        isObject(result.verification) && (result.verification as Unknown).verified === true,
      avatarUrl:
        (typeof legacy.profile_image_url_https === 'string' && legacy.profile_image_url_https.replace('_normal', '_x96')) ||
        undefined,
      bio: typeof legacy.description === 'string' ? legacy.description : undefined,
    }
  }
  return {}
}

/** X's `note_tweet` holds the untruncated body of a long post. */
function extractText(node: Unknown, legacy: Unknown): string {
  const noteTweet = node.note_tweet as Unknown | undefined
  const noteResults = noteTweet?.note_tweet_results as Unknown | undefined
  const noteResult = noteResults?.result as Unknown | undefined
  if (noteResult && typeof noteResult.text === 'string' && noteResult.text.length > 0) return noteResult.text
  if (typeof legacy.full_text === 'string') return legacy.full_text
  if (typeof node.full_text === 'string') return node.full_text
  return ''
}

/** Replace t.co links with their real destinations, and drop the trailing self-link. */
function expandUrls(text: string, legacy: Unknown): string {
  const entities = legacy.entities as Unknown | undefined
  const urls = Array.isArray(entities?.urls) ? (entities!.urls as Unknown[]) : []
  let output = text
  for (const entry of urls) {
    const short = entry.url
    const expanded = entry.expanded_url
    if (typeof short === 'string' && typeof expanded === 'string') {
      output = output.split(short).join(expanded)
    }
  }
  // Media links appear as a bare t.co at the end and add nothing.
  return output.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').trim()
}

function extractMedia(legacy: Unknown): IngestItem['media'] {
  const extended = legacy.extended_entities as Unknown | undefined
  const entities = legacy.entities as Unknown | undefined
  const list = Array.isArray(extended?.media)
    ? (extended!.media as Unknown[])
    : Array.isArray(entities?.media)
      ? (entities!.media as Unknown[])
      : []

  const media: NonNullable<IngestItem['media']> = []
  for (const entry of list.slice(0, 8)) {
    const url = typeof entry.media_url_https === 'string' ? entry.media_url_https : undefined
    if (!url) continue
    const type = entry.type === 'video' ? 'video' : entry.type === 'animated_gif' ? 'gif' : 'image'
    const sizes = entry.original_info as Unknown | undefined
    media.push({
      type,
      url,
      thumbUrl: `${url}?format=jpg&name=small`,
      width: num(sizes?.width),
      height: num(sizes?.height),
      alt: typeof entry.ext_alt_text === 'string' ? entry.ext_alt_text : undefined,
    })
  }
  return media
}

/** Convert one tweet node into an ingest payload. */
export function tweetToItem(node: Unknown): IngestItem | null {
  const legacy = isObject(node.legacy) ? (node.legacy as Unknown) : node
  const id =
    (typeof legacy.id_str === 'string' && legacy.id_str) ||
    (typeof node.rest_id === 'string' && node.rest_id) ||
    (typeof legacy.conversation_id_str === 'string' && legacy.conversation_id_str) ||
    undefined
  if (!id) return null

  const author = extractUser(node)
  const handle = author.handle ?? 'i'
  const raw = extractText(node, legacy)
  if (!raw.trim()) return null
  const text = expandUrls(raw, legacy)

  const publishedAt = typeof legacy.created_at === 'string' ? Date.parse(legacy.created_at) || undefined : undefined
  const views = num((node.views as Unknown | undefined)?.count)
  const isThread =
    typeof legacy.conversation_id_str === 'string' &&
    legacy.conversation_id_str === id &&
    (num(legacy.reply_count) ?? 0) > 0 &&
    text.length > 400

  // The first line makes a far better title than a truncation of the whole post.
  const firstLine = text.split('\n').find((line) => line.trim().length > 12)?.trim() ?? text
  const title = firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine

  return {
    url: `https://x.com/${handle}/status/${id}`,
    source: 'x',
    sourceId: id,
    kind: isThread ? 'thread' : 'post',
    title,
    content: text,
    lang: typeof legacy.lang === 'string' && legacy.lang !== 'und' ? legacy.lang : undefined,
    author: {
      name: author.name ?? handle,
      handle,
      url: `https://x.com/${handle}`,
      avatarUrl: author.avatarUrl,
      followers: author.followers,
      verified: author.verified,
      bio: author.bio,
    },
    metrics: {
      likes: num(legacy.favorite_count),
      reposts: num(legacy.retweet_count),
      replies: num(legacy.reply_count),
      quotes: num(legacy.quote_count),
      bookmarks: num(legacy.bookmark_count),
      views,
    },
    media: extractMedia(legacy),
    publishedAt,
  }
}

/** Extract every tweet from a captured GraphQL response body. */
export function itemsFromGraphql(payload: unknown, limit = 120): IngestItem[] {
  const nodes = findTweetNodes(payload, limit * 2)
  const items: IngestItem[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    const item = tweetToItem(node)
    if (!item || seen.has(item.url)) continue
    seen.add(item.url)
    items.push(item)
    if (items.length >= limit) break
  }
  return items
}

/* ------------------------------------------------------------ DOM fallback -- */

/** "1.2K" / "3.4M" / "1,234" -> number. */
function parseCompact(text: string | null | undefined): number | undefined {
  if (!text) return undefined
  const cleaned = text.replace(/[,\s]/g, '').toUpperCase()
  const match = /^([\d.]+)([KMB])?$/.exec(cleaned)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const multiplier = match[2] === 'B' ? 1e9 : match[2] === 'M' ? 1e6 : match[2] === 'K' ? 1e3 : 1
  return Math.round(value * multiplier)
}

/**
 * Read tweets from rendered articles. Text may be truncated by "Show more" and
 * counts are rounded, so this is strictly the fallback — but it always works.
 */
export function itemsFromDom(root: ParentNode = document, limit = 60): IngestItem[] {
  const articles = [...root.querySelectorAll('article[data-testid="tweet"], article[role="article"]')]
  const items: IngestItem[] = []
  const seen = new Set<string>()

  for (const article of articles.slice(0, limit * 2)) {
    // The permalink is the only reliable identity anchor in the DOM.
    const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:not([href*="/analytics"])')
    const href = link?.getAttribute('href')
    const match = href ? /^\/([A-Za-z0-9_]{1,20})\/status\/(\d+)/.exec(href) : null
    if (!match) continue
    const [, handle, id] = match
    const url = `https://x.com/${handle}/status/${id}`
    if (seen.has(url)) continue

    const textElement = article.querySelector('[data-testid="tweetText"]')
    const text = textElement?.textContent?.trim() ?? ''
    if (!text) continue

    const time = article.querySelector('time')?.getAttribute('datetime')
    const nameElement = article.querySelector('[data-testid="User-Name"]')
    const name = nameElement?.textContent?.split('@')[0]?.trim()

    const metricOf = (testid: string) => {
      const button = article.querySelector(`[data-testid="${testid}"]`)
      const label = button?.getAttribute('aria-label') ?? button?.textContent ?? ''
      const numeric = /([\d.,]+[KMB]?)/.exec(label)
      return parseCompact(numeric?.[1])
    }

    const images = [...article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img')]
      .map((img) => img.src)
      .filter((src) => src.includes('twimg.com'))
      .slice(0, 4)

    seen.add(url)
    const firstLine = text.split('\n').find((line) => line.trim().length > 12)?.trim() ?? text
    items.push({
      url,
      source: 'x',
      sourceId: id,
      kind: text.length > 400 ? 'thread' : 'post',
      title: firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine,
      content: text,
      author: { name: name || handle!, handle: handle!, url: `https://x.com/${handle}` },
      metrics: {
        likes: metricOf('like') ?? metricOf('unlike'),
        reposts: metricOf('retweet') ?? metricOf('unretweet'),
        replies: metricOf('reply'),
        bookmarks: metricOf('bookmark') ?? metricOf('removeBookmark'),
      },
      media: images.map((src) => ({ type: 'image' as const, url: src })),
      publishedAt: time ? Date.parse(time) || undefined : undefined,
    })
    if (items.length >= limit) break
  }

  return items
}

/** GraphQL operations worth listening to. Anything else is noise. */
export const X_OPERATIONS =
  /\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline|UserTweets|UserTweetsAndReplies|TweetDetail|SearchTimeline|Bookmarks|ListLatestTweetsTimeline|CommunityTweetsTimeline|UserMedia|Likes)/
