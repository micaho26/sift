/**
 * URL canonicalisation — the foundation of deduplication.
 *
 * The same tweet reaches us as `x.com/u/status/1?s=20`, `twitter.com/u/status/1`,
 * `mobile.twitter.com/u/status/1/photo/1` and via `t.co`. Unless all four collapse
 * to one key, the inbox fills with the same thing four times. This module is
 * intentionally aggressive but never lossy in a way that merges distinct content.
 */

/** Tracking params that never identify content. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_social',
  'utm_brand',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  'ck_subscriber_id',
  'ref',
  'ref_src',
  'ref_url',
  'referrer',
  'source',
  'src',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  'vero_id',
  'vero_conv',
  'yclid',
  'ttclid',
  'li_fat_id',
  'guccounter',
  'guce_referrer',
  'guce_referrer_sig',
  'spm',
  'scm',
  'share_source',
  'share_medium',
  'from',
  'from_source',
  'app_platform',
  'author_share',
  'shareRedId',
  'apptime',
  'share_id',
  'wxshare_id',
  'timestamp',
  'sessionid',
  '__twitter_impression',
  'cmpid',
  'CMP',
  'smid',
  'partner',
])

/** Host aliases that serve identical content. */
const HOST_ALIASES: Record<string, string> = {
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'www.twitter.com': 'x.com',
  'nitter.net': 'x.com',
  'www.x.com': 'x.com',
  'mobile.x.com': 'x.com',
  'm.youtube.com': 'www.youtube.com',
  'youtu.be': 'www.youtube.com',
  'youtube.com': 'www.youtube.com',
  'www.xiaohongshu.com': 'www.xiaohongshu.com',
  'xiaohongshu.com': 'www.xiaohongshu.com',
  'xhslink.com': 'www.xiaohongshu.com',
  'news.ycombinator.com': 'news.ycombinator.com',
  'old.reddit.com': 'www.reddit.com',
  'reddit.com': 'www.reddit.com',
  'np.reddit.com': 'www.reddit.com',
  'arxiv.org': 'arxiv.org',
  'www.arxiv.org': 'arxiv.org',
  'export.arxiv.org': 'arxiv.org',
  'github.com': 'github.com',
  'www.github.com': 'github.com',
  'huggingface.co': 'huggingface.co',
  'www.huggingface.co': 'huggingface.co',
}

/** Params that must survive because they *are* the identifier. */
const ESSENTIAL_PARAMS: Record<string, Set<string>> = {
  'www.youtube.com': new Set(['v', 't', 'list']),
  'news.ycombinator.com': new Set(['id']),
  'arxiv.org': new Set([]),
  'www.xiaohongshu.com': new Set(['xsec_token']),
}

export type CanonicalUrl = {
  /** The deduplication key. */
  url: string
  host: string
  /** Platform-native id when we can recognise the shape. */
  sourceId?: string
  /** Best guess at which connector this belongs to. */
  source?: string
}

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

/**
 * Normalise a URL into its canonical form plus any recognisable platform id.
 * Never throws: an unparseable input is returned trimmed so ingestion can still
 * record it (with a synthetic hash) rather than dropping the item.
 */
