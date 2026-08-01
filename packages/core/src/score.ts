/**
 * The signal score — Sift's core opinion.
 *
 * A number from 0-100 that answers "should this interrupt me?". Six components,
 * each normalised to 0..1, combined by user-tunable weights, then multiplied by
 * a per-source trust factor and reduced by an engagement-bait demerit.
 *
 * Two design rules:
 *  - Every component is retained in the breakdown. If we cannot explain a 92,
 *    the user cannot trust a 92, and an unexplainable ranking is just a vibe.
 *  - No component may be gamed into dominance. Each is squashed (log or
 *    exponential) so a viral post cannot outrank a substantive one on reach
 *    alone — which is precisely the failure mode of every social timeline.
 */
import type { Item, Metrics, ScoreBreakdown, ScoringWeights, SourceKind } from './types.js'
import { cosineSimilarity } from './simhash.js'
import { keywords, noiseScore, tokenize } from './text.js'

export const DEFAULT_WEIGHTS: Required<ScoringWeights> = {
  velocity: 0.22,
  authority: 0.13,
  relevance: 0.26,
  novelty: 0.14,
  depth: 0.15,
  recency: 0.1,
}

/**
 * How each platform's counters convert to comparable "attention units", and the
 * p95 attention-per-hour we normalise against. The reference values come from
 * the shape of each platform's distribution — an HN story at 30 points/hr is
 * front-page material; a tweet needs ~1200 attention units/hr to be equivalent.
 */
type SourceProfile = {
  weights: Partial<Record<keyof Metrics, number>>
  /** p95 of attention-per-hour, used as the log-scale ceiling. */
  p95PerHour: number
  /** Baseline trust before the user adjusts it. */
  trust: number
}

const SOURCE_PROFILES: Record<SourceKind, SourceProfile> = {
  x: {
    // A bookmark is the strongest "I will come back to this" signal on X, and
    // the hardest to farm; views are abundant so they are worth almost nothing.
    weights: { likes: 1, reposts: 2.5, replies: 1.2, quotes: 2, bookmarks: 4, views: 0.004 },
    p95PerHour: 1200,
    trust: 1,
  },
  xiaohongshu: {
    weights: { likes: 1, collects: 3.5, comments: 2, reposts: 2.5, views: 0.003 },
    p95PerHour: 900,
    trust: 0.95,
  },
  hackernews: {
    weights: { points: 1, comments: 0.8 },
    p95PerHour: 30,
    trust: 1.1,
  },
  arxiv: {
    // Papers accrue attention over months; velocity is a weak signal here, so
    // the ceiling is low and `depth` carries the weight instead.
    weights: { citations: 4, likes: 1, comments: 1 },
    p95PerHour: 3,
    trust: 1.05,
  },
  github: {
    weights: { stars: 1, forks: 2 },
    p95PerHour: 40,
    trust: 1.05,
  },
  reddit: {
    weights: { points: 1, comments: 1 },
    p95PerHour: 120,
    trust: 0.9,
  },
  youtube: {
    weights: { likes: 1, comments: 1.5, views: 0.005 },
    p95PerHour: 400,
    trust: 0.85,
  },
  producthunt: {
    weights: { points: 1, comments: 1.5 },
    p95PerHour: 40,
    trust: 0.85,
  },
  huggingface: {
    weights: { likes: 2, downloads: 0.02 },
    p95PerHour: 60,
    trust: 1,
  },
  rss: {
    weights: { points: 1, comments: 1 },
    p95PerHour: 10,
    trust: 1,
  },
  web: { weights: {}, p95PerHour: 10, trust: 1 },
  // Anything the user captured by hand is, by definition, wanted.
  manual: { weights: {}, p95PerHour: 10, trust: 1.2 },
}

export function sourceProfile(source: SourceKind): SourceProfile {
  return SOURCE_PROFILES[source] ?? SOURCE_PROFILES.web
}

export function defaultSourceTrust(source: SourceKind): number {
  return sourceProfile(source).trust
}

/** Total attention in comparable units for one item. */
export function attentionUnits(source: SourceKind, metrics: Metrics | undefined): number {
  if (!metrics) return 0
  const { weights } = sourceProfile(source)
  let total = 0
  for (const [key, weight] of Object.entries(weights)) {
    const value = metrics[key as keyof Metrics]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value * (weight ?? 0)
  }
  return total
}

