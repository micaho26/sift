/**
 * Sift domain model.
 *
 * Every shape that crosses a process boundary (extension -> server, server -> web)
 * is declared here as a Zod schema and the TS type is inferred from it. The
 * extension is the least trustworthy caller in the system — it runs inside pages
 * we do not control — so its payloads are parsed, never cast.
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ enums -- */

export const SOURCES = [
  'x',
  'xiaohongshu',
  'hackernews',
  'arxiv',
  'github',
  'rss',
  'reddit',
  'youtube',
  'producthunt',
  'huggingface',
  'web',
  'manual',
] as const
export const SourceKind = z.enum(SOURCES)
export type SourceKind = z.infer<typeof SourceKind>

export const ITEM_KINDS = [
  'post',
  'thread',
  'article',
  'paper',
  'repo',
  'video',
  'note',
  'discussion',
  'release',
  'model',
] as const
export const ItemKind = z.enum(ITEM_KINDS)
export type ItemKind = z.infer<typeof ItemKind>

/** Triage lifecycle. `inbox -> shortlist -> saved` is the happy path. */
export const ITEM_STATES = ['inbox', 'shortlist', 'saved', 'archived', 'trash'] as const
export const ItemState = z.enum(ITEM_STATES)
export type ItemState = z.infer<typeof ItemState>

export const ENTITY_TYPES = [
  'model',
  'company',
  'person',
  'paper',
  'product',
  'concept',
  'dataset',
  'benchmark',
] as const
export const EntityType = z.enum(ENTITY_TYPES)
export type EntityType = z.infer<typeof EntityType>

/* ------------------------------------------------------------- primitives -- */

export const Author = z.object({
  name: z.string().max(200).default(''),
  handle: z.string().max(120).optional(),
  url: z.string().max(2048).optional(),
  avatarUrl: z.string().max(2048).optional(),
  followers: z.number().int().nonnegative().optional(),
  verified: z.boolean().optional(),
  bio: z.string().max(1000).optional(),
})
export type Author = z.infer<typeof Author>

/**
 * Raw platform counters. Deliberately a superset across platforms — a tweet has
 * `reposts`, an HN story has `points`, a repo has `stars`. Scoring normalises
 * them into one "attention" figure per source.
 */
export const Metrics = z
  .object({
    likes: z.number().int().nonnegative().optional(),
    reposts: z.number().int().nonnegative().optional(),
    replies: z.number().int().nonnegative().optional(),
    quotes: z.number().int().nonnegative().optional(),
    views: z.number().int().nonnegative().optional(),
    bookmarks: z.number().int().nonnegative().optional(),
    collects: z.number().int().nonnegative().optional(),
    stars: z.number().int().nonnegative().optional(),
    forks: z.number().int().nonnegative().optional(),
    points: z.number().int().nonnegative().optional(),
    comments: z.number().int().nonnegative().optional(),
    citations: z.number().int().nonnegative().optional(),
    downloads: z.number().int().nonnegative().optional(),
  })
  .default({})
export type Metrics = z.infer<typeof Metrics>

export const Media = z.object({
  type: z.enum(['image', 'video', 'gif', 'audio']),
  url: z.string().max(4096),
  thumbUrl: z.string().max(4096).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  alt: z.string().max(2000).optional(),
})
export type Media = z.infer<typeof Media>

export const Entity = z.object({
  type: EntityType,
  name: z.string().min(1).max(120),
  /** 0..1 — how sure the extractor is. Dictionary hits are 1, heuristics lower. */
  confidence: z.number().min(0).max(1).default(1),
})
export type Entity = z.infer<typeof Entity>

/* -------------------------------------------------------- score breakdown -- */

/**
 * Every component of the signal score is retained so the UI can answer
 * "why is this a 92?" without re-running the model. This is the single most
 * important trust affordance in the product.
 */
