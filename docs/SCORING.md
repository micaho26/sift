# The signal score

Every item gets a number from 0 to 100 answering one question: **should this interrupt you?**

This document gives the actual formulas. All of it lives in [`packages/core/src/score.ts`](../packages/core/src/score.ts) as a pure, synchronous function — given identical inputs it always returns the same number, which is what makes re-scoring the whole corpus after a weight change cheap and predictable.

## Two rules the design obeys

1. **Every component is retained.** The full breakdown is stored with the item, so the UI can answer "why is this a 92?" without recomputing anything. A ranking that cannot be interrogated is a vibe, not a measurement.
2. **No component can be gamed into dominance.** Each is squashed by a log or an exponential, so a viral post cannot outrank a substantive one on reach alone — which is precisely the failure mode of every social timeline.

## The combination

```
weighted = Σ (componentᵢ × weightᵢ) / Σ weightᵢ

afterNoise = weighted × (1 − min(0.30, noise × 0.4))

score = round( clamp01( afterNoise × sourceTrust ) × 100 )
```

Weights are normalised, so only their *ratios* matter — a user who drags every slider to the top changes nothing.

| Component | Default weight |
|---|---:|
| Relevance | 0.26 |
| Velocity | 0.22 |
| Depth | 0.15 |
| Novelty | 0.14 |
| Authority | 0.13 |
| Recency | 0.10 |

## Velocity

Attention accruing per unit time, normalised against the platform's own distribution.

Platform counters are not comparable — an HN story at 30 points/hour is front-page material; a tweet needs roughly 1,200 attention units/hour to be equivalent. So each source has a weighting over its counters and a reference p95.

```
units    = Σ (counterₖ × weightₖ)
ageHours = max(0, (now − publishedAt) / 3600_000)
perHour  = units / (ageHours + 2) ^ 0.8
velocity = clamp01( log1p(perHour) / log1p(p95PerHour) )
```

The `^0.8` gravity term and the `+2` are Hacker News's: gravity stops a two-hour-old post with 50 likes beating a two-day-old post with 5,000, and the `+2` stops a brand-new item dividing by ~0.

`log1p` on the outside means the top of the range is not owned by one mega-viral post.

### Counter weights

| Source | Weights | p95/hr |
|---|---|---:|
| X | like 1, repost 2.5, reply 1.2, quote 2, **bookmark 4**, view 0.004 | 1200 |
| 小红书 | like 1, **collect 3.5**, comment 2, share 2.5, view 0.003 | 900 |
| Hacker News | point 1, comment 0.8 | 30 |
| arXiv | citation 4, like 1, comment 1 | 3 |
| GitHub | star 1, fork 2 | 40 |
| Reddit | point 1, comment 1 | 120 |
| Hugging Face | like 2, download 0.02 | 60 |

A **bookmark is the strongest signal on X** — it is "I will come back to this", and it is the hardest counter to farm. Views are abundant, so they are worth almost nothing. On Xiaohongshu, a *collect* plays the same role. On arXiv the ceiling is deliberately low because papers accrue attention over months; there, `depth` carries the weight instead.

## Authority

Reach, blended with revealed preference.

```
reach     = clamp01( log1p(followers) / log1p(2_000_000) )
authority = clamp01( 0.55 × reach + 0.45 × affinity + (verified ? 0.02 : 0) )

affinity  = clamp01( (savedFromAuthor + 0.6) / (seenFromAuthor + 4) )
```

Affinity is weighted almost as heavily as reach because it is the only part of authority that **cannot be bought**. The Laplace smoothing (+0.6 / +4) stops one save out of one appearance reading as 100% affinity.

## Relevance

Semantic closeness to what you care about, plus explicit keyword hits.

```
semantic  = clamp01( (max cosine to any interest vector − 0.05) / 0.6 )
keyword   = clamp01( keywordHits / min(4, interestKeywords.length) )
relevance = clamp01( 0.7 × semantic + 0.3 × keyword )
```

Cosine on normalised text embeddings lives in roughly 0.0–0.8, so the rescale spreads the usable band across the full range.

**Cold start returns exactly 0.5.** With no interest profile, relevance is neutral rather than zero — otherwise a fresh install would rank everything at the floor and look broken.

**Interest vectors are clustered, not averaged.** Saved items are grouped into up to 3 clusters (deterministic farthest-point seeding, then Lloyd iterations with cosine assignment), and each stated interest is embedded as its own anchor. Someone following both robotics and inference optimisation is badly served by a single centroid sitting between the two, which resembles neither.

## Novelty

```
distinct   = clamp01( 1 − maxSimilarityToCorpus )
echoRelief = min(0.15, log1p(echoCount) × 0.06)
novelty    = clamp01( distinct + echoRelief )
```

This is what stops the fortieth "OpenAI ships X" from reaching your inbox while still letting a genuinely new angle through.

`echoRelief` blunts the penalty slightly: being widely echoed *is* mild evidence of importance, so a canonical item with twenty echoes is not punished as hard as a lone duplicate.