const HOUR = 3_600_000

/**
 * Attention per hour, damped by a gravity term so a two-hour-old post with 50
 * likes does not beat a two-day-old post with 5,000. `+2` in the denominator is
 * HN's trick for stopping brand-new items dividing by ~0.
 */
export function velocityComponent(
  source: SourceKind,
  metrics: Metrics | undefined,
  publishedAt: number | undefined,
  now: number,
): number {
  const units = attentionUnits(source, metrics)
  if (units <= 0) return 0
  const ageHours = Math.max(0, (now - (publishedAt ?? now)) / HOUR)
  const perHour = units / Math.pow(ageHours + 2, 0.8)
  const ceiling = sourceProfile(source).p95PerHour
  // log1p keeps the top of the range from being owned by one mega-viral post.
  return clamp01(Math.log1p(perHour) / Math.log1p(ceiling))
}

/**
 * Reach, blended with revealed preference. `affinity` is how often the user
 * keeps this author's items (0..1) — it is weighted heavily because it is the
 * only part of authority that is impossible to buy.
 */
export function authorityComponent(followers: number | undefined, affinity = 0, verified = false): number {
  const reach = followers && followers > 0 ? Math.log1p(followers) / Math.log1p(2_000_000) : 0
  const base = 0.55 * clamp01(reach) + 0.45 * clamp01(affinity)
  return clamp01(base + (verified ? 0.02 : 0))
}

/**
 * Semantic closeness to what the user cares about, plus explicit keyword hits.
 * Falls back to a neutral 0.5 when no interest profile exists yet, so a fresh
 * install does not rank everything at zero.
 */
export function relevanceComponent(
  itemVector: Float32Array | null,
  interestVectors: Float32Array[],
  text: string,
  interestKeywords: string[],
): number {
  let semantic = -1
  if (itemVector && interestVectors.length) {
    for (const iv of interestVectors) {
      const sim = cosineSimilarity(itemVector, iv)
      if (sim > semantic) semantic = sim
    }
    // Cosine on normalised text embeddings lives roughly in 0.0-0.8; rescale so
    // the usable band spans the full 0..1 range.
    semantic = clamp01((semantic - 0.05) / 0.6)
  }

  let keyword = 0
  if (interestKeywords.length) {
    const haystack = text.toLowerCase()
    let hits = 0
    for (const kw of interestKeywords) {
      const k = kw.trim().toLowerCase()
      if (k.length >= 2 && haystack.includes(k)) hits++
    }
    keyword = clamp01(hits / Math.min(4, interestKeywords.length))
  }

  if (semantic < 0 && keyword === 0) return 0.5 // no profile yet — stay neutral
  if (semantic < 0) return clamp01(0.35 + 0.65 * keyword)
  return clamp01(0.7 * semantic + 0.3 * keyword)
}

/**
 * 1 - (similarity to the most similar thing already in the corpus). This is what
 * stops the fortieth "OpenAI ships X" post from reaching the inbox, while still
 * letting a genuinely new angle through.
 */
export function noveltyComponent(maxSimilarityToCorpus: number, echoCount = 0): number {
  const distinct = clamp01(1 - clamp01(maxSimilarityToCorpus))
  // Being echoed is mild evidence of importance, so blunt the penalty a little.
  const echoRelief = echoCount > 0 ? Math.min(0.15, Math.log1p(echoCount) * 0.06) : 0
  return clamp01(distinct + echoRelief)
}

