// Runs the built desktop app with Electron: `node scripts/electron.mjs` opens it, `--smoke` runs the smoke test
// (signs up in a temporary data folder, checks the session, and exits 0 or 1).
//
// Terminals inside VS Code (itself Electron) set ELECTRON_RUN_AS_NODE=1, which would make Electron run as
// plain Node and fail on `import { app } from "electron"`, so it's removed here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(desktopDir, "dist", "main.js"))) {
  console.error("The desktop app isn't built yet: run `npm run build:desktop` from the repo root.");
  process.exit(1);
}

const smoke = process.argv.includes("--smoke");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let tmp;
if (smoke) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rpit-desktop-smoke-"));
  Object.assign(env, { RPIT_DESKTOP_SMOKE: "1", RPIT_DATA_DIR: tmp });
}

const child = spawn(String(electron), [desktopDir], { env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(signal ? 1 : (code ?? 1));
});
