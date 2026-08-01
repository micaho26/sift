import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  attentionUnits,
  buildFtsQuery,
  canonicalizeUrl,
  centroid,
  cjkBigrams,
  classifyTopics,
  compactNumber,
  computeScore,
  cosineSimilarity,
  depthComponent,
  detectLang,
  displayUrl,
  excerpt,
  extractEntities,
  hammingDistance,
  hashEmbed,
  hashEmbedItem,
  initials,
  interestClusters,
  interleaveByBucket,
  isNearDuplicate,
  maximalMarginalRelevance,
  noiseScore,
  readingTimeSec,
  recencyComponent,
  reciprocalRankFusion,
  rootDomain,
  sameContent,
  scoreBand,
  simhash,
  simhashBands,
  slugify,
  timeAgo,
  tokenize,
} from '../dist/index.js'

/* --------------------------------------------------------------------- url -- */

test('canonicalizeUrl collapses every twitter alias onto one key', () => {
  const forms = [
    'https://twitter.com/simonw/status/1234567890?s=20',
    'https://mobile.twitter.com/simonw/status/1234567890',
    'http://x.com/simonw/status/1234567890/photo/1',
    'https://www.x.com/simonw/statuses/1234567890?utm_source=newsletter',
  ]
  const keys = new Set(forms.map((f) => canonicalizeUrl(f).url))
  assert.equal(keys.size, 1, `expected 1 canonical key, got ${[...keys].join(', ')}`)
  assert.equal([...keys][0], 'https://x.com/simonw/status/1234567890')
  assert.equal(canonicalizeUrl(forms[0]!).sourceId, '1234567890')
  assert.equal(canonicalizeUrl(forms[0]!).source, 'x')
})

test('canonicalizeUrl normalises xiaohongshu notes and drops xsec noise', () => {
  const a = canonicalizeUrl('https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a?xsec_token=ABC&source=web')
  const b = canonicalizeUrl('https://www.xiaohongshu.com/discovery/item/65f0a1b2c3d4e5f60718293a')
  assert.equal(a.url, b.url)
  assert.equal(a.sourceId, '65f0a1b2c3d4e5f60718293a')
  assert.equal(a.source, 'xiaohongshu')
})

test('canonicalizeUrl treats arXiv pdf and abs as the same paper', () => {
  assert.ok(sameContent('https://arxiv.org/pdf/2401.12345v3', 'https://arxiv.org/abs/2401.12345'))
  assert.equal(canonicalizeUrl('https://arxiv.org/pdf/2401.12345v3').sourceId, '2401.12345')
})

