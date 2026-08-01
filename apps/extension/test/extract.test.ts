/**
 * Extractor tests.
 *
 * Fixtures mirror the real response shapes: X nests a tweet under
 * `content.itemContent.tweet_results.result` inside `instructions[].entries[]`,
 * and Xiaohongshu buries notes under `data.items[].note_card`. The point of these
 * tests is that the *walkers* find them without knowing those paths, so a
 * platform reshuffling its envelope does not silently break capture.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findTweetNodes, itemsFromGraphql, tweetToItem, X_OPERATIONS } from '../src/lib/extract-x.ts'
import { findNoteNodes, itemsFromState, noteToItem, XHS_ENDPOINTS } from '../src/lib/extract-xhs.ts'

/* ------------------------------------------------------------------- X ---- */

const tweet = {
  __typename: 'Tweet',
  rest_id: '1899000000000000123',
  core: {
    user_results: {
      result: {
        __typename: 'User',
        is_blue_verified: true,
        legacy: {
          screen_name: 'karpathy',
          name: 'Andrej Karpathy',
          followers_count: 1_240_000,
          profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg',
          description: 'Building things',
        },
      },
    },
  },
  views: { count: '2140000' },
  note_tweet: {
    note_tweet_results: {
      result: {
        text: 'The full untruncated body of a long post. '.repeat(12) + 'Ends here with https://t.co/xyz',
      },
    },
  },
  legacy: {
    id_str: '1899000000000000123',
    conversation_id_str: '1899000000000000123',
    created_at: 'Wed Jul 29 09:14:00 +0000 2026',
    full_text: 'The truncated version that should lose to note_tweet…',
    lang: 'en',
    favorite_count: 18_400,
    retweet_count: 3_120,
    reply_count: 612,
    quote_count: 88,
    bookmark_count: 9_800,
    entities: {
      urls: [{ url: 'https://t.co/xyz', expanded_url: 'https://example.com/real-article' }],
    },
    extended_entities: {
      media: [
        {
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/abc.jpg',
          original_info: { width: 1600, height: 900 },
          ext_alt_text: 'A chart',
        },
      ],
    },
  },
}

/** The real envelope: deeply nested, with unrelated entry types interleaved. */
const timelineResponse = {
  data: {
    home: {
      home_timeline_urt: {
        instructions: [
          { type: 'TimelineClearCache' },
          {
            type: 'TimelineAddEntries',
            entries: [
              { entryId: 'cursor-top-1', content: { entryType: 'TimelineTimelineCursor', value: 'abc' } },
              {
                entryId: 'tweet-1899000000000000123',
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet } },
                },
              },
              {
                entryId: 'who-to-follow-1',
                content: { entryType: 'TimelineTimelineModule', items: [{ item: { itemContent: { itemType: 'TimelineUser' } } }] },
              },
            ],
          },
        ],
      },
    },
  },
}

test('findTweetNodes locates tweets without knowing the response path', () => {
  const nodes = findTweetNodes(timelineResponse)
  assert.equal(nodes.length, 1, 'exactly one tweet in the fixture')
  assert.equal((nodes[0] as { rest_id?: string }).rest_id, '1899000000000000123')
})