export function canonicalizeUrl(input: string): CanonicalUrl {
  const raw = (input ?? '').trim()
  if (!raw) return { url: '', host: '' }

  let u: URL
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return { url: raw.slice(0, 4096), host: '' }
  }

  // Scheme: everything is https for keying purposes.
  u.protocol = 'https:'
  u.hash = ''
  u.username = ''
  u.password = ''
  if (u.port === '80' || u.port === '443') u.port = ''

  let host = u.hostname.toLowerCase()
  const isYoutubeShort = host === 'youtu.be'
  host = HOST_ALIASES[host] ?? host.replace(/^www\./, '')
  u.hostname = host

  // youtu.be/<id> -> youtube.com/watch?v=<id>
  if (isYoutubeShort) {
    const id = stripTrailingSlash(u.pathname).replace(/^\//, '')
    if (id) {
      u.pathname = '/watch'
      u.search = ''
      u.searchParams.set('v', id)
    }
  }

  // Drop tracking params; keep essentials for hosts that need them.
  const essential = ESSENTIAL_PARAMS[host]
  const keep: [string, string][] = []
  for (const [k, v] of u.searchParams) {
    const lower = k.toLowerCase()
    if (essential) {
      if (essential.has(k) || essential.has(lower)) keep.push([k, v])
      continue
    }
    if (TRACKING_PARAMS.has(k) || TRACKING_PARAMS.has(lower)) continue
    if (lower === 's' || lower === 't') continue // x.com share noise
    if (lower.startsWith('utm_')) continue
    keep.push([k, v])
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  u.search = ''
  for (const [k, v] of keep) u.searchParams.append(k, v)

  let path = stripTrailingSlash(u.pathname)
  let sourceId: string | undefined
  let source: string | undefined

  // --- x.com ------------------------------------------------------------- //
  if (host === 'x.com') {
    source = 'x'
    const m = path.match(/^\/([A-Za-z0-9_]{1,20})\/status(?:es)?\/(\d+)/)
    if (m) {
      sourceId = m[2]
      path = `/${m[1]}/status/${m[2]}` // drops /photo/1, /video/1, /analytics
      u.search = ''
    } else {
      const profile = path.match(/^\/([A-Za-z0-9_]{1,20})$/)
      if (profile) sourceId = profile[1]
    }
  }

  // --- xiaohongshu ------------------------------------------------------- //
  else if (host === 'www.xiaohongshu.com') {
    source = 'xiaohongshu'
    // /explore/<24-hex>  or  /discovery/item/<24-hex>  or  /user/profile/<id>/<noteId>
    const m = path.match(/(?:\/explore\/|\/discovery\/item\/|\/user\/profile\/[0-9a-f]+\/)([0-9a-f]{16,32})/i)
    if (m) {
      sourceId = m[1]!.toLowerCase()
      path = `/explore/${sourceId}`
      // xsec_token is required to *open* the note but is not part of its identity.
      u.search = ''
    }
  }

  // --- hacker news ------------------------------------------------------- //
  else if (host === 'news.ycombinator.com') {
    source = 'hackernews'
    sourceId = u.searchParams.get('id') ?? undefined
  }

  // --- arxiv ------------------------------------------------------------- //
  else if (host === 'arxiv.org') {
    source = 'arxiv'
    const m = path.match(/^\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/)
    if (m) {
      sourceId = m[1]
      path = `/abs/${m[1]}` // pdf and abs are the same paper
      u.search = ''
    }
  }

  // --- github ------------------------------------------------------------ //
  else if (host === 'github.com') {
    source = 'github'
    const m = path.match(/^\/([^/]+)\/([^/]+)$/)
    if (m) sourceId = `${m[1]}/${m[2]}`
  }

  // --- reddit ------------------------------------------------------------ //
  else if (host === 'www.reddit.com') {
    source = 'reddit'
    const m = path.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i)
    if (m) {
      sourceId = m[2]
      path = `/r/${m[1]}/comments/${m[2]}`
      u.search = ''
    }
  }

  // --- youtube ----------------------------------------------------------- //
  else if (host === 'www.youtube.com') {
    source = 'youtube'
    sourceId = u.searchParams.get('v') ?? undefined
    if (sourceId) {
      // Keep only `v`; playlist/time position are not identity.
      u.search = ''
      u.searchParams.set('v', sourceId)
    }
  }

  // --- hugging face ------------------------------------------------------ //
  else if (host === 'huggingface.co') {
    source = 'huggingface'
    const m = path.match(/^\/(?:papers\/)?([^/]+)(?:\/([^/]+))?$/)
    if (m) sourceId = m[2] ? `${m[1]}/${m[2]}` : m[1]
  }

  u.pathname = path || '/'
  const url = u.toString().replace(/\?$/, '')
  return { url, host, sourceId, source }
}

/** FNV-1a 64-bit, hex — used where a cryptographic hash is overkill. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/** True when two URLs point at the same content. */
export function sameContent(a: string, b: string): boolean {
  return canonicalizeUrl(a).url === canonicalizeUrl(b).url
}

/** Pretty display form: `x.com/simonw` rather than the full canonical URL. */
export function displayUrl(url: string, maxLength = 48): string {
  try {
    const u = new URL(url)
    const shown = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`
    return shown.length > maxLength ? `${shown.slice(0, maxLength - 1)}…` : shown
  } catch {
    return url.slice(0, maxLength)
  }
}

/** Registrable-ish domain for grouping. Handles common two-part public suffixes. */
export function rootDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.')
  if (parts.length <= 2) return parts.join('.')
  const twoPartTlds = new Set(['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr', 'com.br', 'com.tw', 'ac.uk', 'org.uk'])
  const lastTwo = parts.slice(-2).join('.')
  if (twoPartTlds.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}