test('canonicalizeUrl keeps identity params but drops tracking', () => {
  const yt = canonicalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=abcdef')
  assert.equal(yt.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(yt.sourceId, 'dQw4w9WgXcQ')

  const hn = canonicalizeUrl('https://news.ycombinator.com/item?id=39123456')
  assert.equal(hn.sourceId, '39123456')

  // A genuine content param on an unknown host must survive.
  assert.match(canonicalizeUrl('https://example.com/post?page=2&utm_source=x').url, /page=2/)
  assert.doesNotMatch(canonicalizeUrl('https://example.com/post?page=2&utm_source=x').url, /utm_source/)
})

test('canonicalizeUrl never throws on garbage', () => {
  for (const bad of ['', 'not a url', 'http://', '://///', 'javascript:alert(1)']) {
    assert.doesNotThrow(() => canonicalizeUrl(bad))
  }
})

test('displayUrl and rootDomain are readable', () => {
  assert.equal(displayUrl('https://x.com/simonw/status/1'), 'x.com/simonw/status/1')
  assert.equal(rootDomain('blog.research.google.co.uk'), 'google.co.uk')
  assert.equal(rootDomain('www.example.com'), 'example.com')
})

/* -------------------------------------------------------------------- text -- */

test('cjkBigrams produces overlapping character bigrams', () => {
  assert.equal(cjkBigrams('大模型推理'), '大模 模型 型推 推理')
  assert.equal(cjkBigrams('AI 很好 news'), '很好')
})

test('tokenize handles mixed Chinese and English, dropping stopwords', () => {
  const tokens = tokenize('The new Qwen3 model 在推理任务上 is very good')
  assert.ok(tokens.includes('qwen3'))
  assert.ok(!tokens.includes('the'), 'English stopword should be removed')
  assert.ok(tokens.some((t) => t === '推理'), 'CJK bigram should be present')
})

test('detectLang separates zh, en and ja', () => {
  assert.equal(detectLang('这是一个关于大模型的分享笔记'), 'zh')
  assert.equal(detectLang('OpenAI released a new reasoning model today'), 'en')
  assert.equal(detectLang('これは日本語のテキストです'), 'ja')
  assert.equal(detectLang(''), 'und')
})

test('buildFtsQuery escapes syntax and expands CJK to bigram AND clauses', () => {
  // A malicious query must not become FTS operators.
  const evil = buildFtsQuery('foo* OR bar" NEAR/2 baz')
  assert.doesNotMatch(evil, /NEAR/, 'NEAR operator must be neutralised')
  assert.ok(evil.includes('"foo"*'))

  // A CJK run becomes one adjacency-ordered bigram phrase = substring matching.
  const zh = buildFtsQuery('大模型')
  assert.ok(zh.includes('cjk :'), 'Chinese query targets the bigram column')
  assert.equal(zh, 'cjk : "大模 模型"')
  const twoRuns = buildFtsQuery('本地部署 量化')
  assert.equal(twoRuns, 'cjk : "本地 地部 部署" AND cjk : "量化"', 'separate runs AND together')
  // A full-sentence query must not be phrase-matched verbatim: question affixes
  // are stripped and the remainder becomes OR-ed sliding windows.
  const sentence = buildFtsQuery('怎么降低推理成本')
  assert.ok(!sentence.includes('怎么'), 'question affix stripped')
  assert.ok(sentence.includes(' OR '), 'long run becomes OR-ed windows')
  assert.ok(sentence.includes('推理 理成 成本'), 'a real sub-term window survives')
  // Explicit quotes stay literal even when long.
  assert.equal(buildFtsQuery('"怎么降低推理成本"'), 'cjk : "怎么 么降 降低 低推 推理 理成 成本"')
  // Mixed script keeps both halves.
  const mixed = buildFtsQuery('vLLM 推理')
  assert.ok(mixed.includes('cjk : "推理"') && mixed.includes('"vllm"*'))

  assert.equal(buildFtsQuery('   '), '')
  assert.ok(buildFtsQuery('"exact phrase here"').includes('"exact phrase here"'))
})

test('readingTimeSec scales with length and handles CJK by character', () => {
  const short = readingTimeSec('A short post.')
  const long = readingTimeSec('word '.repeat(1000))
  assert.ok(short < long)
  assert.ok(long > 200 && long < 320, `1000 words should be ~250s, got ${long}`)
  assert.ok(readingTimeSec('模型'.repeat(400)) > 100)
})

test('noiseScore punishes bait but leaves real news alone', () => {
  const bait = noiseScore('🔥🔥🔥 10 INSANE AI TOOLS THAT WILL BLOW YOUR MIND!!! Follow me and RT this 🧵 #ai #agi #tech #llm #tools #viral')
  const real = noiseScore(
    'We trained a 7B model with GRPO and measured a 12.4% improvement on GPQA. Ablations and code: github.com/org/repo',
  )
  assert.ok(bait.score > 0.4, `bait should score high, got ${bait.score}`)
  assert.ok(real.score < 0.1, `substantive text should score low, got ${real.score}`)
  assert.ok(bait.reasons.length > 0)
})

test('excerpt strips markdown noise', () => {
  const out = excerpt('# Heading\n\nSome **bold** text with a [link](https://a.b) and `code`.')
  assert.doesNotMatch(out, /[#*`]/)
  assert.ok(out.startsWith('Heading'))
})

/* ----------------------------------------------------------------- simhash -- */

test('simhash is stable, and near-identical text lands within threshold', () => {
  const a = 'OpenAI has released GPT-6 with a one million token context window'
  const aAgain = 'OpenAI has released GPT-6 with a one million token context window'
  const nearDup = 'OpenAI released GPT-6, which has a one million token context window.'
  const different = 'Unitree announced a new humanoid robot priced under $20,000 for research labs'

  assert.equal(simhash(a), simhash(aAgain), 'must be deterministic')
  assert.equal(simhash(a).length, 16)
  assert.equal(hammingDistance(simhash(a), simhash(aAgain)), 0)

  const dupDist = hammingDistance(simhash(a), simhash(nearDup))
  const diffDist = hammingDistance(simhash(a), simhash(different))
  assert.ok(dupDist < diffDist, `paraphrase (${dupDist}) must be closer than unrelated (${diffDist})`)
  assert.ok(diffDist > 12, `unrelated text should be far apart, got ${diffDist}`)
})

test('simhash bands satisfy the pigeonhole property for true duplicates', () => {
  const h = simhash('DeepSeek V4 tops the LMArena leaderboard across coding and math')
  const bands = simhashBands(h)
  assert.equal(bands.length, 4)
  assert.equal(new Set(simhashBands(h)).size, new Set(bands).size)
  // Identical prints must share all bands.
  assert.deepEqual(simhashBands(h), bands)
})

test('isNearDuplicate rejects unrelated text', () => {
  assert.ok(!isNearDuplicate(simhash('a paper about protein folding'), simhash('gpu prices are falling')))
  assert.equal(hammingDistance('bad', 'input'), 64, 'malformed hashes are maximally distant')
})

test('cosineSimilarity is shape-safe', () => {
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])), 1)
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0)
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])), 0)
  assert.equal(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0])), 0)
})

