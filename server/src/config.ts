import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (built): server/ is one level up.
export const SERVER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

const databasePath = process.env.DATABASE_PATH ?? path.join(SERVER_ROOT, "data", "rpit.db");

export const config = {
  port: Number(process.env.PORT ?? 3001),
  databasePath,
  isProduction: process.env.NODE_ENV === "production",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Attachment files. Defaults to an "uploads" folder next to the database. */
  uploadsDir: process.env.UPLOADS_DIR ?? path.join(path.dirname(databasePath), "uploads"),
  webDist: path.join(REPO_ROOT, "web", "dist"),
};
