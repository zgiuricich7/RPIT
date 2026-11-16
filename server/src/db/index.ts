import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { migrations, pgMigrations } from "./migrations.ts";

/**
 * The database behind a small async interface, so the same hand-written SQL
 * runs on SQLite (node:sqlite, the zero-setup default) and Postgres (`pg` for a
 * server, or PGlite: Postgres compiled to WASM, in-process).
 *
 * SQL uses `?` placeholders (converted to `$1…` for Postgres). Keep it portable:
 * `lower(x)` instead of COLLATE NOCASE, `ON CONFLICT DO NOTHING` instead of
 * INSERT OR IGNORE, `IS DISTINCT FROM` instead of IS NOT, `CAST(? AS TEXT)` for
 * untyped parameters in SELECT lists, an alias on every derived table. Where the
 * dialects really differ, branch on `db.dialect` (see the helpers in repo.ts).
 *
 * Transactions follow the async call chain: while `db.transaction(fn)` runs,
 * every query made through `db` from inside `fn` (including helpers that closed
 * over `db`) goes to the transaction. Other requests don't see it until commit.
 */

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | Uint8Array;
export type Dialect = "sqlite" | "postgres";

export interface DB {
  readonly dialect: Dialect;
  /** The database the app opened; transactions hand out handles that share it (event hubs etc. key on this). */
  readonly root: DB;
  all<T = Row>(sql: string, ...params: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  /** Run a script of several statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` in a transaction with a handle to use for every query inside it.
   * Rolls back if `fn` throws. Called on a transaction handle, it just runs `fn`
   * in the same transaction.
   */
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  /** Run `cb` after the current transaction commits (dropped on rollback); immediately outside a transaction. */
  afterCommit(cb: () => void): void;
  close(): Promise<void>;
}

/** Run `fn` inside a transaction (see DB.transaction). */
export const transaction = <T>(db: DB, fn: (tx: DB) => Promise<T>) => db.transaction(fn);

/** Run `cb` once the current transaction commits, or now when there is none. */
export const afterCommit = (db: DB, cb: () => void) => db.afterCommit(cb);

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// SQLite

class SqliteDB implements DB {
  readonly dialect = "sqlite" as const;
  readonly root: SqliteDB;
  private readonly statements = new Map<string, StatementSync>();
  /** While a transaction runs, callers outside it wait (node:sqlite has one connection). */
  private busy: Promise<void> | null = null;
  /** The transaction handle for the current async call chain, if any. */
  private readonly active = new AsyncLocalStorage<SqliteDB>();

  constructor(
    private readonly raw: DatabaseSync,
    root?: SqliteDB,
    private readonly pending?: (() => void)[],
  ) {
    this.root = root ?? this;
  }

  private stmt(sql: string) {
    const cache = this.root.statements;
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = this.raw.prepare(sql)));
    return s;
  }
  /** The handle to use: the caller's transaction if they're inside one. */
  private get current(): SqliteDB {
    return this.pending ? this : (this.root.active.getStore() ?? this);
  }
  /** Queries outside a transaction wait for one in progress, so they don't land inside it. */
  private async turn(): Promise<SqliteDB> {
    const db = this.current;
    if (!db.pending) while (this.root.busy) await this.root.busy;
    return db;
  }

  async all<T = Row>(sql: string, ...params: Param[]) {
    return (await this.turn()).stmt(sql).all(...(params as SQLInputValue[])) as T[];
  }
  async get<T = Row>(sql: string, ...params: Param[]) {
    return (await this.turn()).stmt(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }
  async run(sql: string, ...params: Param[]) {
    return { changes: Number((await this.turn()).stmt(sql).run(...(params as SQLInputValue[])).changes) };
  }
  async exec(sql: string) {
    await this.turn();
    this.raw.exec(sql);
  }

  async transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
    const cur = this.current;
    if (cur.pending) return fn(cur);
    const root = this.root;
    while (root.busy) await root.busy;
    let release!: () => void;
    root.busy = new Promise((r) => (release = r));
    const queued: (() => void)[] = [];
    let result: T;
    try {
      this.raw.exec("BEGIN");
      try {
        const tx = new SqliteDB(this.raw, root, queued);
        result = await root.active.run(tx, () => fn(tx));
        this.raw.exec("COMMIT");
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    } finally {
      root.busy = null;
      release();
    }
    for (const cb of queued) cb();
    return result;
  }

  afterCommit(cb: () => void) {
    const cur = this.current;
    if (cur.pending) cur.pending.push(cb);
    else cb();
  }

  async close() {
    this.raw.close();
  }
}

// ---------------------------------------------------------------------------
// Postgres (pg Pool or PGlite)