/* ------------------------------------------------------------------- score -- */

test('attentionUnits weights bookmarks above likes on X', () => {
  const likes = attentionUnits('x', { likes: 100 })
  const bookmarks = attentionUnits('x', { bookmarks: 100 })
  assert.ok(bookmarks > likes, 'a bookmark is a stronger signal than a like')
})

test('computeScore ranks a substantive fresh post above viral bait', () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0)
  const substantive = computeScore({
    source: 'x',
    kind: 'thread',
    title: 'We reproduced DeepSeek-R1 GRPO training at 1/10th the cost',
    content:
      'We trained a 7B model with GRPO on 8xH100 for 14 hours and measured a 12.4% improvement on GPQA and 8.1% on AIME. ' +
      'Full methodology, ablations and code at github.com/org/repo. However, the gains do not transfer to long-context tasks — ' +
      'a caveat worth noting. Throughput was 3200 tok/s at fp8. ```python\ntrain(model, cfg)\n```',
    metrics: { likes: 900, reposts: 260, bookmarks: 800, replies: 90 },
    publishedAt: now - 3 * 3_600_000,
    followers: 40_000,
    now,
  })
  const bait = computeScore({
    source: 'x',
    kind: 'post',
    title: '🔥 10 INSANE AI tools that will BLOW YOUR MIND!!! 🧵',
    content: 'Follow me and RT this for more! #ai #agi #llm #tools #viral #tech',
    metrics: { likes: 12_000, reposts: 3000, views: 2_000_000 },
    publishedAt: now - 3 * 3_600_000,
    followers: 500_000,
    now,
  })

  assert.ok(
    substantive.score > bait.score,
    `substance (${substantive.score}) must beat bait (${bait.score})`,
  )
  assert.ok(substantive.score >= 40, `expected a decent score, got ${substantive.score}`)
  assert.ok(substantive.reasons.length > 0)
  assert.ok(bait.breakdown.noise > 0.2, 'bait must carry a noise penalty')
})

test('computeScore stays in range for degenerate input', () => {
  const empty = computeScore({ source: 'web' })
  assert.ok(empty.score >= 0 && empty.score <= 100)
  const future = computeScore({ source: 'x', publishedAt: Date.now() + 86_400_000 })
  assert.ok(future.score >= 0 && future.score <= 100, 'clock skew must not exceed the range')
  const huge = computeScore({ source: 'x', metrics: { likes: 1e9, views: 1e12 }, followers: 1e9 })
  assert.ok(huge.score <= 100)
})

test('novelty suppresses a duplicate story', () => {
  const base = {
    source: 'x' as const,
    title: 'OpenAI ships GPT-6',
    content: 'OpenAI has shipped GPT-6 today with major improvements.',
    metrics: { likes: 500 },
    publishedAt: Date.now() - 3_600_000,
  }
  const fresh = computeScore({ ...base, maxSimilarityToCorpus: 0 })
  const echoed = computeScore({ ...base, maxSimilarityToCorpus: 0.95 })
  assert.ok(fresh.score > echoed.score, 'the twentieth copy must rank lower')
})

test('relevance is neutral with no interest profile and rises with a match', () => {
  const neutral = computeScore({ source: 'web', title: 'Some AI news', content: 'x'.repeat(50) })
  const matched = computeScore({
    source: 'web',
    title: 'New vLLM release improves throughput',
    content: 'vLLM inference speedups for long context.',
    interestKeywords: ['vllm', 'inference', 'throughput', 'long context'],
  })
  assert.equal(neutral.breakdown.relevance, 0.5, 'cold start must not zero out relevance')
  assert.ok(matched.breakdown.relevance > 0.5)
})

