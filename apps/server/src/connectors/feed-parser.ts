/**
 * A small, dependency-free RSS / Atom / RDF parser.
 *
 * Pulling in a full XML parser for this would add a transitive tree we do not
 * otherwise need, and feeds in the wild are so inconsistent that a strict parser
 * fails on them anyway. This handles the three container formats, CDATA, numeric
 * and named entities, and the half-dozen date formats feeds actually use.
 */

export type FeedItem = {
  title: string
  link: string
  description?: string
  content?: string
  author?: string
  publishedAt?: number
  categories: string[]
  enclosureUrl?: string
}

export type ParsedFeed = {
  title: string
  link?: string
  items: FeedItem[]
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" resolves correctly
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function stripCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function clean(input: string | undefined): string {
  if (!input) return ''
  return decodeEntities(stripCdata(input)).trim()
}

/** First matching child element's text content. */
function tagText(xml: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i').exec(xml)
    if (match?.[1] !== undefined) {
      const text = clean(match[1])
      if (text) return text
    }
    // Self-closing with the value in an attribute, e.g. <media:content url="…"/>
    const selfClosing = new RegExp(`<${escaped}(?:\\s[^>]*)?/>`, 'i').exec(xml)
    if (selfClosing) {
      const url = /\surl\s*=\s*["']([^"']+)["']/i.exec(selfClosing[0])?.[1]
      if (url) return clean(url)
    }
  }
  return undefined
}

/** Atom `<link rel="alternate" href="…">`, falling back to any href. */
function atomLink(xml: string): string | undefined {
  const links = [...xml.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)].map((m) => m[1] ?? '')
  const attrsOf = (attrs: string) => ({
    rel: /\srel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase(),
    href: /\shref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1],
    type: /\stype\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase(),
  })
  const parsed = links.map(attrsOf).filter((l) => l.href)
  const alternate = parsed.find((l) => l.rel === 'alternate' && (!l.type || l.type.includes('html')))
  const noRel = parsed.find((l) => !l.rel)
  return clean(alternate?.href ?? noRel?.href ?? parsed[0]?.href) || undefined
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** Parse the date formats feeds actually emit. Returns undefined, never NaN. */
export function parseFeedDate(input: string | undefined): number | undefined {
  if (!input) return undefined
  const text = input.trim()
  if (!text) return undefined

  const native = Date.parse(text)
  if (Number.isFinite(native)) return native

  // RFC 822 with a non-standard zone name, e.g. "Tue, 15 Jul 2026 09:00:00 PDT"
  const rfc = /^\w{3},\s*(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (rfc) {
    const month = MONTHS[rfc[2]!.toLowerCase()]
    if (month !== undefined) {
      const ms = Date.UTC(Number(rfc[3]), month, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), Number(rfc[6] ?? 0))
      if (Number.isFinite(ms)) return ms
    }
  }
  return undefined
}

function parseEntry(xml: string, kind: 'rss' | 'atom'): FeedItem | null {
  const title = tagText(xml, 'title') ?? ''
  const link = kind === 'atom' ? (atomLink(xml) ?? tagText(xml, 'id')) : (tagText(xml, 'link', 'guid') ?? atomLink(xml))
  if (!link || !/^https?:/i.test(link)) return null

  const description = tagText(xml, 'description', 'summary', 'subtitle')
  const content = tagText(xml, 'content:encoded', 'content', 'dc:content')
  const author =
    tagText(xml, 'dc:creator', 'author') ??
    // Atom nests: <author><name>…</name></author>
    (() => {
      const block = /<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/i.exec(xml)?.[1]
      return block ? tagText(block, 'name') : undefined
    })()

  const publishedAt =
    parseFeedDate(tagText(xml, 'pubDate', 'published', 'dc:date', 'updated', 'issued')) ?? undefined

  const categories = [...xml.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
    .map((m) => clean(m[1]))
    .filter(Boolean)
  // Atom puts the value in a term attribute.
  for (const m of xml.matchAll(/<category\b[^>]*\sterm\s*=\s*["']([^"']+)["'][^>]*\/?>/gi)) {
    const term = clean(m[1])
    if (term && !categories.includes(term)) categories.push(term)
  }

  const enclosureUrl =
    /<enclosure\b[^>]*\surl\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1] ??
    /<media:content\b[^>]*\surl\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1] ??
    /<media:thumbnail\b[^>]*\surl\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1]

  return {
    title: title || link,
    link,
    description,
    content,
    author,
    publishedAt,
    categories: categories.slice(0, 12),
    enclosureUrl: enclosureUrl ? clean(enclosureUrl) : undefined,
  }
}

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed\b[^>]*xmlns=["'][^"']*\/Atom/i.test(xml) || /<entry\b/i.test(xml)

  // Channel-level metadata: take the document head so an entry's <title> is not
  // mistaken for the feed's.
  const head = xml.slice(0, Math.max(0, xml.search(/<(?:item|entry)\b/i)))
  const feedTitle = tagText(head, 'title') ?? 'Feed'
  const feedLink = isAtom ? atomLink(head) : tagText(head, 'link')

  const entryRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  const items: FeedItem[] = []
  for (const match of xml.matchAll(entryRe)) {
    const entry = parseEntry(match[1] ?? '', isAtom ? 'atom' : 'rss')
    if (entry) items.push(entry)
    if (items.length >= 120) break
  }

  return { title: feedTitle, link: feedLink, items }
}
