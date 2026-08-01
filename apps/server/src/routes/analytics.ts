/**
 * Analytics and export routes.
 *
 * Export exists for a specific reason: a local-first tool that cannot hand your
 * data back is just a silo on your own disk. Markdown, JSON, CSV and OPML all
 * round-trip the parts that matter.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { SearchQuery, displayUrl, formatDateTime, timeAgo, topicLabel } from '@sift/core'
import { activityHeatmap, analytics, dailyActivity } from '../analytics/index.ts'
import { findManyByIds } from '../repo/items.ts'
import { listHighlights } from '../repo/library.ts'
import { listSources } from '../repo/sources.ts'
import { search } from '../search.ts'
import { getDigest, latestDigest } from '../ai/digest.ts'
import { shareCardSvg, digestCardSvg } from '../share/card.ts'

export const analyticsRoutes = new Hono()
  .get('/', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30))
    const to = Date.now()
    const from = to - days * 86_400_000
    const buckets = days <= 2 ? 24 : days <= 14 ? days * 2 : Math.min(60, days)
    return c.json({
      ...analytics({ from, to, buckets }),
      heatmap: activityHeatmap(from, to),
      daily: dailyActivity(Math.min(days, 90)),
    })
  })

/* -------------------------------------------------------------- exporters -- */

function itemToMarkdown(item: ReturnType<typeof findManyByIds>[number], highlights: { text: string; note?: string }[]): string {
  const lines: string[] = []
  lines.push(`## ${item.title}`)
  lines.push('')
  const meta = [
    item.author?.handle ? `@${item.author.handle}` : item.author?.name,
    item.source,
    item.publishedAt ? formatDateTime(item.publishedAt) : undefined,
    `signal ${item.score}`,
  ].filter(Boolean)
  lines.push(`*${meta.join(' · ')}*`)
  lines.push('')
  lines.push(`<${item.url}>`)
  if (item.topics.length) {
    lines.push('')
    lines.push(item.topics.map((t) => `\`${topicLabel(t)}\``).join(' '))
  }
  if (item.tags.length) {
    lines.push('')
    lines.push(item.tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' '))
  }
  const body = item.aiSummary ?? item.summary
  if (body) {
    lines.push('')
    lines.push(body)
  }
  if (item.aiTakeaways?.length) {
    lines.push('')
    lines.push('**Takeaways**')
    lines.push('')
    for (const takeaway of item.aiTakeaways) lines.push(`- ${takeaway}`)
  }
  if (highlights.length) {
    lines.push('')
    lines.push('**Highlights**')
    lines.push('')
    for (const highlight of highlights) {
      lines.push(`> ${highlight.text.replace(/\n/g, '\n> ')}`)
      if (highlight.note) lines.push(`>`, `> — ${highlight.note}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const exportRoutes = new Hono()
  /** Export an explicit selection, or the result of a query. */
  .post(
    '/',
    zValidator(
      'json',
      z.object({
        format: z.enum(['markdown', 'json', 'csv']),
        itemIds: z.array(z.string()).max(2000).optional(),
        query: SearchQuery.optional(),
        includeHighlights: z.boolean().default(true),
        title: z.string().max(200).optional(),
      }),
    ),
    async (c) => {
      const { format, itemIds, query, includeHighlights, title } = c.req.valid('json')

      const items = itemIds?.length
        ? findManyByIds(itemIds)
        : (await search(SearchQuery.parse({ ...(query ?? {}), limit: 200 }))).items
      if (!items.length) return c.json({ error: 'Nothing to export' }, 400)

      const highlightsByItem = new Map<string, { text: string; note?: string }[]>()
      if (includeHighlights) {
        for (const item of items) {
          const highlights = listHighlights(item.id)
          if (highlights.length) highlightsByItem.set(item.id, highlights)
        }
      }

      const stamp = new Date().toISOString().slice(0, 10)

      if (format === 'json') {
        return c.json(
          {
            exportedAt: Date.now(),
            generator: 'Sift 0.1.0',
            count: items.length,
            items: items.map((item) => ({ ...item, highlights: highlightsByItem.get(item.id) ?? [] })),
          },
          200,
          { 'content-disposition': `attachment; filename="sift-${stamp}.json"` },
        )
      }

      if (format === 'csv') {
        const header = ['title', 'url', 'source', 'author', 'score', 'published', 'topics', 'tags', 'state', 'summary']
        const rows = items.map((item) =>
          [
            item.title,
            item.url,
            item.source,
            item.author?.handle ?? item.author?.name ?? '',
            item.score,
            item.publishedAt ? new Date(item.publishedAt).toISOString() : '',
            item.topics.join('|'),
            item.tags.join('|'),
            item.state,
            (item.aiSummary ?? item.summary ?? '').replace(/\s+/g, ' ').slice(0, 500),
          ]
            .map(csvEscape)
            .join(','),
        )
        // BOM so Excel opens UTF-8 Chinese correctly rather than as mojibake.
        return c.body(`﻿${[header.join(','), ...rows].join('\n')}`, 200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="sift-${stamp}.csv"`,
        })
      }

      const heading = title ?? `Sift export · ${stamp}`
      const markdown = [
        `# ${heading}`,
        '',
        `*${items.length} item${items.length === 1 ? '' : 's'} · exported ${formatDateTime(Date.now())}*`,
        '',
        '---',
        '',
        ...items.map((item) => itemToMarkdown(item, highlightsByItem.get(item.id) ?? [])),
      ].join('\n\n')

      return c.body(markdown, 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="sift-${stamp}.md"`,
      })
    },
  )

  /** OPML of every RSS source, so feeds can be moved to another reader. */
  .get('/opml', (c) => {
    const feeds = listSources().filter((s) => s.kind === 'rss')
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const body = feeds
      .map((f) => `      <outline type="rss" text="${escape(f.name)}" title="${escape(f.name)}" xmlUrl="${escape(f.target)}"/>`)
      .join('\n')
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Sift feeds</title></head>
  <body>
    <outline text="Sift">
${body}
    </outline>
  </body>
</opml>`
    return c.body(opml, 200, {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="sift-feeds.opml"',
    })
  })

  /**
   * Share card as SVG. Rendered server-side with no headless browser and no
   * canvas dependency; the web app rasterises it to PNG in-page when the user
   * wants a bitmap.
   */
  .get('/card/:id', (c) => {
    const [item] = findManyByIds([c.req.param('id')])
    if (!item) return c.json({ error: 'Item not found' }, 404)
    const theme = c.req.query('theme') === 'light' ? 'light' : 'dark'
    return c.body(shareCardSvg(item, { theme, footer: displayUrl(item.url, 44), age: timeAgo(item.publishedAt ?? item.capturedAt) }), 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
    })
  })

  .get('/digest-card/:id', (c) => {
    const id = c.req.param('id')
    const digest = id === 'latest' ? latestDigest() : getDigest(id)
    if (!digest) return c.json({ error: 'Digest not found' }, 404)
    const items = findManyByIds(digest.itemIds.slice(0, 5))
    const theme = c.req.query('theme') === 'light' ? 'light' : 'dark'
    return c.body(digestCardSvg(digest, items, { theme }), 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
    })
  })
