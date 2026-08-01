/**
 * LLM access.
 *
 * Written against raw HTTP rather than each vendor's SDK so the server keeps zero
 * runtime dependencies for a feature that is entirely optional. Three providers
 * are supported (Anthropic, OpenAI-compatible, Ollama) behind one interface, and
 * when none is configured every AI feature degrades to a deterministic local
 * fallback instead of an error — a product with no API key must still be complete.
 */
import type { Settings } from '@sift/core'
import { log } from '../log.ts'
import { getSecret, readSettings } from '../repo/settings.ts'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

export type CompletionRequest = {
  system?: string
  messages: ChatTurn[]
  maxTokens?: number
  temperature?: number
}

export type AiStatus = {
  provider: string
  model: string
  configured: boolean
  reason?: string
}

const TIMEOUT_MS = 120_000

export function aiStatus(settings: Settings = readSettings()): AiStatus {
  const provider = settings.ai.provider
  const model = settings.ai.model
  if (provider === 'none') return { provider, model, configured: false, reason: 'No provider selected' }
  if (provider === 'ollama') return { provider, model, configured: true }
  const key = getSecret(provider === 'anthropic' ? 'anthropic' : 'openai')
  return key
    ? { provider, model, configured: true }
    : { provider, model, configured: false, reason: `No ${provider} API key set` }
}

export class AiNotConfiguredError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'AiNotConfiguredError'
  }
}

/* -------------------------------------------------------------- anthropic -- */

async function* streamAnthropic(request: CompletionRequest, model: string, apiKey: string): AsyncGenerator<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.3,
      system: request.system,
      messages: request.messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Anthropic ${response.status}: ${(await response.text().catch(() => '')).slice(0, 400)}`)
  }
  for await (const event of readSse(response.body)) {
    if (!event.data || event.data === '[DONE]') continue
    try {
      const parsed = JSON.parse(event.data) as {
        type?: string
        delta?: { text?: string }
        error?: { message?: string }
      }
      if (parsed.type === 'error') throw new Error(parsed.error?.message ?? 'Anthropic stream error')
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) yield parsed.delta.text
    } catch (error) {
      if (error instanceof SyntaxError) continue // partial frame
      throw error
    }
  }
}

/* --------------------------------------------------- openai-compatible -- */

async function* streamOpenAI(
  request: CompletionRequest,
  model: string,
  apiKey: string,
  baseUrl: string,
): AsyncGenerator<string> {
  const endpoint = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`
  const messages = request.system
    ? [{ role: 'system' as const, content: request.system }, ...request.messages]
    : request.messages

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.3,
      stream: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok || !response.body) {
    throw new Error(`OpenAI ${response.status}: ${(await response.text().catch(() => '')).slice(0, 400)}`)
  }
  for await (const event of readSse(response.body)) {
    if (!event.data || event.data === '[DONE]') continue
    try {
      const parsed = JSON.parse(event.data) as { choices?: { delta?: { content?: string } }[] }
      const text = parsed.choices?.[0]?.delta?.content
      if (text) yield text
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
}

/* ----------------------------------------------------------------- ollama -- */

async function* streamOllama(request: CompletionRequest, model: string, baseUrl: string): AsyncGenerator<string> {
  const endpoint = `${(baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`
  const messages = request.system
    ? [{ role: 'system' as const, content: request.system }, ...request.messages]
    : request.messages

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature: request.temperature ?? 0.3 } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Ollama ${response.status}: ${(await response.text().catch(() => '')).slice(0, 400)}`)
  }
  // Ollama streams newline-delimited JSON, not SSE.
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as { message?: { content?: string }; error?: string }
        if (parsed.error) throw new Error(parsed.error)
        if (parsed.message?.content) yield parsed.message.content
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
  }
}

/* -------------------------------------------------------------- SSE reader -- */

type SseEvent = { event?: string; data: string }

/** Minimal SSE frame reader over a fetch body stream. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')

      let event: string | undefined
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length) yield { event, data: dataLines.join('\n') }
    }
  }
}

/* ------------------------------------------------------------- public API -- */

/** Stream a completion. Throws `AiNotConfiguredError` when no provider is set. */
export async function* streamCompletion(request: CompletionRequest): AsyncGenerator<string> {
  const settings = readSettings()
  const status = aiStatus(settings)
  if (!status.configured) throw new AiNotConfiguredError(status.reason ?? 'AI is not configured')

  const model = settings.ai.model
  const baseUrl = settings.ai.baseUrl ?? ''

  try {
    if (settings.ai.provider === 'anthropic') {
      yield* streamAnthropic(request, model, getSecret('anthropic')!)
    } else if (settings.ai.provider === 'openai') {
      yield* streamOpenAI(request, model, getSecret('openai')!, baseUrl)
    } else if (settings.ai.provider === 'ollama') {
      yield* streamOllama(request, model, baseUrl)
    }
  } catch (error) {
    log.warn(`AI request failed: ${(error as Error).message}`)
    throw error
  }
}

/** Collect a full completion. Convenience over `streamCompletion`. */
export async function complete(request: CompletionRequest): Promise<string> {
  let out = ''
  for await (const chunk of streamCompletion(request)) out += chunk
  return out
}

export function isAiConfigured(): boolean {
  return aiStatus().configured
}
