/**
 * Database schema.
 *
 * Design notes worth knowing before changing anything here:
 *
 *  - `items` is the only table with a hot write path, so it carries no triggers
 *    beyond FTS maintenance and keeps JSON blobs for the shapes that are read
 *    whole (author, metrics, media) and normalised tables for the shapes that
 *    are *queried* (tags, topics, entities). Storing tags as JSON would make
 *    "all items tagged X" a full scan.
 *
 *  - FTS5 uses an external-content table so text is stored once. The `cjk`
 *    column holds Chinese bigrams generated in application code, because
 *    `unicode61` treats a whole Chinese sentence as a single token and would
 *    make Chinese search silently return nothing.
 *
 *  - `item_bands` implements SimHash LSH: four 16-bit bands per item. Two
 *    fingerprints within Hamming distance 3 must collide on at least one band,
 *    so this index gives complete recall for near-duplicate lookup with one
 *    indexed query instead of a full scan.
 */

export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = /* sql */ `
-- ─────────────────────────────────────────────────────────────── items ──
CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  url_hash      TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,
  source_id     TEXT,
  kind          TEXT NOT NULL DEFAULT 'post',

  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT,
  content       TEXT,
  lang          TEXT,

  author_json   TEXT,
  author_handle TEXT,
  author_name   TEXT,
  metrics_json  TEXT,
  media_json    TEXT,

  published_at  INTEGER,
  captured_at   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  score         REAL NOT NULL DEFAULT 0,
  score_json    TEXT,

  state         TEXT NOT NULL DEFAULT 'inbox',
  starred       INTEGER NOT NULL DEFAULT 0,
  read_at       INTEGER,
  reading_time  INTEGER NOT NULL DEFAULT 0,

  simhash       TEXT,
  duplicate_of  TEXT,
  echo_count    INTEGER NOT NULL DEFAULT 0,

  ai_summary      TEXT,
  ai_translation  TEXT,
  ai_takeaways    TEXT,

  embedding     BLOB,
  embed_model   TEXT,

  raw_json      TEXT
);

-- The feed's default query is "state = ? ORDER BY score DESC", so that pair
-- gets a covering-ish composite index rather than two single-column ones.
CREATE INDEX IF NOT EXISTS idx_items_state_score    ON items(state, score DESC);
CREATE INDEX IF NOT EXISTS idx_items_state_pub      ON items(state, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source         ON items(source, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_captured       ON items(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_published      ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_author         ON items(author_handle);
CREATE INDEX IF NOT EXISTS idx_items_source_native  ON items(source, source_id);
CREATE INDEX IF NOT EXISTS idx_items_duplicate_of   ON items(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_items_starred        ON items(starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_items_unread         ON items(read_at) WHERE read_at IS NULL;

-- ──────────────────────────────────────────────────── full-text search ──
-- External content: FTS reads text from items via rowid, so nothing is stored
-- twice. The cjk column is app-generated Chinese bigrams (see notes above).
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title,
  body,
  author,
  tags,
  cjk,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

-- Maps an FTS rowid back to an item id. FTS5 rowids are integers; our ids are
-- text, so we need the join table rather than content_rowid.
CREATE TABLE IF NOT EXISTS fts_map (
  rowid   INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fts_map_item ON fts_map(item_id);

-- ───────────────────────────────────────────────── near-duplicate index ──
CREATE TABLE IF NOT EXISTS item_bands (
  band    TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (band, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_bands_item ON item_bands(item_id);

-- ──────────────────────────────────────────────────── tags and topics ──
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag);

CREATE TABLE IF NOT EXISTS item_topics (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  topic   TEXT NOT NULL,
  PRIMARY KEY (item_id, topic)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_item_topics_topic ON item_topics(topic);

CREATE TABLE IF NOT EXISTS item_entities (
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_item_entities_name ON item_entities(name);
CREATE INDEX IF NOT EXISTS idx_item_entities_type ON item_entities(type);

-- ──────────────────────────────────────────────────────── collections ──
CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  color       TEXT,
  smart_query TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  note          TEXT,
  position      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_collection_items_item ON collection_items(item_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_order ON collection_items(collection_id, position);

-- ───────────────────────────────────────────────────────── highlights ──
CREATE TABLE IF NOT EXISTS highlights (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  note         TEXT,
  color        TEXT NOT NULL DEFAULT 'yellow',
  start_offset INTEGER,
  end_offset   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_item ON highlights(item_id, created_at);

-- ─────────────────────────────────────────────────────── saved views ──
CREATE TABLE IF NOT EXISTS saved_searches (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  query_json   TEXT NOT NULL,
  icon         TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  alerting     INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0
);

-- ──────────────────────────────────────────────────────────── sources ──
CREATE TABLE IF NOT EXISTS sources (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  name             TEXT NOT NULL,
  target           TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  trust            REAL NOT NULL DEFAULT 1,
  filters_json     TEXT,
  last_run_at      INTEGER,
  last_error       TEXT,
  items_collected  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled, last_run_at);

-- ──────────────────────────────────────────────────────────── digests ──
CREATE TABLE IF NOT EXISTS digests (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  period_from  INTEGER NOT NULL,
  period_to    INTEGER NOT NULL,
  lede         TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  item_ids     TEXT NOT NULL,
  generator    TEXT NOT NULL DEFAULT 'template',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at DESC);

-- ─────────────────────────────────── author stats (revealed preference) ──
-- Drives the authority term: how often you actually keep this author's work.
CREATE TABLE IF NOT EXISTS author_stats (
  handle    TEXT PRIMARY KEY,
  name      TEXT,
  source    TEXT,
  seen      INTEGER NOT NULL DEFAULT 0,
  saved     INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  followers INTEGER,
  updated_at INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────── key/value settings ──
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ───────────────────────────────────────────────────── activity ledger ──
-- Local-only analytics. Never leaves the machine; powers the reading stats.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  item_id TEXT,
  meta    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts DESC);
`

/**
 * Migrations run in order, each wrapped in a transaction. Version 1 is the
 * base schema above; later entries are additive DDL. Never edit a shipped
 * migration — append a new one.
 */
export const MIGRATIONS: { version: number; sql: string }[] = []