export const ScoreBreakdown = z.object({
  /** Attention accrued per unit time, normalised against the source's own p95. */
  velocity: z.number().min(0).max(1),
  /** Author reach x how often *you* keep this author's posts. */
  authority: z.number().min(0).max(1),
  /** Cosine to your interest centroid + explicit keyword hits. */
  relevance: z.number().min(0).max(1),
  /** 1 - similarity to what you have already seen. Kills the 40th duplicate. */
  novelty: z.number().min(0).max(1),
  /** Substance heuristics: length, code, citations, structure, specificity. */
  depth: z.number().min(0).max(1),
  /** Exponential freshness decay. */
  recency: z.number().min(0).max(1),
  /** Engagement-bait / spam demerit, subtracted. */
  noise: z.number().min(0).max(1),
  /** Per-source multiplier the user controls in Settings. */
  sourceTrust: z.number().min(0).max(2),
  /** Weights in force when this score was computed (so old scores stay legible). */
  weights: z.record(z.string(), z.number()),
})
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>

/* -------------------------------------------------------------------- item -- */

export const Item = z.object({
  id: z.string(),
  /** Canonical URL — the dedup key. */
  url: z.string().max(4096),
  /** sha256 of the canonical URL, hex. Unique index. */
  urlHash: z.string().length(64),
  source: SourceKind,
  /** Platform-native id (tweet id, HN id, arXiv id, repo nwo). */
  sourceId: z.string().max(400).optional(),
  kind: ItemKind,

  title: z.string().max(1000),
  /** One-paragraph gist. Extracted first; AI-written only if asked. */
  summary: z.string().max(4000).optional(),
  /** Full text as Markdown. The canonical body we index and embed. */
  content: z.string().optional(),
  lang: z.string().max(16).optional(),

  author: Author.optional(),
  metrics: Metrics,
  media: z.array(Media).max(24).default([]),

  /** Machine-derived subject tags from the AI taxonomy. */
  topics: z.array(z.string().max(64)).max(24).default([]),
  /** Human tags. Never overwritten by a re-score. */
  tags: z.array(z.string().max(64)).max(64).default([]),
  entities: z.array(Entity).max(64).default([]),

  publishedAt: z.number().int().optional(),
  capturedAt: z.number().int(),
  updatedAt: z.number().int(),

  score: z.number().min(0).max(100),
  scoreBreakdown: ScoreBreakdown.optional(),

  state: ItemState.default('inbox'),
  starred: z.boolean().default(false),
  readAt: z.number().int().optional(),
  readingTimeSec: z.number().int().nonnegative().default(0),

  /** 64-bit SimHash as 16 hex chars, for near-duplicate clustering. */
  simhash: z.string().length(16).optional(),
  /** Id of the canonical item when this one is a near-duplicate. */
  duplicateOf: z.string().optional(),
  /** How many near-duplicates collapsed into this item — a signal in itself. */
  echoCount: z.number().int().nonnegative().default(0),

  /** AI-generated fields, kept separate from extracted ones. */
  aiSummary: z.string().optional(),
  aiTranslation: z.string().optional(),
  aiTakeaways: z.array(z.string()).max(12).optional(),

  /** Original payload, for reprocessing without re-fetching. */
  raw: z.unknown().optional(),
})
export type Item = z.infer<typeof Item>

/** What the feed list needs — deliberately excludes `content` and `raw`. */
export type ItemSummary = Omit<Item, 'content' | 'raw'>

/* ------------------------------------------------------- ingestion payload -- */

/**
 * What a capturer (extension content script or server connector) submits.
 * Server-owned fields — id, score, urlHash, state — are absent by design.
 */
export const IngestItem = z.object({
  url: z.string().min(1).max(4096),
  source: SourceKind,
  sourceId: z.string().max(400).optional(),
  kind: ItemKind.default('post'),
  title: z.string().max(1000).default(''),
  summary: z.string().max(4000).optional(),
  content: z.string().max(400_000).optional(),
  lang: z.string().max(16).optional(),
  author: Author.optional(),
  metrics: Metrics.optional(),
  media: z.array(Media).max(24).optional(),
  topics: z.array(z.string().max(64)).max(24).optional(),
  tags: z.array(z.string().max(64)).max(64).optional(),
  publishedAt: z.number().int().optional(),
  /** Capturers may pre-triage; defaults to inbox. */
  state: ItemState.optional(),
  raw: z.unknown().optional(),
})
export type IngestItem = z.infer<typeof IngestItem>