## Depth

Length matters, but only as a floor — a 4,000-word SEO page is not deep. What correlates with value is *evidence*.

```
depth  = clamp01( length + markers + kindBonus + varietyBonus )

length = clamp01( log1p(tokens) / log1p(900) ) × 0.4
```

Saturating length curve: ~0 at nothing, ~0.5 at 120 tokens, ~0.85 at 600.

| Marker | Weight |
|---|---:|
| Code (fenced, indented, or inline ≥6 chars) | +0.14 |
| Citations (`arxiv.org/abs/`, `doi.org/`, `[1]`) | +0.13 |
| A GitHub repo link — an actual artefact | +0.09 |
| Numbers with units (`%`, `x`, `tok/s`, `ms`, `GB`, `B params`, `FLOPs`) | +0.12 |
| Measurement language (`we trained`, `benchmarked`, `ablation`, `reproduc`) | +0.11 |
| Hedging (`however`, `trade-off`, `caveat`, `limitation`, `nuance`) | +0.08 |
| Chinese equivalents (`实测`, `复现`, `消融`, `吞吐`, `开源地址`) | +0.11 |

Plus: `+0.12` for a paper or repo, `+0.06` for an article or thread, `+0.05` for ≥3 recognised entities, and a lexical-variety bonus of `clamp01(unique/total − 0.35) × 0.25` that separates an essay from a keyword-stuffed listicle.

**Hedging counts as depth.** Text that says "however, this does not transfer to long-context tasks" is text from someone who actually measured.

## Recency

```
recency = clamp01( 0.5 ^ (ageHours / halfLifeHours) )
```

Default half-life 36 hours: a day-old item retains ~0.63, three days ~0.25. `clamp01` means clock skew or a future timestamp cannot inflate a score. A missing publish date returns 0.5 rather than 0.

## Noise penalty

A 0–1 demerit, applied as at most a 30% haircut. Deliberately conservative — a real launch announcement often *is* exciting, so only recognisable patterns are punished.

| Pattern | Weight |
|---|---:|
| `follow me` / `RT this` | 0.30 |
| Giveaway, `link in bio`, `comment "X" and` | 0.35 |
| `N tips/hacks/tools/prompts that…` | 0.18 |
| `will blow your mind`, `nobody is talking about`, `game changer` | 0.22 |
| `you're doing it wrong`, `stop using` | 0.12 |
| `一定要看`, `震惊`, `干货满满`, `保姆级`, `建议收藏`, `绝了` | 0.20 |
| Emoji density > 3.5% | up to 0.20 |
| ≥6 hashtags | up to 0.20 |
| >55% uppercase (≥30 letters) | 0.12 |
| ≥5 exclamation marks | up to 0.10 |

**The 30% cap is the important part.** Bait wrapped around real news is still real news, and a penalty that could zero an item would let a formatting choice hide a launch.

## Source trust

A per-source multiplier you control in Settings, applied last. Defaults:

| Source | Trust |
|---|---:|
| Saved by you | 1.20 |
| Hacker News | 1.10 |
| arXiv, GitHub | 1.05 |
| X, RSS, Hugging Face, web | 1.00 |
| 小红书 | 0.95 |
| Reddit | 0.90 |
| YouTube, Product Hunt | 0.85 |

## Worked example

The demo corpus contains two posts published three hours apart, deliberately.

**A — a thread with evidence**
900 likes · 260 reposts · 800 bookmarks · 40k followers · benchmark numbers, an ablation, a caveat, a repo link, a code block.

```
velocity  0.72    high attention, and bookmarks weigh 4×
authority 0.58    moderate reach, no save history yet
relevance 0.50    neutral: cold start
novelty   1.00    nothing like it in the corpus
depth     0.87    code + numbers + citation + hedging + measurement language
recency   0.94    three hours old
noise     0.00    → no penalty
                                                        score = 66
```

**B — engagement bait**
12,000 likes · 3,000 reposts · 2M views · 500k followers · "🔥 10 INSANE AI tools that will BLOW YOUR MIND!!! 🧵 #ai #agi #llm…"

```
velocity  1.00    genuinely viral
authority 0.71    large following, verified
relevance 0.50    neutral
novelty   0.97
depth     0.21    no numbers, no code, no evidence — just claims
recency   0.94
noise     0.77    → −30% (capped): follow-bait, hype, emoji, hashtag stuffing
                                                        score = 31
```

**B has 13× the engagement of A and scores less than half.** That is the whole point of the exercise.

## Tuning it

Every weight, the recency half-life and the inbox threshold are sliders in Settings. Changing any of them rescores the library in the background and streams progress over SSE.

Items below the inbox threshold are **archived on arrival, not discarded** — they stay fully searchable. The asymmetry is deliberate: "we hid something you wanted" is unrecoverable, "we showed one extra" is merely noise.

Two escape hatches for when scoring is not what you want:

- `sort=recent` ignores the score entirely.
- Muted keywords and authors drop items at ingestion, before they are scored or indexed at all.