test('recencyComponent halves at the half-life', () => {
  const now = Date.now()
  const halved = recencyComponent(now - 36 * 3_600_000, now, 36)
  assert.ok(Math.abs(halved - 0.5) < 0.01, `expected ~0.5, got ${halved}`)
  assert.equal(recencyComponent(undefined, now), 0.5)
})

test('depthComponent rewards evidence over length', () => {
  const filler = depthComponent({ title: 'AI', content: 'ai '.repeat(600) })
  const evidence = depthComponent({
    title: 'Benchmark results',
    content: 'We measured 42.3% on SWE-bench with 3200 tok/s. See arxiv.org/abs/2501.00001 — however there is a caveat.',
    kind: 'paper',
  })
  assert.ok(evidence > filler, `evidence (${evidence}) should beat filler (${filler})`)
})

test('scoreBand maps to the badge colours', () => {
  assert.equal(scoreBand(95), 'critical')
  assert.equal(scoreBand(70), 'high')
  assert.equal(scoreBand(45), 'medium')
  assert.equal(scoreBand(10), 'low')
})

/* ------------------------------------------------------------------- embed -- */

test('hashEmbed is deterministic, normalised, and similarity-ordered', () => {
  const a = hashEmbed('vLLM improves inference throughput for long context models')
  const b = hashEmbed('vLLM improves inference throughput for long-context models')
  const c = hashEmbed('Unitree launches a cheap humanoid robot for research')

  assert.equal(a.length, 384)
  const norm = Math.sqrt([...a].reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-5, `expected unit length, got ${norm}`)
  assert.deepEqual([...a], [...hashEmbed('vLLM improves inference throughput for long context models')])

  const near = cosineSimilarity(a, b)
  const far = cosineSimilarity(a, c)
  assert.ok(near > far, `paraphrase (${near.toFixed(3)}) must beat unrelated (${far.toFixed(3)})`)
  assert.ok(near > 0.6, `near-identical text should be clearly similar, got ${near.toFixed(3)}`)
})

test('hashEmbed handles Chinese', () => {
  const a = hashEmbed('大模型推理加速的最新进展')
  const b = hashEmbed('大模型推理加速进展')
  const c = hashEmbed('人形机器人量产计划')
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c))
})

test('hashEmbed on empty input returns a zero vector without throwing', () => {
  const v = hashEmbed('')
  assert.equal(v.length, 384)
  assert.ok([...v].every((x) => x === 0))
})

test('hashEmbedItem weights the title', () => {
  const titled = hashEmbedItem({ title: 'Mixture of experts routing', content: 'unrelated filler text here' })
  const query = hashEmbed('Mixture of experts routing')
  assert.ok(cosineSimilarity(titled, query) > 0.4)
})

test('interestClusters separates two distinct interests', () => {
  const robotics = ['humanoid robot manipulation', 'sim2real transfer for robot arms', 'embodied agent policy'].map((t) =>
    hashEmbed(t),
  )
  const inference = ['vllm throughput kv cache', 'speculative decoding latency', 'fp8 quantization serving'].map((t) =>
    hashEmbed(t),
  )
  const clusters = interestClusters([...robotics, ...inference], 2)
  assert.equal(clusters.length, 2)

  const roboQuery = hashEmbed('robot arm grasping policy')
  const best = Math.max(...clusters.map((c) => cosineSimilarity(roboQuery, c)))
  const avgCentroid = cosineSimilarity(roboQuery, centroid([...robotics, ...inference])!)
  assert.ok(best > avgCentroid, 'a cluster must fit better than one blurred average')
})

/* ---------------------------------------------------------------- taxonomy -- */

test('extractEntities recognises models, labs and benchmarks', () => {
  const found = extractEntities(
    'Anthropic released Claude Opus 4.5 which scores 80.9% on SWE-bench, ahead of Gemini 3 and GPT-5.',
  )
  const names = found.map((e) => e.name)
  assert.ok(names.includes('Anthropic'))
  assert.ok(names.includes('SWE-bench'))
  assert.ok(names.includes('Gemini'))
  assert.ok(found.every((e) => e.confidence > 0 && e.confidence <= 1))
})

test('extractEntities respects word boundaries', () => {
  // "mcp" inside another word must not match.
  const none = extractEntities('the mcpxyz library is unrelated').map((e) => e.name)
  assert.ok(!none.includes('Model Context Protocol'))
  assert.ok(extractEntities('we shipped an MCP server today').map((e) => e.name).includes('Model Context Protocol'))
})

