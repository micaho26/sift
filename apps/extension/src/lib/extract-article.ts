/**
 * Article extraction for arbitrary pages.
 *
 * A compact readability implementation: score candidate containers by text
 * density and paragraph count, penalise the usual furniture, and take the winner.
 * Full Readability.js would be ~30 KB in the content script for a job that a
 * scoring heuristic does well enough — and this only ever runs on a page the user
 * explicitly asked to capture.
 */
import type { IngestItem } from '@sift/core'

const NEGATIVE =
  /(^|[\s_-])(comment|meta|footer|footnote|sidebar|sponsor|share|social|promo|banner|ad|advert|popup|modal|cookie|newsletter|subscribe|related|recommend|nav|menu|breadcrumb|pagination|tag-list|author-box|masthead|widget|toolbar|paywall)([\s_-]|$)/i
const POSITIVE = /(^|[\s_-])(article|body|content|entry|main|page|post|story|text|blog|markdown|prose)([\s_-]|$)/i
const STRIP_SELECTOR =
  'script, style, noscript, iframe, svg, form, nav, aside, header, footer, button, [aria-hidden="true"], .ad, .ads, [class*="cookie"], [class*="newsletter"], [class*="related"], [class*="share"]'

function identifier(element: Element): string {
  return `${element.className ?? ''} ${element.id ?? ''}`
}

/** Text length minus link text — link-dense blocks are navigation, not prose. */
function textDensity(element: Element): number {
  const text = element.textContent?.trim() ?? ''
  if (text.length < 40) return 0
  const linkText = [...element.querySelectorAll('a')].reduce((sum, a) => sum + (a.textContent?.length ?? 0), 0)
  return text.length - linkText * 1.4
}

function scoreCandidate(element: Element): number {
  const density = textDensity(element)
  if (density <= 0) return 0

  let score = density
  const id = identifier(element)
  if (NEGATIVE.test(id)) score *= 0.15
  if (POSITIVE.test(id)) score *= 1.6
  if (element.tagName === 'ARTICLE' || element.getAttribute('role') === 'article') score *= 2.2
  if (element.tagName === 'MAIN') score *= 1.8

  const paragraphs = element.querySelectorAll('p').length
  score += Math.min(paragraphs, 40) * 22

  // Deeply nested wrappers are usually layout, not the article body.
  let depth = 0
  let node: Element | null = element
  while (node && depth < 30) {
    depth++
    node = node.parentElement
  }
  if (depth > 14) score *= 0.85

  return score
}

