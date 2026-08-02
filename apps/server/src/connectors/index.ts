/**
 * Connectors — the server-side half of collection.
 *
 * Every connector here reaches a *public, keyless* endpoint. That is a deliberate
 * product constraint: a new user must get a full inbox within seconds of first
 * launch without signing up for anything. Platforms that require an authenticated
 * session (X, Xiaohongshu) are handled by the browser extension instead, which
 * reads what the user can already see.
 */
import type { IngestItem, SourceConfig, SourceKind } from '@sift/core'
import { htmlToText } from '@sift/core'
import { log } from '../log.ts'
import { parseFeed } from './feed-parser.ts'

export type ConnectorContext = { source: SourceConfig }
export type Connector = (context: ConnectorContext) => Promise<IngestItem[]>

const USER_AGENT = 'Sift/0.1 (local-first AI news reader; +https://github.com/micaho26/sift)'
const TIMEOUT_MS = 20_000

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return response.text()
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return (await response.json()) as T
}

/* ------------------------------------------------------------ hacker news -- */

type AlgoliaHit = {
  objectID: string
  title?: string
  story_title?: string
  url?: string
  story_url?: string
  author?: string
  points?: number
  num_comments?: number
  created_at_i?: number
  story_text?: string
  comment_text?: string
  _tags?: string[]
}

/**
 * HN via the Algolia search API. `search_by_date` with a points floor gives the
 * things that are *becoming* popular, which is what we want — the front page is
 * already a lagging indicator by the time it settles.
 */
const hackernews: Connector = async ({ source }) => {
  const query = encodeURIComponent(source.target || 'AI')
  const minPoints = source.filters.minEngagement ?? 25
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=story&numericFilters=points>=${minPoints}&hitsPerPage=50`
  const data = await fetchJson<{ hits: AlgoliaHit[] }>(url)

  return data.hits
    .map((hit): IngestItem | null => {
      const discussionUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`
      const target = hit.url ?? hit.story_url
      const title = hit.title ?? hit.story_title
      if (!title) return null
      return {
        // Prefer the article itself; keep the discussion URL in raw for the UI.
        url: target ?? discussionUrl,
        source: 'hackernews',
        sourceId: hit.objectID,
        kind: target ? 'article' : 'discussion',
        title,
        content: hit.story_text ? htmlToText(hit.story_text) : undefined,
        author: hit.author ? { name: hit.author, handle: hit.author, url: `https://news.ycombinator.com/user?id=${hit.author}` } : undefined,
        metrics: { points: hit.points ?? 0, comments: hit.num_comments ?? 0 },
        publishedAt: hit.created_at_i ? hit.created_at_i * 1000 : undefined,
        raw: { discussionUrl, tags: hit._tags },
      }
    })
    .filter((item): item is IngestItem => item !== null)
}

/* ------------------------------------------------------------------ arxiv -- */

/**
 * arXiv's Atom API. Sorted by submission date so we see new work, not
 * whatever is most cited.
 */
const arxiv: Connector = async ({ source }) => {
  const query = encodeURIComponent(source.target || 'cat:cs.AI')
  const url = `https://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=40`
  const xml = await fetchText(url)
  const feed = parseFeed(xml)

  return feed.items.map((entry): IngestItem => {
    // Authors arrive as a single string from the parser; the first is enough for
    // attribution and keeps the feed row readable.
    const firstAuthor = entry.author?.split(/,|\band\b/)[0]?.trim()
    return {
      url: entry.link,
      source: 'arxiv',
      kind: 'paper',
      title: entry.title.replace(/\s+/g, ' '),
      summary: entry.description?.replace(/\s+/g, ' ').slice(0, 3000),
      content: entry.description?.replace(/\s+/g, ' '),
      author: firstAuthor ? { name: firstAuthor } : undefined,
      publishedAt: entry.publishedAt,
      topics: entry.categories.length ? undefined : undefined,
      raw: { categories: entry.categories, allAuthors: entry.author },
    }
  })
}

/* ----------------------------------------------------------------- github -- */

type GithubRepo = {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  forks_count: number
  created_at: string
  pushed_at: string
  language: string | null
  topics?: string[]
  owner: { login: string; avatar_url: string; html_url: string }
}

/**
 * Repos created recently and already gathering stars — a much better novelty
 * signal than all-time star count, which just returns the same famous repos.
 */
const github: Connector = async ({ source }) => {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
  const query = encodeURIComponent(`${source.target || 'topic:llm'} created:>${since} stars:>40`)
  const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=30`
  const data = await fetchJson<{ items: GithubRepo[] }>(url, { accept: 'application/vnd.github+json' })

  return (data.items ?? []).map(
    (repo): IngestItem => ({
      url: repo.html_url,
      source: 'github',
      sourceId: repo.full_name,
      kind: 'repo',
      title: `${repo.full_name} — ${repo.description ?? 'no description'}`.slice(0, 300),
      summary: repo.description ?? undefined,
      content: [repo.description, repo.language ? `Language: ${repo.language}` : '', (repo.topics ?? []).join(', ')]
        .filter(Boolean)
        .join('\n'),
      author: { name: repo.owner.login, handle: repo.owner.login, url: repo.owner.html_url, avatarUrl: repo.owner.avatar_url },
      metrics: { stars: repo.stargazers_count, forks: repo.forks_count },
      publishedAt: Date.parse(repo.created_at) || undefined,
      tags: (repo.topics ?? []).slice(0, 8),
      raw: { pushedAt: repo.pushed_at, language: repo.language },
    }),
  )
}

/* ----------------------------------------------------------- hugging face -- */

type HfPaper = {
  paper: {
    id: string
    title: string
    summary: string
    upvotes?: number
    publishedAt?: string
    authors?: { name: string }[]
  }
  numComments?: number
  thumbnail?: string
}

/** Hugging Face daily papers — human-curated, which is a strong prior. */
const huggingface: Connector = async () => {
  const data = await fetchJson<HfPaper[]>('https://huggingface.co/api/daily_papers?limit=40')
  return (data ?? []).map(
    (entry): IngestItem => ({
      url: `https://huggingface.co/papers/${entry.paper.id}`,
      source: 'huggingface',
      sourceId: entry.paper.id,
      kind: 'paper',
      title: entry.paper.title.replace(/\s+/g, ' '),
      summary: entry.paper.summary?.replace(/\s+/g, ' ').slice(0, 3000),
      content: entry.paper.summary?.replace(/\s+/g, ' '),
      author: entry.paper.authors?.[0] ? { name: entry.paper.authors[0].name } : undefined,
      metrics: { likes: entry.paper.upvotes ?? 0, comments: entry.numComments ?? 0 },
      publishedAt: entry.paper.publishedAt ? Date.parse(entry.paper.publishedAt) || undefined : undefined,
      media: entry.thumbnail ? [{ type: 'image', url: entry.thumbnail }] : undefined,
      raw: { arxivId: entry.paper.id },
    }),
  )
}