test('classifyTopics picks focused topics, not everything', () => {
  const topics = classifyTopics({
    title: 'Speculative decoding cuts inference latency by 3x',
    content: 'We combined speculative decoding with fp8 quantization in vLLM to raise throughput and cut latency.',
  })
  assert.ok(topics.includes('efficiency'), `expected efficiency, got ${topics.join(',')}`)
  assert.ok(topics.length <= 5)
  assert.deepEqual(classifyTopics({ title: '', content: '' }), [])
})

test('classifyTopics works on Chinese text', () => {
  const topics = classifyTopics({ title: '开源模型权重发布', content: '这个大模型的权重已经开源，支持本地部署。' })
  assert.ok(topics.length > 0, 'Chinese content must classify')
})

/* --------------------------------------------------------------------- rrf -- */

test('reciprocalRankFusion rewards agreement between retrievers', () => {
  const keyword = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const semantic = [{ id: 'c' }, { id: 'a' }, { id: 'd' }]
  const fused = reciprocalRankFusion(
    [
      { items: keyword, label: 'keyword' },
      { items: semantic, label: 'semantic' },
    ],
    (i) => i.id,
  )
  assert.equal(fused[0]!.id, 'a', 'ranked highly by both retrievers')
  assert.equal(fused.length, 4)
  assert.equal(fused.find((f) => f.id === 'a')!.sources.length, 2)
  // Monotonically non-increasing.
  for (let i = 1; i < fused.length; i++) assert.ok(fused[i - 1]!.score >= fused[i]!.score)
})

test('maximalMarginalRelevance breaks up near-identical results', () => {
  const dupA = hashEmbed('OpenAI ships GPT-6 today')
  const dupB = hashEmbed('OpenAI has shipped GPT-6 today')
  const other = hashEmbed('Unitree humanoid robot price drop')
  const picked = maximalMarginalRelevance(
    [
      { item: 'a', relevance: 1.0, vector: dupA },
      { item: 'b', relevance: 0.98, vector: dupB },
      { item: 'c', relevance: 0.7, vector: other },
    ],
    0.6,
    2,
    cosineSimilarity,
  )
  assert.deepEqual(picked, ['a', 'c'], 'the diverse result must win the second slot')
  // lambda=1 disables diversification.
  assert.deepEqual(
    maximalMarginalRelevance(
      [
        { item: 'a', relevance: 1, vector: dupA },
        { item: 'b', relevance: 0.98, vector: dupB },
      ],
      1,
      2,
      cosineSimilarity,
    ),
    ['a', 'b'],
  )
})

test('interleaveByBucket caps consecutive runs from one author', () => {
  const items = [
    { id: 1, a: 'alice' },
    { id: 2, a: 'alice' },
    { id: 3, a: 'alice' },
    { id: 4, a: 'bob' },
    { id: 5, a: 'alice' },
  ]
  const out = interleaveByBucket(items, (i) => i.a, 2)
  assert.equal(out.length, items.length)
  let run = 0
  let last = ''
  for (const it of out) {
    run = it.a === last ? run + 1 : 1
    last = it.a
    assert.ok(run <= 2, 'no more than 2 in a row from the same author')
  }
})

/* ------------------------------------------------------------------ format -- */

test('compactNumber and timeAgo render compactly', () => {
  assert.equal(compactNumber(999), '999')
  assert.equal(compactNumber(1500), '1.5K')
  assert.equal(compactNumber(15_400), '15K')
  assert.equal(compactNumber(3_400_000), '3.4M')
  assert.equal(compactNumber(undefined), '—')

  const now = Date.UTC(2026, 6, 29, 12, 0, 0)
  assert.equal(timeAgo(now - 5000, now), 'now')
  assert.equal(timeAgo(now - 5 * 60_000, now), '5m')
  assert.equal(timeAgo(now - 5 * 3_600_000, now), '5h')
  assert.equal(timeAgo(now - 3 * 86_400_000, now), '3d')
  assert.equal(timeAgo(now - 3 * 86_400_000, now, 'zh'), '3天前')
})

test('slugify keeps CJK and initials handle both scripts', () => {
  assert.equal(slugify('Hello, World! 2026'), 'hello-world-2026')
  assert.equal(slugify('大模型 推理'), '大模型-推理')
  assert.equal(slugify('   '), 'untitled')
  assert.equal(initials('Simon Willison'), 'SW')
  assert.equal(initials('karpathy'), 'KA')
  assert.equal(initials('李飞飞'), '李')
})