const SUBSTANCE_MARKERS: { re: RegExp; weight: number }[] = [
  { re: /```|\n\s{4}\S|`[^`]{6,}`/, weight: 0.14 }, // code
  { re: /\barxiv\.org\/abs\/|\bdoi\.org\/|\[\d+\]\s/i, weight: 0.13 }, // citations
  { re: /\bgithub\.com\/[\w.-]+\/[\w.-]+/i, weight: 0.09 }, // an actual artefact
  { re: /\b\d+(?:\.\d+)?\s*(?:%|x\b|tok\/s|tokens\/s|ms\b|GB\b|B params|M params|FLOPs)/i, weight: 0.12 },
  { re: /\b(?:we (?:trained|measured|evaluated|found|built)|benchmark(?:ed)?|ablation|methodology|reproduc)/i, weight: 0.11 },
  { re: /\b(?:however|whereas|trade-?off|caveat|limitation|counterintuitive|nuance)/i, weight: 0.08 },
  { re: /(?:实测|复现|对比实验|消融|参数量|吞吐|延迟|开源地址)/, weight: 0.11 },
]

/**
 * Substance heuristics. Length matters, but only as a floor — a 4,000-word SEO
 * page is not deep. What actually correlates with value: numbers, code,
 * citations, artefacts, and hedged language (a sign of real measurement).
 */
export function depthComponent(input: {
  title?: string
  content?: string
  summary?: string
  kind?: string
  mediaCount?: number
  entityCount?: number
}): number {
  const text = `${input.title ?? ''}\n${input.summary ?? ''}\n${input.content ?? ''}`
  const tokenCount = tokenize(text, { keepStopwords: true }).length
  if (tokenCount === 0) return 0

  // Saturating length curve: 0 at nothing, ~0.5 at 120 tokens, ~0.85 at 600.
  let score = clamp01(Math.log1p(tokenCount) / Math.log1p(900)) * 0.4

  for (const marker of SUBSTANCE_MARKERS) if (marker.re.test(text)) score += marker.weight

  // Papers and repos are structurally substantive; short social posts are not.
  if (input.kind === 'paper' || input.kind === 'repo') score += 0.12
  if (input.kind === 'article' || input.kind === 'thread') score += 0.06
  if ((input.entityCount ?? 0) >= 3) score += 0.05
  // Lexical variety separates an essay from a keyword-stuffed listicle.
  const unique = new Set(tokenize(text)).size
  if (tokenCount > 40) score += clamp01(unique / tokenCount - 0.35) * 0.25

  return clamp01(score)
}

/** Exponential decay. `halfLifeHours` 36 => a day-old item retains ~0.63. */
export function recencyComponent(publishedAt: number | undefined, now: number, halfLifeHours = 36): number {
  if (!publishedAt) return 0.5
  const ageHours = Math.max(0, (now - publishedAt) / HOUR)
  // Nothing in the future scores above 1, and clock skew cannot inflate a score.
  return clamp01(Math.pow(0.5, ageHours / Math.max(1, halfLifeHours)))
}

export type ScoreInput = {
  source: SourceKind
  kind?: string
  title?: string
  summary?: string
  content?: string
  metrics?: Metrics
  publishedAt?: number
  entityCount?: number
  mediaCount?: number
  /** Author reach + revealed preference. */
  followers?: number
  authorAffinity?: number
  verified?: boolean
  /** Semantic inputs; pass nulls to fall back to keyword-only relevance. */
  vector?: Float32Array | null
  interestVectors?: Float32Array[]
  interestKeywords?: string[]
  /** Highest cosine against anything already stored. 0 when the corpus is empty. */
  maxSimilarityToCorpus?: number
  echoCount?: number
  sourceTrust?: number
  weights?: Partial<ScoringWeights>
  halfLifeHours?: number
  now?: number
}

export type ScoreResult = {
  score: number
  breakdown: ScoreBreakdown
  /** Ordered, human-readable reasons — rendered directly in the "why?" popover. */
  reasons: string[]
}

/**
 * Compute the signal score. Pure and synchronous: given identical inputs it
 * always returns the same number, which is what makes re-scoring the corpus
 * after a weight change cheap and predictable.
 */
export function computeScore(input: ScoreInput): ScoreResult {
  const now = input.now ?? Date.now()
  const weights: Required<ScoringWeights> = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) }
  const text = `${input.title ?? ''}\n${input.summary ?? ''}\n${input.content ?? ''}`

  const velocity = velocityComponent(input.source, input.metrics, input.publishedAt, now)
  const authority = authorityComponent(input.followers, input.authorAffinity ?? 0, input.verified ?? false)
  const relevance = relevanceComponent(
    input.vector ?? null,
    input.interestVectors ?? [],
    text,
    input.interestKeywords ?? [],
  )
  const novelty = noveltyComponent(input.maxSimilarityToCorpus ?? 0, input.echoCount ?? 0)
  const depth = depthComponent({
    title: input.title,
    summary: input.summary,
    content: input.content,
    kind: input.kind,
    entityCount: input.entityCount,
    mediaCount: input.mediaCount,
  })
  const recency = recencyComponent(input.publishedAt, now, input.halfLifeHours ?? 36)
  const noise = noiseScore(text)

  const weightSum =
    weights.velocity + weights.authority + weights.relevance + weights.novelty + weights.depth + weights.recency
  const norm = weightSum > 0 ? weightSum : 1

  const weighted =
    (velocity * weights.velocity +
      authority * weights.authority +
      relevance * weights.relevance +
      novelty * weights.novelty +
      depth * weights.depth +
      recency * weights.recency) /
    norm

  const trust = input.sourceTrust ?? defaultSourceTrust(input.source)
  // Noise is capped at a 30-point haircut: bait wrapped around real news is
  // still real news.
  const afterNoise = weighted * (1 - Math.min(0.3, noise.score * 0.4))
  const score = Math.round(clamp01(afterNoise * trust) * 100)

  const breakdown: ScoreBreakdown = {
    velocity,
    authority,
    relevance,
    novelty,
    depth,
    recency,
    noise: noise.score,
    sourceTrust: trust,
    weights: { ...weights },
  }

  return { score, breakdown, reasons: explainScore(breakdown, noise.reasons) }
}

