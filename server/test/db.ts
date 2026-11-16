import { afterAll } from "vitest";
import { openDatabase, type DB } from "../src/db/index.ts";

/**
 * Test databases. The suite runs twice (see vitest.config.ts): against SQLite
 * (in-memory, a new one per test) and against Postgres via PGlite. Starting
 * PGlite takes about a second, so in Postgres mode each test file shares one
 * instance and `freshDb()` empties it before every test.
 */
export const testDialect: "sqlite" | "postgres" = process.env.RPIT_TEST_DB === "pglite" ? "postgres" : "sqlite";
export const onSqlite = testDialect === "sqlite";

const url = onSqlite ? ":memory:" : "pglite:memory";
let shared: DB | undefined;
const extra: DB[] = [];

afterAll(async () => {
  for (const db of extra.splice(0)) await db.close();
  await shared?.close();
  shared = undefined;
});

/** Empty every table (keeping the schema and migration version). */
async function truncateAll(db: DB) {
  const tables = await db.all<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'schema_version'`,
  );
  // TRUNCATE doesn't fire the activity log's row triggers, so the append-only log can be cleared here.
  await db.exec(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** A clean, migrated database for one test. */
export async function freshDb(): Promise<DB> {
  if (onSqlite) return openDatabase(url);
  shared ??= await openDatabase(url);
  await truncateAll(shared);
  return shared;
}

/** A second, independent database (closed after the file's tests). */
export async function isolatedDb(): Promise<DB> {
  const db = await openDatabase(url);
  if (!onSqlite) extra.push(db);
  return db;
}