/** Meta-tag lookup across the usual OpenGraph / Twitter / name variants. */
function meta(...names: string[]): string | undefined {
  for (const name of names) {
    const element =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`) ??
      document.querySelector(`meta[itemprop="${name}"]`)
    const content = element?.getAttribute('content')?.trim()
    if (content) return content
  }
  return undefined
}

/** JSON-LD is the most reliable source of author and publish date when present. */
function jsonLd(): { author?: string; published?: string; headline?: string; description?: string } {
  const out: { author?: string; published?: string; headline?: string; description?: string } = {}
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent ?? '') as unknown
      const nodes = Array.isArray(parsed) ? parsed : [parsed]
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue
        const record = node as Record<string, unknown>
        const graph = Array.isArray(record['@graph']) ? (record['@graph'] as Record<string, unknown>[]) : [record]
        for (const entry of graph) {
          const type = String(entry['@type'] ?? '')
          if (!/Article|BlogPosting|NewsArticle|Report|ScholarlyArticle/i.test(type)) continue
          const author = entry.author
          if (!out.author) {
            if (typeof author === 'string') out.author = author
            else if (Array.isArray(author) && typeof (author[0] as Record<string, unknown>)?.name === 'string') {
              out.author = String((author[0] as Record<string, unknown>).name)
            } else if (typeof author === 'object' && author !== null) {
              const name = (author as Record<string, unknown>).name
              if (typeof name === 'string') out.author = name
            }
          }
          if (!out.published && typeof entry.datePublished === 'string') out.published = entry.datePublished
          if (!out.headline && typeof entry.headline === 'string') out.headline = entry.headline
          if (!out.description && typeof entry.description === 'string') out.description = entry.description
        }
      }
    } catch {
      // Malformed JSON-LD is extremely common; ignore it.
    }
  }
  return out
}

/** Preserve paragraph and list structure while flattening to text. */
function toText(element: Element): string {
  const clone = element.cloneNode(true) as Element
  for (const junk of clone.querySelectorAll(STRIP_SELECTOR)) junk.remove()

  const lines: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) return
    if (!(node instanceof Element)) return

    const tag = node.tagName
    if (tag === 'PRE' || tag === 'CODE') {
      const code = node.textContent?.trim()
      if (code) lines.push(tag === 'PRE' ? `\`\`\`\n${code}\n\`\`\`` : code)
      return
    }
    if (/^H[1-6]$/.test(tag)) {
      const heading = node.textContent?.trim()
      if (heading) lines.push(`${'#'.repeat(Number(tag[1]))} ${heading}`)
      return
    }
    if (tag === 'LI') {
      const bullet = node.textContent?.trim().replace(/\s+/g, ' ')
      if (bullet) lines.push(`- ${bullet}`)
      return
    }
    if (tag === 'BLOCKQUOTE') {
      const quote = node.textContent?.trim().replace(/\s+/g, ' ')
      if (quote) lines.push(`> ${quote}`)
      return
    }
    if (tag === 'P') {
      const paragraph = node.textContent?.trim().replace(/\s+/g, ' ')
      if (paragraph && paragraph.length > 1) lines.push(paragraph)
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(clone)

  if (!lines.length) {
    const fallback = clone.textContent?.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return fallback ?? ''
  }
  return lines.join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, 120_000)
}

export type PageCapture = IngestItem & { extractedFrom: string }

/**
 * Extract the current page as one item. Uses the user's text selection as the
 * body when there is one — quoting a passage is usually what "capture this" means
 * once you have selected something.
 */
export function capturePage(): PageCapture {
  const selection = window.getSelection?.()?.toString().trim() ?? ''
  const ld = jsonLd()

  let best: Element | null = null
  let bestScore = 0
  for (const candidate of document.querySelectorAll('article, main, [role="main"], div, section')) {
    const score = scoreCandidate(candidate)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  const body = selection.length > 120 ? selection : best ? toText(best) : (document.body.innerText ?? '').slice(0, 40_000)

  const title =
    ld.headline ??
    meta('og:title', 'twitter:title') ??
    document.querySelector('h1')?.textContent?.trim() ??
    document.title.replace(/\s*[|\-–—]\s*[^|\-–—]{0,40}$/, '').trim() ??
    location.href

  const description = meta('og:description', 'twitter:description', 'description') ?? ld.description
  const image = meta('og:image', 'twitter:image', 'og:image:secure_url')
  const published = meta('article:published_time', 'article:published', 'datePublished') ?? ld.published
  const author =
    ld.author ??
    meta('article:author', 'author', 'twitter:creator')?.replace(/^@/, '') ??
    document.querySelector('[rel="author"], .author, [itemprop="author"]')?.textContent?.trim()

  const host = location.hostname.replace(/^www\./, '')

  return {
    url: location.href,
    // Manual captures are always wanted, so they bypass the inbox threshold.
    source: 'manual',
    kind: 'article',
    title: title.slice(0, 400),
    summary: description?.slice(0, 1500),
    content: body,
    lang: document.documentElement.lang?.slice(0, 5) || undefined,
    author: author ? { name: author.slice(0, 120) } : { name: host },
    media: image ? [{ type: 'image', url: image }] : undefined,
    publishedAt: published ? Date.parse(published) || undefined : undefined,
    tags: selection.length > 120 ? ['highlighted'] : undefined,
    extractedFrom: selection.length > 120 ? 'selection' : best ? `${best.tagName.toLowerCase()} (score ${Math.round(bestScore)})` : 'body',
  }
}
