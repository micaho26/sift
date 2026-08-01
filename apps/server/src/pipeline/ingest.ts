/**
 * The ingestion pipeline — every item in Sift enters through here.
 *
 * Order matters and is not arbitrary:
 *   canonicalise → filter → enrich → fingerprint → dedup → embed → score → store
 *
 * Dedup runs *before* embedding and scoring because both cost real time, and
 * there is no point spending either on the fortieth copy of a story. Scoring runs
 * last because it needs the novelty measurement that only exists once the item's
 * vector can be compared against the corpus.
 */
import {
  IngestItem,
  authorAffinity,
  canonicalizeUrl,
  cosineSimilarity,
  classifyTopics,
  computeScore,
  detectLang,
  excerpt,
  extractEntities,
  htmlToText,
  readingTimeSec,
  simhash,
  type Entity,
  type IngestResult,
  type ItemState,
  type Settings,
} from '@sift/core'
import { emitNewItems, emitUpdated } from '../events.ts'
import { getEmbedder } from '../embed.ts'
import { getVectorIndex, saveVector, vectorIndexReady } from '../db/vector.ts'
import { log } from '../log.ts'
import {
  authorStats,
  echoCandidates,
  findNearDuplicate,
  logEvent,
  sha256,
  touchAuthor,
  upsertItem,
  type UpsertInput,
} from '../repo/items.ts'
import { getInterestProfile } from './interests.ts'
import { readSettings } from '../repo/settings.ts'
import { sourceTrustFor } from '../repo/sources.ts'

export type IngestOptions = {
  /** Label for provenance, e.g. "x:home-timeline" or "connector:hackernews". */
  collector?: string
  /** Skip the inbox threshold — used by manual saves, which are always wanted. */
  force?: boolean
  /** Settings snapshot, so a 500-item batch reads them once. */
  settings?: Settings
}

/** Reject obviously worthless captures before they cost us anything. */
function preFilter(item: IngestItem, settings: Settings): string | null {
  const text = `${item.title}\n${item.summary ?? ''}\n${item.content ?? ''}`.trim()
  if (!item.url || item.url.length < 4) return 'missing url'
  if (!text) return 'no text content'
  if (text.length < 12 && !item.media?.length) return 'too short to be useful'

  const haystack = text.toLowerCase()
  for (const muted of settings.mutedKeywords) {
    const needle = muted.trim().toLowerCase()
    if (needle.length >= 2 && haystack.includes(needle)) return `muted keyword "${muted}"`
  }
  const handle = item.author?.handle?.toLowerCase()
  if (handle) {
    for (const muted of settings.mutedAuthors) {
      if (muted.trim().toLowerCase().replace(/^@/, '') === handle.replace(/^@/, '')) return `muted author "${muted}"`
    }
  }
  return null
}

/** Normalise text: HTML in, Markdown-ish plain text out. */
function normaliseText(input: string | undefined): string | undefined {
  if (!input) return undefined
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(input)
  const text = looksLikeHtml ? htmlToText(input) : input
  const trimmed = text.trim()
  return trimmed ? trimmed.slice(0, 200_000) : undefined
}

