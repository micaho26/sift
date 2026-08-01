/**
 * Embedding providers.
 *
 * `hash` is the default and needs nothing — no download, no key, no network. It
 * makes semantic search, novelty detection and "more like this" work on the very
 * first run, which is the difference between a tool that is useful immediately
 * and one that shows an empty state until a 90 MB model finishes downloading.
 *
 * Users who want true paraphrase matching can switch to Ollama or OpenAI in
 * Settings (both plain HTTP, still zero npm dependencies) or install
 * `@huggingface/transformers` for a fully local transformer, which is loaded via
 * dynamic import so it never becomes a required dependency.
 */
import { HASH_DIMENSIONS, hashEmbed, hashEmbedItem, normalizeVector } from '@sift/core'
import type { Settings } from '@sift/core'
import { log } from './log.ts'

export type EmbedProviderName = 'hash' | 'local' | 'ollama' | 'openai'

export type Embedder = {
  name: EmbedProviderName
  model: string
  dimensions: number
  ready: boolean
  /** Batch API: providers that support batching are much faster per item. */
  embed(texts: string[]): Promise<Float32Array[]>
  embedOne(text: string): Promise<Float32Array>
  /** Item-aware embedding — title weighting matters for retrieval quality. */
  embedItem(item: { title?: string; summary?: string; content?: string; topics?: string[]; author?: { name?: string } }): Promise<Float32Array>
  /**
   * Cosine above which two items are the same story told twice.
   *
   * Measured, not guessed. On the demo corpus the hash embedder puts a genuine
   * repost at 0.60 and the closest *distinct* pair at 0.29, so 0.50 sits in the
   * middle of a 2x gap. A transformer compresses everything upward — unrelated
   * technical text sits around 0.5-0.6 there — hence the much higher bar.
   */
  echoThreshold: number
}

/** Text fed to a neural model, assembled so the title dominates. */
function itemToText(item: {
  title?: string
  summary?: string
  content?: string
  topics?: string[]
  author?: { name?: string }
}): string {
  const parts = [item.title?.trim(), item.topics?.length ? item.topics.join(', ') : '', item.summary?.trim(), item.content?.slice(0, 4000)]
  return parts.filter(Boolean).join('\n\n')
}

/* ---------------------------------------------------------------- hashing -- */

function createHashEmbedder(): Embedder {
  return {
    name: 'hash',
    model: 'sift-hash-v1',
    dimensions: HASH_DIMENSIONS,
    ready: true,
    echoThreshold: 0.5,
    async embed(texts) {
      return texts.map((t) => hashEmbed(t))
    },
    async embedOne(text) {
      return hashEmbed(text)
    },
    async embedItem(item) {
      return hashEmbedItem(item)
    },
  }
}

/* ----------------------------------------------------------------- ollama -- */

function createOllamaEmbedder(model: string, baseUrl: string, dimensions: number): Embedder {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/embed`

  async function call(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text().catch(() => '')}`)
    const data = (await response.json()) as { embeddings?: number[][] }
    if (!data.embeddings?.length) throw new Error('Ollama returned no embeddings')
    return data.embeddings.map((v) => normalizeVector(Float32Array.from(v)))
  }

  const embedOne = async (text: string): Promise<Float32Array> => {
    const [vector] = await call([text])
    return vector ?? new Float32Array(dimensions)
  }

  return {
    name: 'ollama',
    model,
    dimensions,
    ready: true,
    echoThreshold: 0.86,
    embed: call,
    embedOne,
    embedItem: (item) => embedOne(itemToText(item)),
  }
}

/* ----------------------------------------------------------------- openai -- */

function createOpenAIEmbedder(model: string, apiKey: string, baseUrl: string, dimensions: number): Embedder {
  const endpoint = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/embeddings`

  async function call(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      // Requesting a fixed dimension keeps the index shape stable across models.
      body: JSON.stringify({ model, input: texts, dimensions }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text().catch(() => '')}`)
    const data = (await response.json()) as { data?: { embedding: number[]; index: number }[] }
    const sorted = (data.data ?? []).sort((a, b) => a.index - b.index)
    return sorted.map((d) => normalizeVector(Float32Array.from(d.embedding)))
  }

  const embedOne = async (text: string): Promise<Float32Array> => {
    const [vector] = await call([text])
    return vector ?? new Float32Array(dimensions)
  }

  return {
    name: 'openai',
    model,
    dimensions,
    ready: true,
    echoThreshold: 0.86,
    embed: call,
    embedOne,
    embedItem: (item) => embedOne(itemToText(item)),
  }
}

