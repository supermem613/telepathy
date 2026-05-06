// Electron shell + wall server for telepathy.
//
// This process owns BOTH the BrowserWindow and the local HTTP+WS wall
// server, so the launching CLI (`telepathy app`) can exit immediately
// — the window's lifecycle is now self-contained. Closing the window
// closes the server too.
//
// Args (forwarded by `telepathy app`):
//   --token=TLP1.…    (zero or more) — pre-link these peers on launch
//
// SAFETY: stdout/stderr go nowhere when the launcher uses
// detached:true + stdio:"ignore". Crash-time diagnostics get appended
// to %APPDATA%/telepathy/launch.log so the next launch can surface
// them. Don't write secrets there — we only log lifecycle events and
// error strings.

const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const argv = process.argv.slice(2);
const tokens = argv
  .filter((a) => a.startsWith("--token="))
  .map((a) => a.slice("--token=".length))
  .filter(Boolean);

// Stable app name → predictable userData dir (%APPDATA%/telepathy on
// Windows). Without this, Electron falls back to "Electron" which mixes
// our cache with every other Electron app on the system.
app.setName("telepathy");

const LOG_PATH = path.join(app.getPath("userData"), "launch.log");
function diag(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch { /* best-effort */ }
  // Also goes to stderr if anyone's listening.
  try { process.stderr.write(`[telepathy-electron] ${msg}\n`); } catch { /* ignore */ }
}
diag(`starting pid=${process.pid} tokens=${tokens.length}`);

let mainWindow = null;

async function startWallServer() {
  // Dynamically import the compiled ESM modules from dist/. Electron's
  // main process is CommonJS by default, but dynamic import() works fine
  // for ESM. file:// URLs avoid Windows path-separator quirks.
  const apiUrl = pathToFileURL(path.join(__dirname, "..", "dist", "core", "api.js")).href;
  const viewerUrl = pathToFileURL(path.join(__dirname, "..", "dist", "core", "viewer.js")).href;
  const api = await import(apiUrl);
  const viewer = await import(viewerUrl);

  for (const token of tokens) {
    try {
      const r = await api.connectPeer({ token });
      diag(`pre-linked peer ${r.alias} at ${r.remoteAddr}`);
    } catch (err) {
      diag(`pre-link failed: ${err && err.message ? err.message : String(err)}`);
    }
  }

  await viewer.startViewer();
  const url = viewer.getViewerUrl("/wall");
  if (!url) {
    throw new Error("startViewer did not return a URL");
  }
  diag(`wall url ready: ${url}`);
  return url;
}

function createWindow(url) {
  diag("createWindow");
  // Sized for a comfortable 132×40-ish terminal at 13px font with a
  // little chrome budget. Copilot CLI's TUI sets minimum useful sizes
  // around this; smaller windows clip its bottom-anchored prompt bar.
  //
  // minWidth/minHeight are sized so a Copilot CLI / vim / similar TUI
  // ALWAYS has enough viewport for its bottom-anchored chrome to render
  // (~100 cols × ~28 rows at 13px Nerd Font ≈ 800×580 incl. tab strip).
  // We never let the user shrink below this; the bidirectional PTY-size
  // sync means the host TUI would otherwise reflow into a too-small box
  // and the prompt bar would draw off-screen.
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    center: true,
    title: "telepathy",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    diag(`did-fail-load url=${url} code=${code} desc=${desc}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    diag(`renderer crashed: ${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    diag("did-finish-load");
    if (!mainWindow) {
      return;
    }
    // Aggressive foreground sequence: show, restore from minimized,
    // moveTop (Windows-specific bring-to-z-top), focus, brief alwaysOnTop.
    mainWindow.show();
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (typeof mainWindow.moveTop === "function") {
      mainWindow.moveTop();
    }
    mainWindow.focus();
    if (process.platform === "win32") {
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.setAlwaysOnTop(false);
        }
      }, 300);
    }
  });

  mainWindow.loadURL(url);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("http")) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: app.name, submenu: [{ role: "quit" }] }] : []),
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    ...(isMac ? [] : [{ label: "File", submenu: [{ role: "quit" }] }]),
  ]));
}

app.whenReady().then(async () => {
  diag("whenReady");
  buildMenu();
  let url;
  try {
    url = await startWallServer();
  } catch (err) {
    diag(`startWallServer failed: ${err && err.message ? err.message : String(err)}`);
    app.quit();
    return;
  }
  createWindow(url);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(url);
    }
  });
});

app.on("window-all-closed", () => {
  // No matter the platform — we're a single-window utility app.
  // Closing the window stops the wall server (this whole process exits).
  app.quit();
});