/** `?` placeholders → `$1, $2…`, skipping quoted strings. */
export function toPgParams(sql: string): string {
  let n = 0;
  let out = "";
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "?") {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The little we need from a Postgres connection, so `pg` and PGlite look the same. */
interface PgConn {
  query(sql: string, params: Param[]): Promise<{ rows: Row[]; changes: number }>;
  exec(sql: string): Promise<void>;
}
interface PgDriver extends PgConn {
  /** Run `fn` with a connection inside BEGIN … COMMIT (ROLLBACK if it throws). */
  transaction<T>(fn: (conn: PgConn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PostgresDB implements DB {
  readonly dialect = "postgres" as const;
  readonly root: PostgresDB;
  /** The transaction handle for the current async call chain, if any. */
  private readonly active = new AsyncLocalStorage<PostgresDB>();

  constructor(
    private readonly driver: PgDriver,
    private readonly conn: PgConn = driver,
    root?: PostgresDB,
    private readonly pending?: (() => void)[],
  ) {
    this.root = root ?? this;
  }

  /** The connection to use: the caller's transaction if they're inside one. */
  private get current(): PostgresDB {
    return this.pending ? this : (this.root.active.getStore() ?? this);
  }

  async all<T = Row>(sql: string, ...params: Param[]) {
    return (await this.current.conn.query(toPgParams(sql), params)).rows as T[];
  }
  async get<T = Row>(sql: string, ...params: Param[]) {
    return (await this.all<T>(sql, ...params))[0];
  }
  async run(sql: string, ...params: Param[]) {
    return { changes: (await this.current.conn.query(toPgParams(sql), params)).changes };
  }
  async exec(sql: string) {
    await this.current.conn.exec(sql);
  }

  async transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
    const cur = this.current;
    if (cur.pending) return fn(cur);
    const queued: (() => void)[] = [];
    const root = this.root;
    const result = await this.driver.transaction((conn) => {
      const tx = new PostgresDB(this.driver, conn, root, queued);
      return root.active.run(tx, () => fn(tx));
    });
    for (const cb of queued) cb();
    return result;
  }

  afterCommit(cb: () => void) {
    const cur = this.current;
    if (cur.pending) cur.pending.push(cb);
    else cb();
  }

  close() {
    return this.driver.close();
  }
}

async function pgDriver(url: string): Promise<PgDriver> {
  const { default: pg } = await import("pg");
  // COUNT(*) and other int8 results: numbers, as on SQLite (our counts never approach 2^53).
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({ connectionString: url });
  const conn = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }> }): PgConn => ({
    query: async (sql, params) => {
      const r = await c.query(sql, params);
      return { rows: r.rows, changes: r.rowCount ?? 0 };
    },
    exec: async (sql) => {
      await c.query(sql);
    },
  });
  return {
    ...conn(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(conn(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir: string | undefined): Promise<PgDriver> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(dataDir);
  type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>; exec: (s: string) => Promise<unknown> };
  const conn = (c: Q): PgConn => ({
    query: async (sql, params) => {
      const r = await c.query(sql, params);
      return { rows: r.rows as Row[], changes: r.affectedRows ?? 0 };
    },
    exec: async (sql) => {
      await c.exec(sql);
    },
  });
  return {
    ...conn(db),
    transaction: (fn) => db.transaction((tx) => fn(conn(tx))),
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------

/**
 * Open the database named by `url`:
 * - `postgres://…` / `postgresql://…`: a Postgres server (`pg` connection pool);
 * - `pglite:<folder>` or `pglite:memory`: embedded Postgres (PGlite), no server needed;
 * - anything else: a SQLite file path, or `:memory:`.
 * Runs pending migrations before returning.
 */
export async function openDatabase(url: string): Promise<DB> {
  let db: DB;
  if (/^postgres(ql)?:\/\//.test(url)) {
    db = new PostgresDB(await pgDriver(url));
  } else if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length);
    db = new PostgresDB(await pgliteDriver(dir && dir !== "memory" ? dir : undefined));
  } else {
    if (url !== ":memory:") fs.mkdirSync(path.dirname(url), { recursive: true });
    const raw = new DatabaseSync(url);
    if (url !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("PRAGMA busy_timeout = 5000");
    db = new SqliteDB(raw);
  }
  await migrate(db);
  return db;
}

/** Wrap an already-open node:sqlite database (migration tests build old schemas by hand). */
export const fromSqlite = (raw: DatabaseSync): DB => new SqliteDB(raw);

/**
 * Apply pending migrations. SQLite tracks its version with PRAGMA user_version;
 * Postgres in a `schema_version` table. The two lists are separate (Postgres
 * starts from a schema equal to SQLite's after migration 14); add new
 * migrations to both.
 */
export async function migrate(db: DB) {
  if (db.dialect === "sqlite") {
    const { user_version: current } = (await db.get<{ user_version: number }>("PRAGMA user_version"))!;
    for (let v = current; v < migrations.length; v++) {
      await db.transaction(async (tx) => {
        await tx.exec(migrations[v]!);
        await tx.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    return;
  }
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = await db.get<{ version: number }>(`SELECT MAX(version) AS version FROM schema_version`);
  for (let v = row?.version ?? 0; v < pgMigrations.length; v++) {
    await db.transaction(async (tx) => {
      await tx.exec(pgMigrations[v]!);
      await tx.run(`INSERT INTO schema_version (version) VALUES (?)`, v + 1);
    });
  }
}