export const IngestRequest = z.object({
  items: z.array(IngestItem).min(1).max(500),
  /** Free-form label for where this batch came from, e.g. "x:home-timeline". */
  collector: z.string().max(120).optional(),
})
export type IngestRequest = z.infer<typeof IngestRequest>

export const IngestResult = z.object({
  received: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.number().int(),
  ids: z.array(z.string()),
  errors: z.array(z.object({ url: z.string(), reason: z.string() })).default([]),
})
export type IngestResult = z.infer<typeof IngestResult>

/* ------------------------------------------------------------ collections -- */

export const Collection = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  /** Emoji or lucide icon name. */
  icon: z.string().max(40).optional(),
  color: z.string().max(40).optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  itemCount: z.number().int().nonnegative().default(0),
  /** When set, membership is computed from a query instead of pinned rows. */
  smartQuery: z.string().max(2000).optional(),
})
export type Collection = z.infer<typeof Collection>

export const Highlight = z.object({
  id: z.string(),
  itemId: z.string(),
  text: z.string().min(1).max(10_000),
  note: z.string().max(10_000).optional(),
  color: z.enum(['yellow', 'green', 'blue', 'purple', 'red']).default('yellow'),
  /** Character offsets into `item.content`, when resolvable. */
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  createdAt: z.number().int(),
})
export type Highlight = z.infer<typeof Highlight>

/* ----------------------------------------------------------------- search -- */

export const SortMode = z.enum(['signal', 'recent', 'relevance', 'velocity', 'oldest'])
export type SortMode = z.infer<typeof SortMode>

export const SearchQuery = z.object({
  q: z.string().max(1000).default(''),
  sources: z.array(SourceKind).optional(),
  kinds: z.array(ItemKind).optional(),
  states: z.array(ItemState).optional(),
  tags: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  authors: z.array(z.string()).optional(),
  collectionId: z.string().optional(),
  minScore: z.number().min(0).max(100).optional(),
  /** Epoch ms bounds on publishedAt (falling back to capturedAt). */
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  starred: z.boolean().optional(),
  unreadOnly: z.boolean().optional(),
  hasMedia: z.boolean().optional(),
  lang: z.string().optional(),
  /**
   * Left undefined, the server picks: `relevance` when `q` is present, `signal`
   * otherwise. Set it explicitly to override.
   */
  sort: SortMode.optional(),
  /** Hybrid = BM25 + vector, fused with RRF. */
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
  /** Maximal-marginal-relevance diversification strength, 0 = off. */
  diversify: z.number().min(0).max(1).default(0),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
})
export type SearchQuery = z.infer<typeof SearchQuery>

export const SearchFacet = z.object({
  value: z.string(),
  count: z.number().int(),
})
export type SearchFacet = z.infer<typeof SearchFacet>

export const SearchResponse = z.object({
  items: z.array(z.custom<ItemSummary>()),
  total: z.number().int(),
  cursor: z.string().optional(),
  tookMs: z.number(),
  /** Per-result provenance so the UI can badge "semantic match". */
  matchedBy: z.record(z.string(), z.enum(['keyword', 'semantic', 'both'])).default({}),
  /** Topic/entity ids the query expanded into — rendered as "also matched" chips. */
  concepts: z.array(z.string()).default([]),
  facets: z
    .object({
      sources: z.array(SearchFacet),
      topics: z.array(SearchFacet),
      tags: z.array(SearchFacet),
      authors: z.array(SearchFacet),
    })
    .optional(),
})
export type SearchResponse = z.infer<typeof SearchResponse>

export const SavedSearch = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  query: SearchQuery,
  icon: z.string().max(40).optional(),
  pinned: z.boolean().default(false),
  /** Notify when new matches appear. */
  alerting: z.boolean().default(false),
  lastSeenAt: z.number().int().optional(),
  newCount: z.number().int().nonnegative().default(0),
  createdAt: z.number().int(),
})
export type SavedSearch = z.infer<typeof SavedSearch>

