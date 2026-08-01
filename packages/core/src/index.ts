/**
 * @sift/core — the shared brain.
 *
 * Everything here is pure, dependency-light (Zod only) and runs unchanged in
 * Node, the browser and a service worker. That constraint is deliberate: the
 * extension scores a tweet locally to decide whether it is worth sending, the
 * server scores it again authoritatively, and the web app explains the score —
 * all from this one implementation.
 */

export const SIFT_VERSION = '0.1.0'
/** Handshake value the extension checks so it never posts to a stranger's port. */
export const SIFT_SERVICE = 'sift' as const
export const DEFAULT_SERVER_PORT = 4471

export * from './types.js'
export * from './url.js'
export * from './text.js'
export * from './simhash.js'
export * from './score.js'
export * from './rrf.js'
export * from './embed.js'
export * from './taxonomy.js'
export * from './format.js'