test('tweetToItem builds a complete item and prefers untruncated text', () => {
  const item = tweetToItem(tweet as never)
  assert.ok(item, 'item was produced')
  assert.equal(item!.url, 'https://x.com/karpathy/status/1899000000000000123')
  assert.equal(item!.source, 'x')
  assert.equal(item!.sourceId, '1899000000000000123')

  // note_tweet must win over legacy.full_text.
  assert.ok(item!.content!.startsWith('The full untruncated body'))
  assert.ok(!item!.content!.includes('truncated version'))

  // t.co links are expanded and the trailing self-link is dropped.
  assert.ok(item!.content!.includes('https://example.com/real-article'))
  assert.ok(!item!.content!.includes('t.co/xyz'))

  assert.equal(item!.author?.handle, 'karpathy')
  assert.equal(item!.author?.name, 'Andrej Karpathy')
  assert.equal(item!.author?.followers, 1_240_000)
  assert.equal(item!.author?.verified, true)

  assert.equal(item!.metrics?.likes, 18_400)
  assert.equal(item!.metrics?.bookmarks, 9_800)
  // views arrives as a string and must be coerced.
  assert.equal(item!.metrics?.views, 2_140_000)

  assert.equal(item!.media?.length, 1)
  assert.equal(item!.media?.[0]?.width, 1600)
  assert.equal(item!.media?.[0]?.alt, 'A chart')

  assert.equal(item!.publishedAt, Date.parse('Wed Jul 29 09:14:00 +0000 2026'))
  // A long post that is the root of its own conversation reads as a thread.
  assert.equal(item!.kind, 'thread')
  // The title is the first substantial line, not a blind truncation.
  assert.ok(item!.title.length <= 200)
})

test('itemsFromGraphql deduplicates and survives junk input', () => {
  const items = itemsFromGraphql(timelineResponse)
  assert.equal(items.length, 1)

  // Same tweet twice in one response (common with pinned + timeline).
  const doubled = { a: timelineResponse, b: timelineResponse }
  assert.equal(itemsFromGraphql(doubled).length, 1, 'deduplicated by url')

  for (const junk of [null, undefined, 42, 'string', [], {}, { data: null }]) {
    assert.deepEqual(itemsFromGraphql(junk), [], `no crash on ${JSON.stringify(junk)}`)
  }
})

test('itemsFromGraphql rejects tweets with no usable text', () => {
  const empty = { legacy: { id_str: '1', full_text: '   ' } }
  assert.deepEqual(itemsFromGraphql(empty), [])
})

test('a quoted tweet is captured as its own item', () => {
  const withQuote = {
    ...tweet,
    quoted_status_result: {
      result: {
        rest_id: '1899000000000000999',
        core: { user_results: { result: { legacy: { screen_name: 'simonw', name: 'Simon Willison' } } } },
        legacy: { id_str: '1899000000000000999', full_text: 'The quoted post says something worth keeping.' },
      },
    },
  }
  const items = itemsFromGraphql(withQuote)
  const urls = items.map((i) => i.url)
  assert.ok(urls.includes('https://x.com/karpathy/status/1899000000000000123'))
  assert.ok(urls.includes('https://x.com/simonw/status/1899000000000000999'), 'quoted tweet captured too')
})

test('X_OPERATIONS matches the endpoints we care about and not others', () => {
  assert.ok(X_OPERATIONS.test('https://x.com/i/api/graphql/AbC123/HomeTimeline'))
  assert.ok(X_OPERATIONS.test('/i/api/graphql/xYz/TweetDetail?variables=%7B%7D'))
  assert.ok(X_OPERATIONS.test('/i/api/graphql/q/Bookmarks'))
  assert.ok(!X_OPERATIONS.test('https://x.com/i/api/graphql/AbC/CreateTweet'))
  assert.ok(!X_OPERATIONS.test('https://x.com/i/api/1.1/jot/client_event.json'))
  assert.ok(!X_OPERATIONS.test('https://abs.twimg.com/responsive-web/client-web/main.js'))
})

/* -------------------------------------------------------- Xiaohongshu ---- */

const note = {
  note_id: '67f0a1b2c3d4e5f607182930',
  type: 'normal',
  title: 'M4 Max 128G 本地跑 DeepSeek-V4 量化版实测',
  desc: '折腾了一周，终于把量化版跑通了，直接上数据。短上下文 18.4 tok/s。',
  time: 1_785_000_000,
  user: {
    user_id: '5f8a1b2c000000000101abcd',
    nickname: '硅基漫游者',
    avatar: 'https://sns-avatar.xhscdn.com/avatar/abc.jpg',
  },
  interact_info: {
    liked_count: '3240',
    collected_count: '1.2万',
    comment_count: '286',
    share_count: '412',
  },
  image_list: [{ url: 'https://sns-img.xhscdn.com/abc' }, { url: 'https://sns-img.xhscdn.com/def' }],
}

