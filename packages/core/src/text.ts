/**
 * Text intelligence: tokenisation, language detection, keyword extraction,
 * FTS5 query construction and the engagement-bait detector.
 *
 * Bilingual by requirement — half the corpus is Xiaohongshu Chinese, half is
 * English X/HN/arXiv. SQLite's `unicode61` tokeniser treats a whole Chinese
 * sentence as one token, which silently breaks Chinese search. The fix used
 * throughout: keep `unicode61` for Latin text and index a parallel column of
 * CJK *bigrams* that we generate ourselves, expanding Chinese queries to match.
 */

const CJK_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿　-〿＀-￯가-힯]/
const CJK_RUN_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g
const LATIN_TOKEN_RE = /[a-z0-9][a-z0-9+#._-]{0,38}/g

const STOPWORDS_EN = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves just like really new via using use used get got make makes made one two also now still even much many way lot thing things something anything everything
  amp rt http https www com html pdf via thread`
    .split(/\s+/)
    .filter(Boolean),
)

const STOPWORDS_ZH = new Set(
  `的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 我们 他们 你们 但是 因为 所以 如果 可以 这个 那个 什么 怎么 为什么 已经 还是 或者 而且 不过 然后 现在 today 以及 通过 对于 关于 进行 实现 提供 支持 需要 能够 一些 这些 那些 时候 问题 方式 方法 情况 内容 分享 大家 真的 感觉 觉得 其实 就是 一下 特别 非常 直接 之后 之前 一直 目前 主要 包括`
    .split(/\s+/)
    .filter(Boolean),
)

/** True when the string contains any CJK codepoint. */
export function hasCJK(text: string): boolean {
  return CJK_RE.test(text)
}

/**
 * Space-separated character bigrams for every CJK run in `text`.
 * "大模型推理" -> "大模 模型 型推 理". Single-character runs are kept whole.
 */
export function cjkBigrams(text: string): string {
  if (!text) return ''
  const out: string[] = []
  for (const run of text.match(CJK_RUN_RE) ?? []) {
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out.join(' ')
}

/**
 * Tokens for scoring, SimHash and keyword extraction. Latin words are
 * lowercased and stop-filtered; CJK runs become bigrams.
 */
export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens: string[] = []

  for (const m of lower.match(LATIN_TOKEN_RE) ?? []) {
    if (m.length < 2) continue
    if (!opts.keepStopwords && STOPWORDS_EN.has(m)) continue
    tokens.push(m)
  }
  for (const bg of cjkBigrams(lower).split(' ')) {
    if (!bg) continue
    if (!opts.keepStopwords && STOPWORDS_ZH.has(bg)) continue
    tokens.push(bg)
  }
  return tokens
}

/** Cheap script-ratio language detection. Good enough to pick a translator direction. */
export function detectLang(text: string): string {
  const sample = text.slice(0, 2000)
  if (!sample.trim()) return 'und'
  let cjk = 0
  let hiragana = 0
  let katakana = 0
  let hangul = 0
  let latin = 0
  let cyrillic = 0
  for (const ch of sample) {
    const c = ch.codePointAt(0)!
    if (c >= 0x3040 && c <= 0x309f) hiragana++
    else if (c >= 0x30a0 && c <= 0x30ff) katakana++
    else if (c >= 0xac00 && c <= 0xd7af) hangul++
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++
    else if (c >= 0x400 && c <= 0x4ff) cyrillic++
  }
  const total = cjk + hiragana + katakana + hangul + latin + cyrillic
  if (total === 0) return 'und'
  if ((hiragana + katakana) / total > 0.08) return 'ja'
  if (hangul / total > 0.15) return 'ko'
  if (cjk / total > 0.15) return 'zh'
  if (cyrillic / total > 0.3) return 'ru'
  if (latin / total > 0.4) return 'en'
  return 'und'
}

/** Words-per-minute reading estimate, CJK counted by character. */
export function readingTimeSec(text: string): number {
  if (!text) return 0
  const cjkChars = (text.match(CJK_RUN_RE) ?? []).join('').length
  const latinWords = (text.replace(CJK_RUN_RE, ' ').match(/\S+/g) ?? []).length
  // 238 wpm English (Brysbaert 2019), ~400 cpm Chinese.
  const seconds = (latinWords / 238) * 60 + (cjkChars / 400) * 60
  return Math.max(text.trim() ? 5 : 0, Math.round(seconds))
}

/* -------------------------------------------------------------- html/text -- */

const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|blockquote|pre|table|tr|br|hr|figure|figcaption)\b[^>]*>/gi

/** Convert HTML to readable plain text, preserving paragraph breaks. */
export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()
}

/** Grapheme-safe truncation on a word boundary where possible. */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (!text) return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const slice = chars.slice(0, max).join('')
  if (hasCJK(slice)) return slice.trimEnd() + ellipsis
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + ellipsis
}

/** First meaningful paragraph, for the feed row's preview line. */
export function excerpt(text: string, max = 220): string {
  if (!text) return ''
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(cleaned, max)
}

/* --------------------------------------------------------- keyword mining -- */

/**
 * Frequency-based keyphrase extraction with a positional prior (terms in the
 * title/opening carry more weight) and a length bonus for multi-word phrases.
 */
export function keywords(text: string, limit = 12): { term: string; weight: number }[] {
  const tokens = tokenize(text)
  if (!tokens.length) return []
  const counts = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  tokens.forEach((t, i) => {
    counts.set(t, (counts.get(t) ?? 0) + 1)
    if (!firstSeen.has(t)) firstSeen.set(t, i)
  })
  const n = tokens.length
  const scored = [...counts.entries()].map(([term, count]) => {
    const tf = count / n
    const positional = 1 - (firstSeen.get(term)! / n) * 0.45
    const lengthBonus = term.length >= 6 ? 1.15 : 1
    return { term, weight: tf * positional * lengthBonus * Math.log1p(count) }
  })
  scored.sort((a, b) => b.weight - a.weight)
  const max = scored[0]?.weight ?? 1
  return scored.slice(0, limit).map((s) => ({ term: s.term, weight: max ? s.weight / max : 0 }))
}

/* ------------------------------------------------------------- FTS5 query -- */

const FTS_SPECIALS = /["*(){}:^-]/g

/**
 * Chinese question words and particles that carry no retrieval value. Stripped
 * from the edges of a CJK run before it becomes a phrase, so "怎么降低推理成本"
 * searches for "降低推理成本" rather than failing to match the whole sentence.
 */
const ZH_QUERY_AFFIXES = [
  '怎么样', '为什么', '是什么', '怎样', '怎么', '如何', '什么', '哪些', '哪个', '有没有',
  '能不能', '可以', '我想', '请问', '求', '的', '了', '呢', '吗', '啊', '一下', '介绍',
]

/**
 * Turn one CJK run into FTS5 phrase clauses.
 *
 * A short run becomes a single bigram phrase, which is exact substring matching.
 * A long run cannot: "怎么降低推理成本" as one phrase requires the document to
 * contain that entire sentence verbatim, so it matches nothing. Without a word
 * segmenter, the standard remedy is overlapping windows — slide a 4-character
 * window across the run, phrase-match each, and OR them so BM25 ranks documents
 * by how many windows they contain. A document with "推理成本" scores; one with
 * none does not appear.
 */
function cjkRunClauses(run: string): string[] {
  let core = run
  // Strip affixes from both ends, repeatedly (queries stack them: "请问如何…").
  let changed = true
  while (changed && core.length > 2) {
    changed = false
    for (const affix of ZH_QUERY_AFFIXES) {
      if (core.length > affix.length + 1 && core.startsWith(affix)) {
        core = core.slice(affix.length)
        changed = true
      }
      if (core.length > affix.length + 1 && core.endsWith(affix)) {
        core = core.slice(0, -affix.length)
        changed = true
      }
    }
  }
  if (!core) return []

  const phrase = (text: string) => {
    const grams = cjkBigrams(text).split(' ').filter(Boolean)
    return grams.length ? `cjk : "${grams.join(' ')}"` : ''
  }

  // Up to 5 characters is a term, not a sentence — match it exactly.
  if (core.length <= 5) {
    const single = phrase(core)
    return single ? [single] : []
  }

  const WINDOW = 4
  const STEP = 2
  const windows: string[] = []
  for (let i = 0; i + WINDOW <= core.length; i += STEP) {
    const clause = phrase(core.slice(i, i + WINDOW))
    if (clause) windows.push(clause)
  }
  // Ensure the tail is covered when the run length is not a multiple of STEP.
  const tail = phrase(core.slice(-WINDOW))
  if (tail && !windows.includes(tail)) windows.push(tail)

  if (!windows.length) return []
  return [`(${[...new Set(windows)].join(' OR ')})`]
}

/**
 * Translate a human query into a safe FTS5 MATCH expression.
 *
 * - `"exact phrase"` is preserved as a phrase.
 * - Bare Latin terms get a prefix `*` so search feels live-as-you-type.
 * - CJK runs become bigram phrases against the `cjk` column (see `cjkRunClauses`).
 * - Everything is quoted, so no user input can be interpreted as FTS syntax.
 */
export function buildFtsQuery(input: string): string {
  const q = (input ?? '').trim()
  if (!q) return ''

  const clauses: string[] = []
  const phraseRe = /"([^"]+)"/g
  let rest = q
  for (const m of q.matchAll(phraseRe)) {
    const phrase = m[1]!.replace(/"/g, '').trim()
    if (!phrase) continue
    if (hasCJK(phrase)) {
      // An explicitly quoted phrase is taken literally — no affix stripping, no
      // windowing. The user asked for those exact characters.
      const bg = cjkBigrams(phrase)
      if (bg) clauses.push(`cjk : "${bg}"`)
      const latin = phrase.replace(CJK_RUN_RE, ' ').trim()
      if (latin) clauses.push(`"${latin.replace(FTS_SPECIALS, ' ')}"`)
    } else {
      clauses.push(`"${phrase.replace(FTS_SPECIALS, ' ')}"`)
    }
    rest = rest.replace(m[0], ' ')
  }

  for (const run of rest.match(CJK_RUN_RE) ?? []) {
    clauses.push(...cjkRunClauses(run))
  }

  const latinTerms = (rest.replace(CJK_RUN_RE, ' ').toLowerCase().match(LATIN_TOKEN_RE) ?? []).filter(
    (t) => t.length >= 2,
  )
  for (const term of latinTerms) {
    const safe = term.replace(FTS_SPECIALS, '')
    if (!safe) continue
    clauses.push(safe.length >= 3 ? `"${safe}"*` : `"${safe}"`)
  }

  if (!clauses.length) return ''
  return clauses.join(' AND ')
}

/** Terms to visually highlight in results, derived from the same query. */
export function highlightTerms(input: string): string[] {
  const q = (input ?? '').trim().toLowerCase()
  if (!q) return []
  const out = new Set<string>()
  for (const m of q.matchAll(/"([^"]+)"/g)) if (m[1]) out.add(m[1].trim())
  const rest = q.replace(/"[^"]+"/g, ' ')
  for (const t of rest.match(LATIN_TOKEN_RE) ?? []) if (t.length >= 2 && !STOPWORDS_EN.has(t)) out.add(t)
  for (const run of rest.match(CJK_RUN_RE) ?? []) if (run.length >= 1) out.add(run)
  return [...out].filter(Boolean).slice(0, 24)
}

/* --------------------------------------------------------------- noise -- */

const BAIT_PATTERNS: { re: RegExp; weight: number; label: string }[] = [
  { re: /\b(?:follow|rt|retweet|like)\s+(?:me|this|and)\b/i, weight: 0.3, label: 'follow-bait' },
  { re: /\b(?:giveaway|free\s+course|dm\s+me|link\s+in\s+bio|comment\s+["“]?\w+["”]?\s+and)\b/i, weight: 0.35, label: 'giveaway' },
  { re: /\b(?:\d+\s+(?:tips|hacks|tools|prompts|secrets|tricks|ways)\s+(?:to|that|you))\b/i, weight: 0.18, label: 'listicle-bait' },
  { re: /\b(?:this\s+will\s+blow\s+your\s+mind|nobody\s+is\s+talking\s+about|game\s?changer|insane|mind[-\s]?blowing)\b/i, weight: 0.22, label: 'hype' },
  { re: /\b(?:you'?re\s+doing\s+it\s+wrong|stop\s+using|delete\s+your)\b/i, weight: 0.12, label: 'provocation' },
  { re: /(?:一定要看|震惊|你不知道的|干货满满|速看|保姆级|建议收藏|抓紧|绝了|太香了)/, weight: 0.2, label: 'zh-hype' },
  { re: /^\s*(?:🧵|thread\s*:|a\s+thread)/i, weight: 0.05, label: 'thread-marker' },
]

/**
 * 0..1 demerit for engagement bait. Deliberately conservative — a real launch
 * announcement often *is* exciting, so we only punish recognisable patterns,
 * emoji density and hashtag stuffing.
 */
export function noiseScore(text: string): { score: number; reasons: string[] } {
  if (!text) return { score: 0, reasons: [] }
  const sample = text.slice(0, 4000)
  let score = 0
  const reasons: string[] = []

  for (const p of BAIT_PATTERNS) {
    if (p.re.test(sample)) {
      score += p.weight
      reasons.push(p.label)
    }
  }

  const emoji = (sample.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length
  const chars = Math.max(1, Array.from(sample).length)
  const emojiDensity = emoji / chars
  if (emojiDensity > 0.035) {
    score += Math.min(0.2, (emojiDensity - 0.035) * 4)
    reasons.push('emoji-dense')
  }

  const hashtags = (sample.match(/#[^\s#]+/g) ?? []).length
  if (hashtags >= 6) {
    score += Math.min(0.2, (hashtags - 5) * 0.03)
    reasons.push('hashtag-stuffing')
  }

  const letters = sample.replace(/[^A-Za-z]/g, '')
  if (letters.length > 30) {
    const upper = (sample.match(/[A-Z]/g) ?? []).length / letters.length
    if (upper > 0.55) {
      score += 0.12
      reasons.push('shouting')
    }
  }

  const exclam = (sample.match(/[!！]/g) ?? []).length
  if (exclam >= 5) {
    score += Math.min(0.1, exclam * 0.015)
    reasons.push('exclamatory')
  }

  return { score: Math.min(1, score), reasons: [...new Set(reasons)] }
}

/** Contiguous snippet around the first query hit, with `<mark>`-able bounds. */
export function snippetAround(text: string, terms: string[], radius = 120): string {
  if (!text) return ''
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return excerpt(text, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}
