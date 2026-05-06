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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    title: "telepathy",
    backgroundColor: "#0a0d12",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(url);
  // Open external links (e.g. clicked help links) in the system browser
  // rather than navigating away from the viewer.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("http")) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

// Minimal app menu — Electron's default menu pulls in lots of irrelevant
// items. Just keep Cmd/Ctrl-Q (quit) and view-related shortcuts.
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
