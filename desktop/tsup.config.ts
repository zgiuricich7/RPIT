import fs from "node:fs";
import { defineConfig } from "tsup";

const banner = {
  // The server bundle inlines CommonJS packages (express, bcryptjs…) that call require(); ESM has no require
  // of its own, so give the bundle one.
  js: `import { createRequire as __rpitCreateRequire } from "node:module"; const require = __rpitCreateRequire(import.meta.url);`,
};

export default defineConfig([
  {
    // The Electron main process.
    entry: { main: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "node24",
    outDir: "dist",
    sourcemap: true,
    removeNodeProtocol: false,
    external: ["electron"],
  },
  {
    // The API server, bundled with every dependency so the packaged app needs no node_modules. It runs in an
    // Electron utility process and always uses SQLite, so the Postgres drivers (loaded lazily) stay out.
    entry: { index: "../server/src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node24",
    outDir: "dist/server",
    sourcemap: true,
    removeNodeProtocol: false,
    noExternal: [/^(?!pg$|@electric-sql\/pglite)/],
    external: ["pg", "@electric-sql/pglite"],
    banner,
    async onSuccess() {
      // Ship the built web app next to the server (built first by `npm run build`).
      if (!fs.existsSync("../web/dist/index.html")) throw new Error("Build the web app first (npm run build -w web)");
      fs.rmSync("dist/web", { recursive: true, force: true });
      fs.cpSync("../web/dist", "dist/web", { recursive: true });
    },
  },
]);
