// Electron shell for the telepathy wall viewer.
//
// Loads the URL passed on the command line as --url=<url>. The viewer
// itself runs in the parent telepathy process; this window is just a
// chromeless frame around the existing wall.html.

const { app, BrowserWindow, Menu, shell } = require("electron");

const argv = process.argv.slice(2);
const urlArg = argv.find((a) => a.startsWith("--url="));
if (!urlArg) {
  console.error("telepathy-electron: missing --url=<viewer-url>");
  process.exit(2);
}
const url = urlArg.slice("--url=".length);

// Stable app name → predictable userData dir (%APPDATA%/telepathy on
// Windows). Without this, Electron falls back to "Electron" which mixes
// our cache with every other Electron app on the system.
app.setName("telepathy");

// Single-instance lock: if another telepathy window is already open,
// focus it instead of stacking up another (off-screen) Electron process.
const gotLock = app.requestSingleInstanceLock({ url });
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

function createWindow() {
  // center:true is mandatory on multi-monitor setups — without it
  // Electron can place the window at out-of-range coordinates if any
  // attached monitor uses negative coords (e.g. one to the left/above
  // the primary). The user just sees nothing because the window is
  // technically open but on a virtual screen they can't reach.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    center: true,
    title: "telepathy",
    backgroundColor: "#0a0d12",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[telepathy] failed to load ${validatedURL}: ${errorDescription} (code ${errorCode})`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[telepathy] renderer crashed: ${details.reason} (exitCode ${details.exitCode})`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow) {
      return;
    }
    mainWindow.focus();
    if (process.platform === "win32") {
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.setAlwaysOnTop(false);
        }
      }, 200);
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

app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
  // Another `telepathy app` invocation. Surface the existing window;
  // re-point it at the new URL if a different token was minted.
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    if (process.platform === "win32") {
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.setAlwaysOnTop(false);
        }
      }, 200);
    }
    if (additionalData && typeof additionalData.url === "string") {
      const current = mainWindow.webContents.getURL();
      if (additionalData.url !== current) {
        mainWindow.loadURL(additionalData.url);
      }
    }
  }
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