const COMPONENT_LABELS: Record<string, string> = {
  velocity: 'spreading fast',
  authority: 'trusted author',
  relevance: 'matches your interests',
  novelty: 'not seen before',
  depth: 'substantive',
  recency: 'fresh',
}

/**
 * Turn a breakdown into ranked prose. Only mentions components that actually
 * moved the number — a list of six lukewarm reasons explains nothing.
 */
export function explainScore(breakdown: ScoreBreakdown, noiseReasons: string[] = []): string[] {
  const contributions = (['relevance', 'velocity', 'depth', 'novelty', 'authority', 'recency'] as const).map(
    (key) => ({
      key,
      value: breakdown[key],
      weight: breakdown.weights[key] ?? 0,
      contribution: breakdown[key] * (breakdown.weights[key] ?? 0),
    }),
  )
  contributions.sort((a, b) => b.contribution - a.contribution)

  const reasons: string[] = []
  for (const c of contributions.slice(0, 3)) {
    if (c.value < 0.45) continue
    const strength = c.value >= 0.8 ? 'Strongly' : c.value >= 0.62 ? 'Clearly' : 'Somewhat'
    reasons.push(`${strength} ${COMPONENT_LABELS[c.key]} (${Math.round(c.value * 100)})`)
  }

  const weakest = [...contributions].sort((a, b) => a.value - b.value)[0]
  if (weakest && weakest.value < 0.25 && weakest.weight > 0.1) {
    reasons.push(`Held back by low ${weakest.key} (${Math.round(weakest.value * 100)})`)
  }
  if (breakdown.noise > 0.15) reasons.push(`Penalised for ${noiseReasons.join(', ') || 'engagement bait'}`)
  if (breakdown.sourceTrust > 1.02) reasons.push('Boosted: you trust this source')
  if (breakdown.sourceTrust < 0.98) reasons.push('Reduced: you down-weighted this source')
  if (!reasons.length) reasons.push('No component stood out — middling on every axis')
  return reasons
}

/**
 * Build the user's interest keyword list: explicit interests plus terms mined
 * from what they have actually saved. Revealed preference beats stated
 * preference, so mined terms are included even when the user typed nothing.
 */
export function deriveInterestKeywords(interests: string[], savedItems: Pick<Item, 'title' | 'topics'>[]): string[] {
  const out = new Set<string>()
  for (const i of interests) {
    const trimmed = i.trim().toLowerCase()
    if (trimmed.length >= 2) out.add(trimmed)
  }
  const savedText = savedItems.map((i) => i.title).join('\n')
  for (const { term, weight } of keywords(savedText, 24)) {
    if (weight > 0.35) out.add(term)
  }
  for (const item of savedItems) for (const t of item.topics) out.add(t)
  return [...out].slice(0, 64)
}

/** Ratio of items by an author the user kept, smoothed so 1/1 is not 100%. */
export function authorAffinity(saved: number, seen: number): number {
  if (seen <= 0) return 0
  // Laplace smoothing with a prior of 4 pseudo-observations at a 15% base rate.
  return clamp01((saved + 0.6) / (seen + 4))
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Score band used for badge colour and the inbox threshold copy. */
export function scoreBand(score: number): 'critical' | 'high' | 'medium' | 'low' {
  if (score >= 80) return 'critical'
  if (score >= 62) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}
