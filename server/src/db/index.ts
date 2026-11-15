import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";

/**
 * Uses Node's built-in SQLite (node:sqlite) so there is no native module
 * to compile on install. The API is synchronous, like better-sqlite3.
 */
export type DB = DatabaseSync;

export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Callbacks queued by `afterCommit` while a transaction is open, per connection. */
const pendingCommit = new WeakMap<DB, (() => void)[]>();

/** Run `fn` inside a transaction; rolls back if it throws. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  const queued: (() => void)[] = [];
  pendingCommit.set(db, queued);
  let result: T;
  try {
    result = fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    pendingCommit.delete(db);
  }
  for (const cb of queued) cb();
  return result;
}

/**
 * Run `cb` once the current transaction commits (dropped if it rolls back),
 * or immediately when no transaction is open. Used to publish real-time
 * events only for changes that were actually saved.
 */
export function afterCommit(db: DB, cb: () => void) {
  const queued = pendingCommit.get(db);
  if (queued) queued.push(cb);
  else cb();
}

export function migrate(db: DB) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = current; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