/* ---------------------------------------------------------------- sources -- */

export const SourceConfig = z.object({
  id: z.string(),
  kind: SourceKind,
  /** Human label shown in the sidebar. */
  name: z.string().min(1).max(160),
  /** Feed URL, subreddit, arXiv category, repo query, X list id... */
  target: z.string().max(2048),
  enabled: z.boolean().default(true),
  /** Minutes between polls. Extension-fed sources use 0 (push-only). */
  intervalMinutes: z.number().int().min(0).max(10_080).default(30),
  /** Multiplies the final score. 1 = neutral. */
  trust: z.number().min(0).max(2).default(1),
  /** Drop items that fail these before scoring. */
  filters: z
    .object({
      includeKeywords: z.array(z.string()).optional(),
      excludeKeywords: z.array(z.string()).optional(),
      minEngagement: z.number().int().nonnegative().optional(),
      lang: z.array(z.string()).optional(),
    })
    .default({}),
  lastRunAt: z.number().int().optional(),
  lastError: z.string().optional(),
  itemsCollected: z.number().int().nonnegative().default(0),
  createdAt: z.number().int(),
})
export type SourceConfig = z.infer<typeof SourceConfig>

/* --------------------------------------------------------------- settings -- */

export const ScoringWeights = z.object({
  velocity: z.number().min(0).max(1).default(0.22),
  authority: z.number().min(0).max(1).default(0.13),
  relevance: z.number().min(0).max(1).default(0.26),
  novelty: z.number().min(0).max(1).default(0.14),
  depth: z.number().min(0).max(1).default(0.15),
  recency: z.number().min(0).max(1).default(0.1),
})
export type ScoringWeights = z.infer<typeof ScoringWeights>

export const Settings = z.object({
  /** Free-text description of what the user cares about — seeds the interest vector. */
  interests: z.array(z.string().max(200)).default([]),
  mutedKeywords: z.array(z.string().max(120)).default([]),
  mutedAuthors: z.array(z.string().max(120)).default([]),
  weights: ScoringWeights.prefault({}),
  /** Hours for the recency term to halve. */
  recencyHalfLifeHours: z.number().min(1).max(720).default(36),
  /** Items below this never reach the inbox (they stay searchable). */
  inboxThreshold: z.number().min(0).max(100).default(35),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  locale: z.enum(['en', 'zh']).default('en'),
  ai: z
    .object({
      provider: z.enum(['anthropic', 'openai', 'ollama', 'none']).default('none'),
      model: z.string().default('claude-sonnet-5'),
      /** Never returned by the API; write-only. */
      apiKeySet: z.boolean().default(false),
      baseUrl: z.string().optional(),
      /** Auto-summarise anything scoring above this. 0 = manual only. */
      autoSummarizeAbove: z.number().min(0).max(100).default(0),
      translateTo: z.enum(['none', 'en', 'zh']).default('none'),
    })
    .prefault({}),
  embeddings: z
    .object({
      provider: z.enum(['local', 'openai', 'ollama', 'hash']).default('hash'),
      model: z.string().default('sift-hash-v1'),
      dimensions: z.number().int().default(384),
    })
    .prefault({}),
  digest: z
    .object({
      enabled: z.boolean().default(true),
      hourLocal: z.number().int().min(0).max(23).default(9),
      maxItems: z.number().int().min(3).max(50).default(12),
    })
    .prefault({}),
})
export type Settings = z.infer<typeof Settings>
export type SettingsInput = z.input<typeof Settings>

/* ---------------------------------------------------------------- digests -- */

export const DigestSection = z.object({
  heading: z.string(),
  body: z.string(),
  itemIds: z.array(z.string()),
})
export type DigestSection = z.infer<typeof DigestSection>

export const Digest = z.object({
  id: z.string(),
  title: z.string(),
  periodFrom: z.number().int(),
  periodTo: z.number().int(),
  /** Executive summary — 2-3 sentences. */
  lede: z.string(),
  sections: z.array(DigestSection),
  itemIds: z.array(z.string()),
  createdAt: z.number().int(),
  /** 'ai' when an LLM wrote the prose, 'template' when we assembled it locally. */
  generator: z.enum(['ai', 'template']).default('template'),
})
export type Digest = z.infer<typeof Digest>

