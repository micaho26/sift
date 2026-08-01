# The browser extension

Some sources cannot be polled from a server: X and 小红书 require your own authenticated session. The extension covers those, plus one-click capture of any article.

## Install

```bash
pnpm build:extension
```

Then in Chrome, Edge, Brave or Arc:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → `apps/extension/.output/chrome-mv3`

`pnpm --filter sift-extension zip` produces a distributable archive.

## What it does

| Where | Behaviour |
|---|---|
| **x.com** | Auto-collects posts as you scroll, if harvesting is on for the site |
| **www.xiaohongshu.com** | Same, for notes in the feed and the note you open |
| **Anywhere else** | <kbd>⌥⇧S</kbd>, the toolbar button, or the right-click menu captures the page |

Select text first and only that passage is captured, tagged `highlighted`.

| Shortcut | Action |
|---|---|
| <kbd>⌥⇧S</kbd> | Capture the current page |
| <kbd>⌥⇧H</kbd> | Toggle auto-collection for this site |

## How data is obtained

This is the part worth understanding, because the naive approach — re-requesting the platform's API from the extension — is both fragile and rude.

```
┌────────────────────── the page's own JavaScript realm ──────────────────────┐
│                                                                             │
│  inject-x.js  (MAIN world)                                                  │
│    • wraps window.fetch and XMLHttpRequest.prototype.{open,send}            │
│    • when a response URL matches a timeline GraphQL operation, clones it     │
│      and postMessage()s the parsed JSON                                     │
│    • never issues a request of its own                                      │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ window.postMessage (same-origin checked)
┌───────────────────────────────▼─────────────────────────────────────────────┐
│  x.content.ts  (ISOLATED world)                                             │
│    • walks the JSON for tweet-shaped objects                                │
│    • scrapes the DOM as a backstop                                          │
│    • dedupes against what it has already sent this page-load                │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ chrome.runtime.sendMessage
┌───────────────────────────────▼─────────────────────────────────────────────┐
│  background.ts  (service worker)                                            │
│    • coalesces into 1.5s batches, deduped by URL                            │
│    • verifies the server handshake, then POSTs /api/ingest                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why the MAIN world.** An isolated content script has its own `fetch`; patching there would observe nothing. The MAIN world is the only place the page's own network activity is visible.

**What this means in practice.** Nothing is re-requested, no credentials are read, and no additional load is placed on the platform — the extension sees exactly what your browser already received, at the rate you browse. If you never open X, nothing is collected from X.

**Why the JSON and not the DOM.** The response carries exact counts, untruncated text (`note_tweet` holds the full body of a long post), author follower numbers and real timestamps. The DOM has truncated text behind "Show more" and rounded counts. The DOM path exists as a fallback and is labelled `x:dom-gap` in the server's logs so you can tell which path produced an item.

### Shape tolerance

The walkers do **not** follow a hardcoded path like `data.home.home_timeline_urt.instructions[].entries[].content.itemContent.tweet_results.result`. They recurse and match on a signature:

- **X** — an object with `legacy.full_text` (or `__typename === 'Tweet'`) plus an id. Stable across every response shape since 2022.
- **小红书** — an object with a 24-hex `note_id`/`id` alongside a `title`, `desc`, or `type: 'normal' | 'video'`.

Both walkers carry a `Set`-based cycle guard and a depth limit, and are tested against cyclic and over-deep input. When a platform reshuffles its envelope, capture keeps working.

### Xiaohongshu specifics

- `window.__INITIAL_STATE__` holds the first screen, server-rendered before any XHR. It is read at injection time and once more after 1.2s, since it may be assigned late.
- Counts arrive as strings: `1.2万` → 12000, `3.5亿` → 350000000, `10+` → 10.
- Timestamps are sometimes seconds and sometimes milliseconds; anything below 1e12 is promoted.
- `xsec_token` is a per-session capability, not part of a note's identity, so it is stripped before the URL becomes a dedup key.
- A note captured from the grid is later re-captured from its own page with the full body — the content script allows exactly one such upgrade per URL.

## Permissions

```jsonc
"permissions":      ["storage", "activeTab", "scripting", "contextMenus", "notifications"],
"host_permissions": ["https://x.com/*", "https://twitter.com/*",
                     "https://www.xiaohongshu.com/*",
                     "http://127.0.0.1/*", "http://localhost/*"]
```

What is deliberately **absent**: `<all_urls>`, `tabs`, `cookies`, `webRequest`, `history`, `bookmarks`.

Page capture works through `activeTab` — the grant is you invoking the extension on that tab — and injects `capture.js` on demand via `chrome.scripting.executeScript`. It is not a registered content script, so it never runs anywhere you did not ask for it.

## Server discovery

The extension does not assume a port. It probes a small candidate range and requires a handshake before trusting the result:

```ts
const health = await (await fetch(`${url}/api/health`)).json()
if (health.service !== 'sift') return null   // not our server; do not post to it
```

Posting captured content to whatever happens to answer on `127.0.0.1:4471` would be a real leak. Once a real Sift server is found, its URL is remembered.

Content scripts have **no** path to the server. Everything routes through the worker, so a compromised page cannot reach loopback even if it fully controls its own realm.

## Bundle size

Content scripts run on every page load of a matched site, so weight matters.

| File | Size |
|---|---:|
| `content-scripts/x.js` | 10.5 KB |
| `content-scripts/xhs.js` | 10.3 KB |
| `background.js` | 5.4 KB |
| `inject-x.js` | 1.8 KB |
| `capture.js` | 5.0 KB |

The content scripts import from `@sift/core` **type-only**. Importing values pulled in Zod and the AI taxonomy's ~400 compiled regexes, taking each script from 10 KB to 114 KB — for the sake of one integer constant, which is now duplicated with a comment saying why.

## Article extraction

`extract-article.ts` is a compact readability implementation: score candidate containers by text density minus link density, penalise the usual furniture by class/id, reward `<article>`/`<main>` and paragraph count, then flatten the winner to Markdown-ish text preserving headings, lists, quotes and code.

Metadata comes from JSON-LD first (most reliable for author and publish date), then OpenGraph, then Twitter cards, then the DOM.

Full Readability.js would be ~30 KB in a script that only ever runs when you press a key. The heuristic is good enough for that job.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Badge shows `!` | Server unreachable. Run `pnpm dev` and reopen the popup. |
| Nothing collected on X | Harvesting off for the site (check the popup), or you have not scrolled — collection follows your browsing. |
| Chinese notes not appearing | 小红书 renders the grid lazily; scroll once. The open note is always captured. |
| "Already in your library" | URL canonicalisation matched an existing item. Working as intended. |
| Captures stop after idling | MV3 suspends the worker. The next event revives it; queued items flush on `onSuspend`. |

Set `SIFT_LOG=debug` on the server to see which collector produced each item.

## On terms of service

Sift reads what you are already logged in and looking at, at the rate you browse, for your own private reference. It does not automate accounts, bypass access controls, defeat rate limits, or redistribute anything. Automatic collection is per-site and turns off with one keystroke.

That is a defensible position, not a legal opinion. If a platform's terms matter to you, read them and configure the extension accordingly — every site can be disabled independently, and the server-side connectors work without the extension at all.
