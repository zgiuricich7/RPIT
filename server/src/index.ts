import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { startReminderScheduler } from "./reminders.ts";
import { sweepOrphanUploads } from "./uploads.ts";

/**
 * Set when the desktop app runs this server in an Electron utility process: the channel to the main process.
 * We tell it which port we got ("ready") and it asks us to stop ("shutdown") before the app quits.
 */
const parentPort = (
  process as {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: "message", listener: (e: { data: unknown }) => void): void;
    };
  }
).parentPort;

const db = await openDatabase(config.databaseUrl);
const app = createApp(db, { staticDir: config.isProduction ? config.webDist : undefined });

const stopReminders = startReminderScheduler(db);
const swept = await sweepOrphanUploads(db);
if (swept) console.log(`Removed ${swept} orphaned attachment file(s)`);

// Express 5 calls this with the error if listening fails (e.g. the port is taken).
const onListening = (err?: Error) => {
  if (err) {
    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  }
  const { port } = server.address() as AddressInfo;
  console.log(`RPIT API listening on http://${config.host ?? "localhost"}:${port}`);
  console.log(`Database: ${config.databaseLabel}`);
  console.log(`Uploads: ${config.uploadsDir}`);
  parentPort?.postMessage({ type: "ready", port });
};
const server = config.host ? app.listen(config.port, config.host, onListening) : app.listen(config.port, onListening);

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
parentPort?.on("message", (e) => {
  if (e.data === "shutdown") shutdown();
});
