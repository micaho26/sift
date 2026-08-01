/**
 * SQLite access layer over Node 24's built-in `node:sqlite`.
 *
 * Zero native dependencies — no node-gyp, no prebuild download, no "works on my
 * machine". The trade-off is a slightly rawer API than better-sqlite3, so this
 * module adds the ergonomics we actually use: typed row helpers, a statement
 * cache, and a transaction wrapper.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { DB_PATH, ensureDirs } from '../config.ts'
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from './sql.ts'

export type Row = Record<string, unknown>

let db: DatabaseSync | null = null
const statementCache = new Map<string, StatementSync>()

/**
 * Pragmas, in the order they must run.
 *
 * WAL is the important one: it lets the connector scheduler write while the UI
 * reads, which otherwise produces SQLITE_BUSY on every poll. `synchronous=NORMAL`
 * is the standard WAL pairing — durable across process crashes, and only at risk
 * from an OS-level power loss, which is an acceptable trade for a news cache.
 */
const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  // 64 MiB page cache (negative = KiB) — the whole hot index fits in memory.
  'PRAGMA cache_size = -65536',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA mmap_size = 268435456',
  'PRAGMA auto_vacuum = INCREMENTAL',
]

export function getDb(): DatabaseSync {
  if (db) return db
  ensureDirs()
  db = new DatabaseSync(DB_PATH, { allowExtension: false })
  for (const pragma of PRAGMAS) {
    try {
      db.exec(pragma)
    } catch {
      // A pragma an older SQLite build rejects is not fatal.
    }
  }
  migrate(db)
  return db
}

function migrate(conn: DatabaseSync): void {
  conn.exec(SCHEMA_SQL)
  const current = Number((conn.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0)
  let version = current
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    conn.exec('BEGIN')
    try {
      conn.exec(migration.sql)
      conn.exec(`PRAGMA user_version = ${migration.version}`)
      conn.exec('COMMIT')
      version = migration.version
    } catch (error) {
      conn.exec('ROLLBACK')
      throw new Error(`Migration ${migration.version} failed: ${(error as Error).message}`)
    }
  }
  if (version < SCHEMA_VERSION) conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** Prepared-statement cache. SQLite parsing shows up in profiles without it. */
export function prep(sql: string): StatementSync {
  const cached = statementCache.get(sql)
  if (cached) return cached
  const stmt = getDb().prepare(sql)
  statementCache.set(sql, stmt)
  return stmt
}

export type SqlValue = string | number | bigint | null | Uint8Array

/** Coerce JS values into what node:sqlite accepts as a bound parameter. */
function bindable(value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint' || typeof value === 'string') return value
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  // Objects and arrays are stored as JSON text.
  return JSON.stringify(value)
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return prep(sql).all(...params.map(bindable)) as T[]
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return prep(sql).get(...params.map(bindable)) as T | undefined
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const result = prep(sql).run(...params.map(bindable))
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  }
}

export function exec(sql: string): void {
  getDb().exec(sql)
}

/** Single scalar, e.g. `pluck<number>('SELECT count(*) FROM items')`. */
export function pluck<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
  const row = get<Row>(sql, ...params)
  if (!row) return undefined
  const values = Object.values(row)
  return values.length ? (values[0] as T) : undefined
}

let txDepth = 0

/**
 * Run `fn` in a transaction. Nested calls use SAVEPOINTs, so a repository
 * function can be transactional on its own *and* participate in a larger batch
 * without knowing which situation it is in.
 */
export function transaction<T>(fn: () => T): T {
  const conn = getDb()
  const isOuter = txDepth === 0
  const savepoint = `sp_${txDepth}`
  conn.exec(isOuter ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
  txDepth++
  try {
    const result = fn()
    txDepth--
    conn.exec(isOuter ? 'COMMIT' : `RELEASE ${savepoint}`)
    return result
  } catch (error) {
    txDepth--
    try {
      conn.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
    } catch {
      // Already unwound by SQLite (e.g. a fatal statement error).
    }
    throw error
  }
}

/** JSON column read that never throws on corrupt data. */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function dbSizeBytes(): number {
  try {
    let total = statSync(DB_PATH).size
    for (const suffix of ['-wal', '-shm']) {
      try {
        total += statSync(`${DB_PATH}${suffix}`).size
      } catch {
        // Absent when not in WAL mode or freshly checkpointed.
      }
    }
    return total
  } catch {
    return 0
  }
}

/** Reclaim space and refresh query-planner statistics. */
export function maintenance(): void {
  const conn = getDb()
  try {
    conn.exec('PRAGMA incremental_vacuum')
    conn.exec('PRAGMA optimize')
    conn.exec("INSERT INTO items_fts(items_fts) VALUES('optimize')")
  } catch {
    // Best-effort.
  }
}

export function closeDb(): void {
  statementCache.clear()
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // Fine if the connection is already unusable.
    }
    db.close()
    db = null
  }
}

/** Crash-safe id: time-ordered prefix + random suffix, URL-safe and sortable. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0')
  const rand = Math.trunc(Math.random() * 0x100000000)
    .toString(36)
    .padStart(7, '0')
  const extra = Math.trunc(Math.random() * 0x10000)
    .toString(36)
    .padStart(4, '0')
  return `${prefix}${time}${rand}${extra}`
}
