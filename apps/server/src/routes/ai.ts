/**
 * AI routes.
 *
 * All generative endpoints stream. A summary that appears token-by-token in 300ms
 * feels instant; the same summary delivered whole after 3 seconds feels broken,
 * even though it arrived sooner in wall-clock terms for the last token.
 *
 * Every endpoint here works without an LLM, returning a deterministic local
 * result, because the product must be complete before the user pastes a key.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { ChatRequest, SearchQuery, excerpt, keywords, type ChatCitation } from '@sift/core'
import { AiNotConfiguredError, aiStatus, complete, isAiConfigured, streamCompletion } from '../ai/provider.ts'
import { CHAT_SYSTEM, SUMMARY_SYSTEM, TAKEAWAYS_SYSTEM, parseTakeaways, renderContext, translateSystem } from '../ai/prompts.ts'
import { generateDigest, getDigest, latestDigest, listDigests } from '../ai/digest.ts'
import { findById, logEvent, setAiFields } from '../repo/items.ts'
import { search } from '../search.ts'
import { log } from '../log.ts'

/** Local extractive fallback: the highest-information sentences, in order. */
function extractiveSummary(text: string, maxSentences = 3): string {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30)
  if (sentences.length <= maxSentences) return sentences.join(' ') || excerpt(text, 300)

  const terms = new Map(keywords(text, 30).map((k) => [k.term, k.weight]))
  const scored = sentences.slice(0, 40).map((sentence, index) => {
    const lower = sentence.toLowerCase()
    let score = 0
    for (const [term, weight] of terms) if (lower.includes(term)) score += weight
    // Lead bias: the first sentences of a news item usually carry the news.
    score *= 1 - index * 0.015
    // Sentences with numbers tend to be the substantive ones.
    if (/\d/.test(sentence)) score *= 1.15
    return { sentence, score, index }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence)
    .join(' ')
}

const itemTextFor = (id: string) => {
  const item = findById(id)
  if (!item) return null
  const text = [item.title, item.summary ?? '', item.content ?? ''].filter(Boolean).join('\n\n')
  return { item, text: text.slice(0, 40_000) }
}