/* -------------------------------------------------------------- analytics -- */

export const TrendPoint = z.object({
  bucket: z.number().int(),
  count: z.number().int(),
  avgScore: z.number(),
})
export type TrendPoint = z.infer<typeof TrendPoint>

export const TopicTrend = z.object({
  topic: z.string(),
  total: z.number().int(),
  /** Ratio of this period's volume to the previous period's. 1 when unknown. */
  momentum: z.number(),
  /** True when there is no comparable prior window, so momentum is not meaningful. */
  isNew: z.boolean().default(false),
  avgScore: z.number(),
  series: z.array(z.number().int()),
  sampleItemIds: z.array(z.string()).max(5),
})
export type TopicTrend = z.infer<typeof TopicTrend>

export const AnalyticsResponse = z.object({
  range: z.object({ from: z.number().int(), to: z.number().int() }),
  totals: z.object({
    items: z.number().int(),
    saved: z.number().int(),
    read: z.number().int(),
    sources: z.number().int(),
    avgScore: z.number(),
    readingTimeSec: z.number().int(),
  }),
  volume: z.array(TrendPoint),
  bySource: z.array(z.object({ source: SourceKind, count: z.number().int(), avgScore: z.number() })),
  topics: z.array(TopicTrend),
  topAuthors: z.array(
    z.object({
      handle: z.string(),
      name: z.string(),
      count: z.number().int(),
      avgScore: z.number(),
      saves: z.number().int(),
    }),
  ),
  entities: z.array(z.object({ name: z.string(), type: EntityType, count: z.number().int() })),
  scoreHistogram: z.array(z.object({ bucket: z.number().int(), count: z.number().int() })),
})
export type AnalyticsResponse = z.infer<typeof AnalyticsResponse>

/* ------------------------------------------------------------------- chat -- */

export const ChatCitation = z.object({
  itemId: z.string(),
  title: z.string(),
  url: z.string(),
  source: SourceKind,
  /** The exact passage handed to the model. */
  snippet: z.string(),
  score: z.number(),
})
export type ChatCitation = z.infer<typeof ChatCitation>

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(ChatCitation).optional(),
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const ChatRequest = z.object({
  messages: z.array(ChatMessage).min(1),
  /** Restrict retrieval to a slice of the corpus. */
  scope: SearchQuery.partial().optional(),
  topK: z.number().int().min(1).max(40).default(12),
})
export type ChatRequest = z.infer<typeof ChatRequest>

/* --------------------------------------------------------- realtime events -- */

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('items:new'),
    count: z.number().int(),
    ids: z.array(z.string()),
    topScore: z.number(),
  }),
  z.object({ type: z.literal('items:updated'), ids: z.array(z.string()) }),
  z.object({ type: z.literal('items:removed'), ids: z.array(z.string()) }),
  z.object({
    type: z.literal('source:status'),
    id: z.string(),
    state: z.enum(['running', 'ok', 'error']),
    message: z.string().optional(),
    collected: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('job'),
    name: z.string(),
    state: z.enum(['start', 'progress', 'done', 'error']),
    progress: z.number().min(0).max(1).optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('ping'), t: z.number().int() }),
])
export type StreamEvent = z.infer<typeof StreamEvent>

/* ------------------------------------------------------------------ misc -- */

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  /** Extension checks this to confirm it is talking to a real Sift server. */
  service: z.literal('sift'),
  db: z.object({
    items: z.number().int(),
    sizeBytes: z.number().int(),
    vectorSearch: z.boolean(),
    fullTextSearch: z.boolean(),
  }),
  embeddings: z.object({ provider: z.string(), ready: z.boolean(), dimensions: z.number().int() }),
  ai: z.object({ provider: z.string(), configured: z.boolean() }),
  uptimeSec: z.number(),
})
export type HealthResponse = z.infer<typeof HealthResponse>

export type ApiError = { error: string; detail?: string; code?: string }