const feedResponse = {
  code: 0,
  success: true,
  data: {
    items: [
      { id: 'ignored-wrapper', model_type: 'note', note_card: note },
      { id: 'another-wrapper', model_type: 'note', note_card: { ...note, note_id: '67f0a1b2c3d4e5f607182931', title: '第二篇' } },
    ],
  },
}

test('findNoteNodes locates notes inside the feed envelope', () => {
  const nodes = findNoteNodes(feedResponse)
  assert.equal(nodes.length, 2)
})

test('noteToItem normalises ids, Chinese counts and timestamps', () => {
  const item = noteToItem(note as never)
  assert.ok(item)
  assert.equal(item!.url, 'https://www.xiaohongshu.com/explore/67f0a1b2c3d4e5f607182930')
  assert.equal(item!.source, 'xiaohongshu')
  assert.equal(item!.lang, 'zh')
  assert.equal(item!.author?.name, '硅基漫游者')

  assert.equal(item!.metrics?.likes, 3240)
  // "1.2万" must become 12000, not NaN and not 1.2.
  assert.equal(item!.metrics?.collects, 12_000)
  assert.equal(item!.metrics?.comments, 286)

  // Seconds are promoted to milliseconds.
  assert.equal(item!.publishedAt, 1_785_000_000_000)
  assert.equal(item!.media?.length, 2)
  assert.ok(item!.content!.includes('折腾了一周'))
})

test('itemsFromState handles the whole envelope and junk alike', () => {
  const items = itemsFromState(feedResponse)
  assert.equal(items.length, 2)
  assert.equal(new Set(items.map((i) => i.url)).size, 2)

  for (const junk of [null, undefined, 0, '', [], {}, { data: { items: null } }]) {
    assert.deepEqual(itemsFromState(junk), [], `no crash on ${JSON.stringify(junk)}`)
  }
})

test('a note with no title or body is rejected', () => {
  assert.equal(noteToItem({ note_id: '67f0a1b2c3d4e5f607182930', type: 'normal' } as never), null)
})

test('an id that is not a note id is rejected', () => {
  assert.equal(noteToItem({ note_id: 'not-hex', title: 'x' } as never), null)
})

test('XHS_ENDPOINTS matches the note APIs only', () => {
  assert.ok(XHS_ENDPOINTS.test('/api/sns/web/v1/feed'))
  assert.ok(XHS_ENDPOINTS.test('https://edith.xiaohongshu.com/api/sns/web/v1/homefeed'))
  assert.ok(XHS_ENDPOINTS.test('/api/sns/web/v1/search/notes'))
  assert.ok(!XHS_ENDPOINTS.test('/api/sns/web/v1/login/status'))
  assert.ok(!XHS_ENDPOINTS.test('/api/store/jpd/main'))
})

/* --------------------------------------------------------- shared safety -- */

test('walkers terminate on deeply nested and cyclic input', () => {
  // A cycle would hang a naive recursive walker.
  const cyclic: Record<string, unknown> = { name: 'root' }
  cyclic.self = cyclic
  cyclic.child = { parent: cyclic, legacy: { id_str: '5', full_text: 'A real tweet inside a cycle' } }
  const items = itemsFromGraphql(cyclic)
  assert.equal(items.length, 1, 'found the tweet without looping forever')

  // Deeper than the depth guard: should return nothing rather than throw.
  let deep: Record<string, unknown> = { legacy: { id_str: '9', full_text: 'too deep to reach' } }
  for (let i = 0; i < 40; i++) deep = { nest: deep }
  assert.doesNotThrow(() => itemsFromGraphql(deep))
})