export async function ingest(items: IngestItem[], options: IngestOptions = {}): Promise<IngestResult> {
  const settings = options.settings ?? readSettings()
  const profile = getInterestProfile()
  const embedder = getEmbedder()
  const now = Date.now()

  const result: IngestResult = {
    received: items.length,
    created: 0,
    updated: 0,
    duplicates: 0,
    rejected: 0,
    ids: [],
    errors: [],
  }

  const createdIds: string[] = []
  let topScore = 0

  for (const raw of items) {
    try {
      const parsed = IngestItem.safeParse(raw)
      if (!parsed.success) {
        result.rejected++
        result.errors.push({ url: String(raw?.url ?? '?'), reason: parsed.error.issues[0]?.message ?? 'invalid shape' })
        continue
      }
      const item = parsed.data

      const reject = preFilter(item, settings)
      if (reject) {
        result.rejected++
        result.errors.push({ url: item.url, reason: reject })
        continue
      }

      // --- canonicalise ------------------------------------------------- //
      const canonical = canonicalizeUrl(item.url)
      const url = canonical.url || item.url
      const urlHash = sha256(url)
      const sourceId = item.sourceId ?? canonical.sourceId

      // --- enrich ------------------------------------------------------- //
      const content = normaliseText(item.content)
      const title = (item.title || excerpt(content ?? '', 120) || url).slice(0, 1000)
      const summary = normaliseText(item.summary) ?? (content && content.length > 260 ? excerpt(content, 260) : undefined)
      const text = `${title}\n${summary ?? ''}\n${content ?? ''}`
      const lang = item.lang ?? detectLang(text)
      const topics = item.topics?.length ? item.topics : classifyTopics({ title, summary, content })
      const entities: Entity[] = extractEntities(text)
      const reading = readingTimeSec(content ?? summary ?? title)

      // --- fingerprint & dedup ------------------------------------------- //
      //
      // Two tiers, because they catch genuinely different things:
      //
      //   Tier 1 — SimHash. Catches a verbatim repost: same words, maybe a
      //   trimmed sentence. Cheap, exact, and safe at a tight threshold.
      //
      //   Tier 2 — embedding similarity. Catches the case that actually floods an
      //   AI feed: twenty accounts reporting one launch in their own words.
      //   SimHash cannot do this — measured on our own corpus, a real repost sits
      //   at Hamming 22 while unrelated items sit at 27-31, which is far too
      //   narrow a margin to threshold safely. Cosine separates the same pair
      //   0.60 vs 0.29.
      //
      // Tier 2 is additionally gated on a shared named entity and a 72-hour
      // window (see `echoCandidates`), so topical resemblance alone never folds
      // two distinct stories together.
      const fingerprint = simhash(`${title}\n${(content ?? summary ?? '').slice(0, 4000)}`)
      let duplicateOf = findNearDuplicate(fingerprint)?.id

      // --- embed -------------------------------------------------------- //
      // Embedding happens before Tier 2 (which needs the vector) but the result
      // is reused for storage and scoring, so nothing is computed twice.
      let vector: Float32Array | null = null
      try {
        vector = await embedder.embedItem({ title, summary, content, topics, author: item.author })
      } catch (error) {
        log.debug(`Embedding failed for ${url}: ${(error as Error).message}`)
      }

      if (!duplicateOf && vector && vectorIndexReady()) {
        const index = getVectorIndex()
        const candidates = echoCandidates(entities, item.publishedAt)
        let best: { id: string; score: number } | null = null
        for (const candidateId of candidates) {
          const candidateVector = index.get(candidateId)
          if (!candidateVector) continue
          const similarity = cosineSimilarity(vector, candidateVector)
          if (similarity >= embedder.echoThreshold && (!best || similarity > best.score)) {
            best = { id: candidateId, score: similarity }
          }
        }
        if (best) {
          duplicateOf = best.id
          log.debug(`Echo of ${best.id} (cosine ${best.score.toFixed(3)}): ${title.slice(0, 60)}`)
        }
      }

      if (duplicateOf) {
        // Still stored, still searchable, still reachable from the canonical item
        // via its echo count — folded out of the feed, never deleted.
        const outcome = upsertItem(
          buildUpsert({
            url,
            urlHash,
            item,
            sourceId,
            title,
            summary,
            content,
            lang,
            topics,
            entities,
            reading,
            fingerprint,
            duplicateOf,
            score: 0,
            state: 'archived',
          }),
        )
        result.duplicates++
        if (outcome.created) result.ids.push(outcome.id)
        continue
      }

      const maxSimilarity = vector && vectorIndexReady() ? getVectorIndex().maxSimilarity(vector) : 0

      // --- score -------------------------------------------------------- //
      const stats = authorStats(item.author?.handle)
      const followers = item.author?.followers ?? stats.followers
      const scored = computeScore({
        source: item.source,
        kind: item.kind,
        title,
        summary,
        content,
        metrics: item.metrics,
        publishedAt: item.publishedAt,
        entityCount: entities.length,
        mediaCount: item.media?.length ?? 0,
        followers,
        authorAffinity: authorAffinity(stats.saved, stats.seen),
        verified: item.author?.verified,
        vector,
        interestVectors: profile.vectors,
        interestKeywords: profile.keywords,
        maxSimilarityToCorpus: maxSimilarity,
        sourceTrust: sourceTrustFor(item.source),
        weights: settings.weights,
        halfLifeHours: settings.recencyHalfLifeHours,
        now,
      })

      // Low-signal items are archived on arrival: present in search, absent from
      // the inbox. Manual captures bypass this entirely.
      const state: ItemState =
        item.state ??
        (options.force || item.source === 'manual' || scored.score >= settings.inboxThreshold ? 'inbox' : 'archived')

      const outcome = upsertItem(
        buildUpsert({
          url,
          urlHash,
          item,
          sourceId,
          title,
          summary,
          content,
          lang,
          topics,
          entities,
          reading,
          fingerprint,
          score: scored.score,
          breakdown: scored.breakdown,
          state,
        }),
      )

      if (vector) saveVector(outcome.id, vector, embedder.model)
      touchAuthor(item.author?.handle, item.author?.name, item.source, followers)

      if (outcome.created) {
        result.created++
        createdIds.push(outcome.id)
        if (state === 'inbox') topScore = Math.max(topScore, scored.score)
      } else {
        result.updated++
      }
      result.ids.push(outcome.id)
    } catch (error) {
      result.rejected++
      result.errors.push({ url: String(raw?.url ?? '?'), reason: (error as Error).message })
      log.debug(`Ingest error: ${(error as Error).message}`)
    }
  }

  if (createdIds.length) {
    emitNewItems(createdIds, topScore)
    logEvent('ingest', undefined, {
      collector: options.collector,
      created: result.created,
      duplicates: result.duplicates,
      rejected: result.rejected,
    })
  } else if (result.updated) {
    emitUpdated(result.ids.slice(0, 100))
  }

  return result
}

/** Assemble the persistence payload — kept separate to keep `ingest` readable. */
function buildUpsert(args: {
  url: string
  urlHash: string
  item: IngestItem
  sourceId?: string
  title: string
  summary?: string
  content?: string
  lang: string
  topics: string[]
  entities: Entity[]
  reading: number
  fingerprint: string
  duplicateOf?: string
  score: number
  breakdown?: UpsertInput['scoreBreakdown']
  state: ItemState
}): UpsertInput {
  return {
    url: args.url,
    urlHash: args.urlHash,
    source: args.item.source,
    sourceId: args.sourceId,
    kind: args.item.kind,
    title: args.title,
    summary: args.summary,
    content: args.content,
    lang: args.lang,
    author: args.item.author,
    metrics: args.item.metrics ?? {},
    media: args.item.media ?? [],
    topics: args.topics,
    tags: args.item.tags ?? [],
    entities: args.entities,
    publishedAt: args.item.publishedAt,
    score: args.score,
    scoreBreakdown: args.breakdown,
    state: args.state,
    readingTimeSec: args.reading,
    simhash: args.fingerprint,
    duplicateOf: args.duplicateOf,
    raw: args.item.raw,
  }
}