export const aiRoutes = new Hono()
  .get('/status', (c) => c.json(aiStatus()))

  /** Streamed summary. Persists the result so it is generated only once. */
  .post('/summarize', zValidator('json', z.object({ itemId: z.string(), force: z.boolean().default(false) })), async (c) => {
    const { itemId, force } = c.req.valid('json')
    const found = itemTextFor(itemId)
    if (!found) return c.json({ error: 'Item not found' }, 404)

    if (!force && found.item.aiSummary) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'cached', data: found.item.aiSummary! })
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ cached: true }) })
      })
    }

    if (!isAiConfigured()) {
      const summary = extractiveSummary(found.text)
      setAiFields(itemId, { summary })
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'delta', data: summary })
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ generator: 'extractive' }) })
      })
    }

    return streamSSE(c, async (stream) => {
      let full = ''
      try {
        for await (const chunk of streamCompletion({
          system: SUMMARY_SYSTEM,
          messages: [{ role: 'user', content: found.text }],
          maxTokens: 300,
        })) {
          full += chunk
          await stream.writeSSE({ event: 'delta', data: chunk })
        }
        if (full.trim()) setAiFields(itemId, { summary: full.trim() })
        logEvent('ai.summarize', itemId)
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ generator: 'ai' }) })
      } catch (error) {
        // Degrade rather than fail: the user still gets a usable summary.
        const fallback = extractiveSummary(found.text)
        setAiFields(itemId, { summary: fallback })
        await stream.writeSSE({ event: 'delta', data: full ? '' : fallback })
        await stream.writeSSE({ event: 'error', data: (error as Error).message })
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ generator: 'extractive' }) })
      }
    })
  })

  .post(
    '/translate',
    zValidator('json', z.object({ itemId: z.string(), target: z.enum(['en', 'zh']) })),
    async (c) => {
      const { itemId, target } = c.req.valid('json')
      const found = itemTextFor(itemId)
      if (!found) return c.json({ error: 'Item not found' }, 404)
      if (!isAiConfigured()) {
        return c.json({ error: 'Translation needs an AI provider', detail: aiStatus().reason, code: 'ai_not_configured' }, 400)
      }
      return streamSSE(c, async (stream) => {
        let full = ''
        try {
          for await (const chunk of streamCompletion({
            system: translateSystem(target),
            messages: [{ role: 'user', content: found.text.slice(0, 20_000) }],
            maxTokens: 4000,
            temperature: 0.2,
          })) {
            full += chunk
            await stream.writeSSE({ event: 'delta', data: chunk })
          }
          if (full.trim()) setAiFields(itemId, { translation: full.trim() })
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ target }) })
        } catch (error) {
          await stream.writeSSE({ event: 'error', data: (error as Error).message })
        }
      })
    },
  )

  .post('/takeaways', zValidator('json', z.object({ itemId: z.string() })), async (c) => {
    const { itemId } = c.req.valid('json')
    const found = itemTextFor(itemId)
    if (!found) return c.json({ error: 'Item not found' }, 404)
    if (found.item.aiTakeaways?.length) return c.json({ takeaways: found.item.aiTakeaways, cached: true })

    if (!isAiConfigured()) {
      // Local fallback: the top scoring sentences, one per line.
      const takeaways = extractiveSummary(found.text, 4)
        .split(/(?<=[.!?。！？])\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4)
      setAiFields(itemId, { takeaways })
      return c.json({ takeaways, generator: 'extractive' })
    }

    try {
      const text = await complete({
        system: TAKEAWAYS_SYSTEM,
        messages: [{ role: 'user', content: found.text }],
        maxTokens: 500,
      })
      const takeaways = parseTakeaways(text)
      if (takeaways.length) setAiFields(itemId, { takeaways })
      return c.json({ takeaways, generator: 'ai' })
    } catch (error) {
      return c.json({ error: 'Could not extract takeaways', detail: (error as Error).message }, 502)
    }
  })

  /**
   * Ask-your-library. Retrieval is hybrid search over the user's own corpus, and
   * the citations returned are exactly the passages the model was shown — so the
   * user can verify every claim against the source we actually used.
   */
  .post('/chat', zValidator('json', ChatRequest), async (c) => {
    const { messages, scope, topK } = c.req.valid('json')
    const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

    const query = SearchQuery.parse({
      ...(scope ?? {}),
      q: question.slice(0, 500),
      limit: Math.min(topK, 40),
      mode: 'hybrid',
      sort: 'relevance',
      diversify: 0.3,
    })
    const results = await search(query)

    const citations: ChatCitation[] = results.items.map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      source: item.source,
      snippet: (item.aiSummary ?? item.summary ?? item.title).replace(/\s+/g, ' ').slice(0, 700),
      score: item.score,
    }))

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'citations', data: JSON.stringify(citations) })

      if (!citations.length) {
        await stream.writeSSE({
          event: 'delta',
          data: "Nothing in your library matches that question yet. Try capturing a few items on the topic first, or widen the filters — I only answer from what you've actually saved.",
        })
        await stream.writeSSE({ event: 'done', data: '{}' })
        return
      }

      if (!isAiConfigured()) {
        // Without a model, return the retrieval result as a readable answer.
        const lines = citations
          .slice(0, 6)
          .map((cite, index) => `[${index + 1}] **${cite.title}** — ${cite.snippet.slice(0, 200)}`)
          .join('\n\n')
        await stream.writeSSE({
          event: 'delta',
          data: `I found ${citations.length} relevant item${citations.length === 1 ? '' : 's'} in your library. Add an AI provider in Settings for a written answer; for now, here is what matched:\n\n${lines}`,
        })
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ generator: 'retrieval' }) })
        return
      }

      const context = renderContext(
        citations.map((cite) => ({
          title: cite.title,
          source: cite.source,
          url: cite.url,
          text: cite.snippet,
        })),
      )
      const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }))
      const last = history[history.length - 1]
      if (last) last.content = `${last.content}\n\n--- Excerpts from my library ---\n${context}`

      try {
        for await (const chunk of streamCompletion({ system: CHAT_SYSTEM, messages: history, maxTokens: 1500, temperature: 0.3 })) {
          await stream.writeSSE({ event: 'delta', data: chunk })
        }
        logEvent('ai.chat', undefined, { question: question.slice(0, 200), cited: citations.length })
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ generator: 'ai' }) })
      } catch (error) {
        const message = error instanceof AiNotConfiguredError ? error.message : (error as Error).message
        log.warn(`Chat failed: ${message}`)
        await stream.writeSSE({ event: 'error', data: message })
        await stream.writeSSE({ event: 'done', data: '{}' })
      }
    })
  })

  /** Synthesise a brief from an explicit multi-selection. */
  .post(
    '/synthesize',
    zValidator('json', z.object({ itemIds: z.array(z.string()).min(1).max(40), instruction: z.string().max(500).optional() })),
    async (c) => {
      const { itemIds, instruction } = c.req.valid('json')
      const items = itemIds.map((id) => findById(id)).filter((i): i is NonNullable<typeof i> => Boolean(i))
      if (!items.length) return c.json({ error: 'No matching items' }, 404)

      const context = renderContext(
        items.map((item) => ({
          title: item.title,
          source: item.source,
          url: item.url,
          publishedAt: item.publishedAt,
          text: item.aiSummary ?? item.summary ?? item.content?.slice(0, 1500) ?? '',
        })),
      )

      if (!isAiConfigured()) {
        const brief = items
          .map((item, index) => `${index + 1}. **${item.title}** — ${(item.aiSummary ?? item.summary ?? '').slice(0, 220)}`)
          .join('\n')
        return c.json({ brief: `## Selected items\n\n${brief}`, generator: 'template' })
      }

      return streamSSE(c, async (stream) => {
        try {
          for await (const chunk of streamCompletion({
            system: `You synthesise several sources into one tight brief for an expert reader.
Cite with bracketed numbers matching the supplied items. State disagreements between sources explicitly.
Never introduce a fact that is not in the excerpts. No hype adjectives. Markdown, with "## " headings.`,
            messages: [{ role: 'user', content: `${instruction ?? 'Synthesise these into one brief.'}\n\n${context}` }],
            maxTokens: 1800,
            temperature: 0.4,
          })) {
            await stream.writeSSE({ event: 'delta', data: chunk })
          }
          await stream.writeSSE({ event: 'done', data: '{}' })
        } catch (error) {
          await stream.writeSSE({ event: 'error', data: (error as Error).message })
        }
      })
    },
  )

export const digestRoutes = new Hono()
  .get('/', (c) => c.json({ digests: listDigests(Math.min(50, Number(c.req.query('limit') ?? 20) || 20)) }))
  .get('/latest', (c) => {
    const digest = latestDigest()
    return digest ? c.json({ digest }) : c.json({ digest: null })
  })
  .get('/:id', (c) => {
    const digest = getDigest(c.req.param('id'))
    return digest ? c.json({ digest }) : c.json({ error: 'Digest not found' }, 404)
  })
  .post(
    '/',
    zValidator(
      'json',
      z
        .object({
          hours: z.number().int().min(1).max(720).default(24),
          maxItems: z.number().int().min(3).max(50).default(12),
          template: z.boolean().default(false),
        })
        .optional(),
    ),
    async (c) => {
      const body = c.req.valid('json') ?? { hours: 24, maxItems: 12, template: false }
      const digest = await generateDigest(body)
      return c.json({ digest }, 201)
    },
  )
