#!/usr/bin/env node
/**
 * `pnpm seed` — load the demo corpus so a fresh clone has something to look at.
 *
 * Idempotent: re-running updates the same items rather than duplicating them,
 * because URL canonicalisation makes the URL the identity.
 */
import { MODELS_DIR, ensureDirs } from '../config.ts'
import { closeDb, getDb } from '../db/index.ts'
import { initVectorIndex } from '../db/vector.ts'
import { configureEmbedder, getEmbedder } from '../embed.ts'
import { color, log } from '../log.ts'
import { ingest } from '../pipeline/ingest.ts'
import { rebuildInterestProfile } from '../pipeline/interests.ts'
import { rescoreAll } from '../pipeline/rescore.ts'
import { addToCollection, createCollection, createHighlight, createSavedSearch, listCollections, listSavedSearches } from '../repo/library.ts'
import { markRead, setState, stateCounts } from '../repo/items.ts'
import { getSecret, readSettings, writeSettings } from '../repo/settings.ts'
import { ensureDefaultSources } from '../repo/sources.ts'
import { search } from '../search.ts'
import { generateDigest } from '../ai/digest.ts'
import { demoItems } from './demo-data.ts'

async function main(): Promise<void> {
  ensureDirs()
  getDb()

  const settings = readSettings()
  await configureEmbedder(settings, { openaiKey: getSecret('openai') }, MODELS_DIR)
  initVectorIndex(getEmbedder().dimensions)

  const sourcesCreated = ensureDefaultSources()

  // Give the scorer something to work with, so relevance is not flat at 0.5.
  if (!settings.interests.length) {
    writeSettings({
      interests: [
        'LLM inference optimisation and serving',
        'AI agents, tool use and MCP',
        'open-weights model releases',
        'prompt injection and AI security',
        'local and on-device models',
        'RL post-training',
      ],
    })
  }

  log.info('Ingesting demo corpus…')
  const items = demoItems()
  const result = await ingest(items, { collector: 'seed', settings: readSettings() })

  log.ok(
    `${result.created} created · ${result.updated} updated · ${result.duplicates} near-duplicates folded · ${result.rejected} rejected`,
  )
  for (const error of result.errors.slice(0, 5)) log.debug(`rejected ${error.url}: ${error.reason}`)

  // Triage a few so the sidebar counts and the interest model are not empty.
  const inbox = await search({ ...(await emptyQuery()), states: ['inbox'], sort: 'signal', limit: 40 })
  const top = inbox.items.slice(0, 4).map((i) => i.id)
  const next = inbox.items.slice(4, 9).map((i) => i.id)
  if (top.length) setState(top, 'saved')
  if (next.length) setState(next, 'shortlist')
  if (inbox.items.length > 12) markRead(inbox.items.slice(9, 14).map((i) => i.id), true, 90)

  // Collections
  if (!listCollections().length) {
    const inference = createCollection({
      name: 'Inference & serving',
      description: 'Throughput, quantisation, caching — everything about making models cheap to run.',
      icon: '⚡',
    })
    const security = createCollection({
      name: 'Agent security',
      description: 'Prompt injection, the lethal trifecta, and capability separation.',
      icon: '🛡️',
    })
    createCollection({ name: 'Read next', description: 'Working queue.', icon: '📌' })

    const inferenceHits = await search({ ...(await emptyQuery()), q: 'inference throughput quantisation serving', limit: 8 })
    if (inferenceHits.items.length) addToCollection(inference.id, inferenceHits.items.map((i) => i.id))
    const securityHits = await search({ ...(await emptyQuery()), q: 'prompt injection agent security exfiltration', limit: 6 })
    if (securityHits.items.length) addToCollection(security.id, securityHits.items.map((i) => i.id))
  }

  // A saved view, so the sidebar shows the feature exists.
  if (!listSavedSearches().length) {
    createSavedSearch({
      name: 'High signal today',
      query: { q: '', minScore: 70, sort: 'signal', from: Date.now() - 86_400_000, limit: 50 } as never,
      icon: '🔥',
      pinned: true,
      alerting: true,
    })
    createSavedSearch({
      name: 'Chinese sources',
      query: { q: '', sources: ['xiaohongshu'], sort: 'recent', limit: 50 } as never,
      icon: '🇨🇳',
      pinned: true,
    })
    createSavedSearch({
      name: 'Papers worth reading',
      query: { q: '', kinds: ['paper'], sort: 'signal', minScore: 50, limit: 50 } as never,
      icon: '📄',
      pinned: false,
    })
  }

  // A couple of highlights, so the reader pane is not empty on first open.
  const forHighlight = (await search({ ...(await emptyQuery()), q: 'context rot retrieval degradation', limit: 1 })).items[0]
  if (forHighlight) {
    createHighlight({
      itemId: forHighlight.id,
      text: 'advertised context length is not a usable capacity figure',
      note: 'This is the line to quote when someone cites a 1M window as if it were RAM.',
      color: 'yellow',
    })
  }

  await rebuildInterestProfile(true)
  await rescoreAll()
  await generateDigest({ hours: 168, maxItems: 12, template: true })

  const counts = stateCounts()
  const summary = [
    '',
    `  ${color.violet('◆')} ${color.bold('Demo corpus loaded')}`,
    `  ${color.dim(`inbox ${counts.inbox} · shortlist ${counts.shortlist} · saved ${counts.saved} · archived ${counts.archived}`)}`,
    sourcesCreated ? `  ${color.dim(`${sourcesCreated} default sources configured`)}` : '',
    `  ${color.dim('Run')} ${color.bold('pnpm dev')} ${color.dim('to open it.')}`,
    '',
  ]
    .filter(Boolean)
    .join('\n')
  process.stdout.write(summary)

  closeDb()
}

/** A fully-defaulted SearchQuery without importing Zod here. */
async function emptyQuery() {
  const { SearchQuery } = await import('@sift/core')
  return SearchQuery.parse({})
}

void main().catch((error) => {
  log.error('Seed failed', error)
  closeDb()
  process.exit(1)
})