/* ------------------------------------------------------ local transformer -- */

/**
 * Fully local transformer via `@huggingface/transformers`, if the user installed
 * it. Kept as a dynamic import with a string-built specifier so bundlers do not
 * try to resolve a package that is intentionally absent.
 */
async function createLocalEmbedder(model: string, cacheDir: string): Promise<Embedder | null> {
  try {
    const specifier = '@huggingface/transformers'
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<
        (input: string[], opts?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>
      >
      env: { cacheDir?: string; localModelPath?: string; allowRemoteModels?: boolean }
    }
    mod.env.cacheDir = cacheDir
    mod.env.allowRemoteModels = true

    log.info(`Loading local embedding model ${model} (first run downloads ~25 MB)…`)
    const extractor = await mod.pipeline('feature-extraction', model)

    // Probe once to learn the true dimensionality rather than trusting settings.
    const probe = await extractor(['dimension probe'], { pooling: 'mean', normalize: true })
    const dimensions = probe.tolist()[0]?.length ?? 384
    log.info(`Local embeddings ready · ${model} · ${dimensions}d`)

    const embed = async (texts: string[]): Promise<Float32Array[]> => {
      if (!texts.length) return []
      const output = await extractor(texts, { pooling: 'mean', normalize: true })
      return output.tolist().map((v) => normalizeVector(Float32Array.from(v)))
    }
    const embedOne = async (text: string): Promise<Float32Array> => {
      const [vector] = await embed([text])
      return vector ?? new Float32Array(dimensions)
    }

    const embedder: Embedder = {
      name: 'local',
      model,
      dimensions,
      ready: true,
      echoThreshold: 0.86,
      embed,
      embedOne,
      embedItem: (item) => embedOne(itemToText(item)),
    }
    return embedder
  } catch (error) {
    log.warn(
      `Local embedding model unavailable (${(error as Error).message.split('\n')[0]}). ` +
        'Run `pnpm add @huggingface/transformers -w --filter sift-server` to enable it. Falling back to hash embeddings.',
    )
    return null
  }
}

/* ------------------------------------------------------------- resolution -- */

let active: Embedder = createHashEmbedder()

export function getEmbedder(): Embedder {
  return active
}

/**
 * Select a provider from settings, degrading to `hash` on any failure. An
 * unreachable Ollama must never stop the server from booting.
 */
export async function configureEmbedder(
  settings: Settings,
  secrets: { openaiKey?: string },
  cacheDir: string,
): Promise<Embedder> {
  const wanted = settings.embeddings.provider as EmbedProviderName
  const model = settings.embeddings.model
  const dimensions = settings.embeddings.dimensions

  try {
    if (wanted === 'ollama') {
      const embedder = createOllamaEmbedder(model || 'nomic-embed-text', settings.ai.baseUrl || 'http://127.0.0.1:11434', dimensions)
      await embedder.embedOne('probe') // fail fast if the daemon is not running
      active = embedder
      log.info(`Embeddings · ollama · ${embedder.model} · ${embedder.dimensions}d`)
      return active
    }
    if (wanted === 'openai') {
      if (!secrets.openaiKey) throw new Error('no OpenAI API key configured')
      const embedder = createOpenAIEmbedder(model || 'text-embedding-3-small', secrets.openaiKey, settings.ai.baseUrl ?? '', dimensions)
      await embedder.embedOne('probe')
      active = embedder
      log.info(`Embeddings · openai · ${embedder.model} · ${embedder.dimensions}d`)
      return active
    }
    if (wanted === 'local') {
      const embedder = await createLocalEmbedder(model || 'Xenova/all-MiniLM-L6-v2', cacheDir)
      if (embedder) {
        active = embedder
        return active
      }
    }
  } catch (error) {
    log.warn(`Embedding provider "${wanted}" failed: ${(error as Error).message}. Using hash embeddings.`)
  }

  active = createHashEmbedder()
  return active
}

/** Reset to the built-in provider — used by tests and by settings changes. */
export function resetEmbedder(): void {
  active = createHashEmbedder()
}
