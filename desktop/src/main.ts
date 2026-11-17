/**
 * The RPIT desktop app: an Electron shell around the normal web app.
 *
 * The API server (bundled into dist/server) runs in an Electron utility process, listening on 127.0.0.1 on a
 * free port, with its SQLite database and uploads in the user's app-data folder. The window loads the web app
 * from that server, so the app behaves exactly like the browser version (same origin, cookies, real-time events).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  session,
  shell,
  utilityProcess,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = "RPIT";
const isMac = process.platform === "darwin";
const smokeTest = process.env.RPIT_DESKTOP_SMOKE === "1";

app.setName(APP_NAME);
// One folder for dev and packaged builds alike: %APPDATA%\RPIT, ~/Library/Application Support/RPIT or
// ~/.config/RPIT. RPIT_DATA_DIR moves it (the smoke test uses a temporary folder).
app.setPath("userData", process.env.RPIT_DATA_DIR || path.join(app.getPath("appData"), APP_NAME));
const dataDir = path.join(app.getPath("userData"), "data");
const logFile = path.join(app.getPath("userData"), "logs", "server.log");

let server: UtilityProcess | null = null;
let origin: string | null = null;
let quitting = false;

/** Starts the API server and resolves with its origin once it's listening. */
function startServer(): Promise<string> {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} RPIT ${app.getVersion()} ---\n`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  Object.assign(env, {
    NODE_ENV: "production",
    // Only this machine can reach the server.
    HOST: "127.0.0.1",
    PORT: "0",
    // Always the local SQLite file, even if the user's environment points the web server elsewhere.
    DATABASE_URL: "",
    DATABASE_PATH: path.join(dataDir, "rpit.db"),
    UPLOADS_DIR: path.join(dataDir, "uploads"),
    WEB_DIST: path.join(here, "web"),
  });

  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(here, "server", "index.js"), [], {
      serviceName: `${APP_NAME} server`,
      stdio: "pipe",
      env,
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    server = child;
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error("The server didn't start within 60 seconds."));
      child.kill();
    }, 60_000);

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        log.write(chunk);
        if (!app.isPackaged) process.stdout.write(chunk);
      });
    }
    child.on("message", (message: { type?: string; port?: number }) => {
      if (message?.type !== "ready" || ready) return;
      ready = true;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${message.port}`);
    });
    child.once("exit", (code) => {
      server = null;
      log.end(`--- server exited with code ${code} ---\n`);
      clearTimeout(timer);
      if (!ready) reject(new Error(`The server stopped while starting (exit code ${code}).`));
      else if (!quitting) {
        dialog.showErrorBox(`${APP_NAME} stopped`, `The ${APP_NAME} server stopped unexpectedly.\n\nDetails: ${logFile}`);
        app.quit();
      }
    });
  });
}

/** Asks the server to close the database and exit; kills it if it takes too long. */
function stopServer(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage("shutdown");
  });
}

const isAppUrl = (url: string) => {
  try {
    return origin !== null && new URL(url).origin === origin;
  } catch {
    return false;
  }
};

/** Links that leave the app open in the user's browser (web links and email only). */
function openExternal(url: string) {
  try {
    if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    // Not a URL: ignore.
  }
}

function createWindow(url: string) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    // Matches --bg in web/src/styles.css, so there's no white flash before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#12171e" : "#eef1f5",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.once("ready-to-show", () => {
    if (!smokeTest) win.show();
  });
  void win.loadURL(url);
  return win;
}

function buildMenu() {
  const appMenu: MenuItemConstructorOptions[] = isMac ? [{ role: "appMenu" }] : [];
  const helpMenu: MenuItemConstructorOptions[] = isMac ? [] : [{ role: "help", submenu: [{ role: "about" }] }];
  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        { label: "Open data folder", click: () => void shell.openPath(dataDir) },
        { label: "Open server log", click: () => void shell.openPath(logFile) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...helpMenu,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every page and window the app creates stays on the local server; anything else goes to the browser.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

/** RPIT_DESKTOP_SMOKE=1: sign up through the app's own window, check the session works, then quit. */
async function runSmokeTest(win: BrowserWindow) {
  let ok = false;
  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.once("did-finish-load", () => resolve());
      win.webContents.once("did-fail-load", (_e, code, description) => reject(new Error(`${code} ${description}`)));
    });
    const result = (await win.webContents.executeJavaScript(`(async () => {
      const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const register = await post("/api/auth/register", { name: "Smoke Test", email: "smoke@rpit.test", password: "smoke-test-password" });
      const me = await fetch("/api/auth/me");
      const project = await post("/api/projects", { name: "Smoke project" });
      return { title: document.title, root: !!document.getElementById("root"), register: register.status, me: me.status, project: project.status };
    })()`)) as Record<string, unknown>;
    console.log(`Smoke test: ${JSON.stringify(result)}`);
    ok = result.root === true && result.register === 201 && result.me === 200 && result.project === 201;
  } catch (err) {
    console.error("Smoke test failed:", err);
  }
  quitting = true;
  await stopServer();
  console.log(ok ? "Smoke test passed" : "Smoke test FAILED");
  app.exit(ok ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  // Another window is already running against the same database: it gets focus instead (see second-instance).
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (!isMac || smokeTest) app.quit();
  });

  app.on("before-quit", (event) => {
    if (!server) return;
    // Let the server close the database cleanly first, then quit for real.
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopServer().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    // The app asks for no browser permissions except writing to the clipboard.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
    );
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
    buildMenu();

    try {
      origin = await startServer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (smokeTest) console.error(message);
      else dialog.showErrorBox(`${APP_NAME} could not start`, `${message}\n\nDetails: ${logFile}`);
      app.exit(1);
      return;
    }

    const win = createWindow(origin);
    if (smokeTest) return void runSmokeTest(win);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && origin) createWindow(origin);
    });
  });
}
