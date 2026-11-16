import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { startReminderScheduler } from "./reminders.ts";
import { sweepOrphanUploads } from "./uploads.ts";

const db = await openDatabase(config.databaseUrl);
const app = createApp(db, { staticDir: config.isProduction ? config.webDist : undefined });

const stopReminders = startReminderScheduler(db);
const swept = await sweepOrphanUploads(db);
if (swept) console.log(`Removed ${swept} orphaned attachment file(s)`);

const server = app.listen(config.port, () => {
  console.log(`RPIT API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databaseLabel}`);
  console.log(`Uploads: ${config.uploadsDir}`);
});

const shutdown = () => {
  stopReminders();
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
  // Open event streams (and idle keep-alive sockets) would otherwise keep close() waiting forever.
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