/* ----------------------------------------------------------------- reddit -- */

type RedditListing = {
  data: {
    children: {
      data: {
        id: string
        title: string
        selftext?: string
        url?: string
        permalink: string
        author: string
        ups: number
        num_comments: number
        created_utc: number
        link_flair_text?: string | null
        is_self: boolean
        thumbnail?: string
        preview?: { images?: { source?: { url: string; width: number; height: number } }[] }
      }
    }[]
  }
}

/** Reddit's public `.json` endpoints. No key, but be gentle with the rate. */
const reddit: Connector = async ({ source }) => {
  const subreddit = (source.target || 'LocalLLaMA').replace(/^\/?r\//, '')
  const data = await fetchJson<RedditListing>(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?t=day&limit=40`)

  return (data.data?.children ?? [])
    .map(({ data: post }): IngestItem | null => {
      if (!post?.id) return null
      const permalink = `https://www.reddit.com${post.permalink}`
      const image = post.preview?.images?.[0]?.source
      return {
        url: post.is_self || !post.url ? permalink : post.url,
        source: 'reddit',
        sourceId: post.id,
        kind: post.is_self ? 'discussion' : 'article',
        title: post.title,
        content: post.selftext ? post.selftext.slice(0, 40_000) : undefined,
        author: { name: post.author, handle: post.author, url: `https://www.reddit.com/user/${post.author}` },
        metrics: { points: post.ups ?? 0, comments: post.num_comments ?? 0 },
        publishedAt: post.created_utc ? post.created_utc * 1000 : undefined,
        tags: post.link_flair_text ? [post.link_flair_text] : undefined,
        media: image?.url
          ? [{ type: 'image', url: image.url.replace(/&amp;/g, '&'), width: image.width, height: image.height }]
          : undefined,
        raw: { permalink, subreddit },
      }
    })
    .filter((item): item is IngestItem => item !== null)
}

/* -------------------------------------------------------------------- rss -- */

const rss: Connector = async ({ source }) => {
  const xml = await fetchText(source.target, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' })
  const feed = parseFeed(xml)
  if (!feed.items.length) throw new Error('feed contained no readable entries')

  return feed.items.slice(0, 60).map((entry): IngestItem => {
    const body = entry.content || entry.description || ''
    const text = htmlToText(body)
    return {
      url: entry.link,
      source: 'rss',
      kind: 'article',
      title: entry.title.replace(/\s+/g, ' ').slice(0, 500),
      summary: text ? text.slice(0, 1500) : undefined,
      content: text || undefined,
      author: entry.author ? { name: entry.author } : { name: feed.title },
      publishedAt: entry.publishedAt,
      tags: entry.categories.slice(0, 6),
      media: entry.enclosureUrl ? [{ type: 'image', url: entry.enclosureUrl }] : undefined,
      raw: { feed: feed.title },
    }
  })
}

/* --------------------------------------------------------------- registry -- */

export const CONNECTORS: Partial<Record<SourceKind, Connector>> = {
  hackernews,
  arxiv,
  github,
  huggingface,
  reddit,
  rss,
}

/** Sources the extension pushes to us; there is nothing to poll. */
export const PUSH_ONLY_SOURCES: SourceKind[] = ['x', 'xiaohongshu', 'manual', 'web']

export function hasConnector(kind: SourceKind): boolean {
  return kind in CONNECTORS
}

/**
 * Run one source. Applies the source's include/exclude keyword filters here so
 * they are enforced identically regardless of connector.
 */
export async function runConnector(source: SourceConfig): Promise<IngestItem[]> {
  const connector = CONNECTORS[source.kind]
  if (!connector) {
    if (PUSH_ONLY_SOURCES.includes(source.kind)) return []
    throw new Error(`No connector for source kind "${source.kind}"`)
  }

  const started = performance.now()
  const items = await connector({ source })
  log.debug(`${source.name}: fetched ${items.length} items in ${Math.round(performance.now() - started)}ms`)

  const { includeKeywords, excludeKeywords, lang } = source.filters
  return items.filter((item) => {
    const haystack = `${item.title}\n${item.summary ?? ''}\n${item.content ?? ''}`.toLowerCase()
    if (includeKeywords?.length && !includeKeywords.some((k) => haystack.includes(k.toLowerCase()))) return false
    if (excludeKeywords?.length && excludeKeywords.some((k) => haystack.includes(k.toLowerCase()))) return false
    if (lang?.length && item.lang && !lang.includes(item.lang)) return false
    return true
  })
}
