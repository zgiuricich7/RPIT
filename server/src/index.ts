import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { startReminderScheduler } from "./reminders.ts";

const db = openDatabase(config.databasePath);
const app = createApp(db, { staticDir: config.isProduction ? config.webDist : undefined });

const stopReminders = startReminderScheduler(db);

const server = app.listen(config.port, () => {
  console.log(`RPIT API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
});

const shutdown = () => {
  stopReminders();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Open event streams (and idle keep-alive sockets) would otherwise keep close() waiting forever.
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
