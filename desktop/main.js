// Verlaut Desktop — schlanker, gehärteter Electron-Container um die self-hosted
// PWA. Lädt ausschließlich die eigene Server-Origin (HTTPS, Secure Context),
// damit Kamera/Mikrofon/Sprachnachrichten funktionieren. Keine Analytics.
const { app, BrowserWindow, session, shell } = require("electron");

// Build-Zeit-Default (per build.sh gesetzt); via VERLAUT_URL überschreibbar.
const SERVER_URL = process.env.VERLAUT_URL || "@@SERVER_URL@@";

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    backgroundColor: "#0b0f14",
    title: "Verlaut",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Kamera/Mikrofon für die eigene Origin freigeben, sonst nichts.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === "media");
  });

  // Externe Links im System-Browser öffnen, nicht in der App.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin !== new URL(SERVER_URL).origin) {
        shell.openExternal(url);
        return { action: "deny" };
      }
    } catch (_) {}
    return { action: "allow" };
  });

  win.loadURL(SERVER_URL);
}

app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => app.quit());
