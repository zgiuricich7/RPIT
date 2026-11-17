import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (built): server/ is one level up.
export const SERVER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

const databasePath = process.env.DATABASE_PATH ?? path.join(SERVER_ROOT, "data", "rpit.db");
/**
 * DATABASE_URL picks the database: `postgres://…` for a Postgres server,
 * `pglite:<folder>` for embedded Postgres, or unset for the SQLite file at
 * DATABASE_PATH (the default).
 */
const databaseUrl = process.env.DATABASE_URL || databasePath;

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** Interface to listen on; unset means every interface. The desktop app uses 127.0.0.1. */
  host: process.env.HOST || undefined,
  databasePath,
  databaseUrl,
  /** For logs: the URL without its password. */
  databaseLabel: databaseUrl.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@"),
  isProduction: process.env.NODE_ENV === "production",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Attachment files. Defaults to an "uploads" folder next to the database. */
  uploadsDir: process.env.UPLOADS_DIR ?? path.join(path.dirname(databasePath), "uploads"),
  /** The built web app served in production (the desktop app ships its own copy). */
  webDist: process.env.WEB_DIST ?? path.join(REPO_ROOT, "web", "dist"),
};
