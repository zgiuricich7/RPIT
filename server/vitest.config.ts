import { defineConfig } from "vitest/config";

/**
 * The server suite runs once per database: SQLite (in-memory) and Postgres
 * (PGlite, in-process, so no server is needed). See test/db.ts.
 *   npx vitest run --project sqlite     # just one of them
 */
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "sqlite", env: { RPIT_TEST_DB: "sqlite" } } },
      {
        extends: true,
        test: { name: "postgres", env: { RPIT_TEST_DB: "pglite" }, testTimeout: 20_000, hookTimeout: 60_000 },
      },
    ],
  },
});
