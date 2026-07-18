/**
 * Electron main process — the "app shell."
 *
 * Electron bundles its own copy of Node.js, so people who install wmux
 * never need to install Node, run npm, or see PowerShell. This file:
 *   - starts the wmux server (server.js) inside the app
 *   - opens the dashboard in a desktop window
 *   - keeps a tray icon (bottom-right, by the clock) so closing the
 *     window hides the app instead of killing your agents
 *   - provides the native "Browse…" folder picker to the dashboard
 */

const path = require("path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  ipcMain,
  Notification,
  nativeImage,
} = require("electron");

// Windows ties toast notifications to this ID; must match build.appId.
app.setAppUserModelId("com.wmux.app");

// Only one wmux at a time — a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let quitting = false;
  let hideNoticeShown = false;

  // Workspace state (the list that survives restarts) lives in the standard
  // per-user app-data folder, e.g. C:\Users\you\AppData\Roaming\wmux
  process.env.WMUX_DATA = app.getPath("userData");

  const { start } = require(path.join(__dirname, "..", "server.js"));
  const iconPng = path.join(__dirname, "..", "build", "icon.png");

  function createWindow(port) {
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 560,
      backgroundColor: "#101318",
      autoHideMenuBar: true,
      icon: iconPng,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
      },
    });
    win.loadURL(`http://127.0.0.1:${port}`);

    // Closing the window hides it; agents keep running. Quit from the tray.
    win.on("close", (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
      if (!hideNoticeShown && Notification.isSupported()) {
        hideNoticeShown = true;
        new Notification({
          title: "wmux is still running",
          body: "Your agents keep working. Right-click the tray icon (by the clock) to quit.",
        }).show();
      }
    });
  }

  function createTray() {
    tray = new Tray(nativeImage.createFromPath(iconPng).resize({ width: 16, height: 16 }));
    tray.setToolTip("wmux — agents running");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open wmux", click: () => win && win.show() },
        { type: "separator" },
        {
          label: "Quit (stops native-mode agents)",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on("click", () => win && win.show());
  }

  // The dashboard's "Browse…" button lands here.
  ipcMain.handle("pick-folder", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose a repository folder",
      properties: ["openDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("app-version", () => app.getVersion());

  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    const port = await start(); // tries 7777, falls back to a free port
    createWindow(port);
    createTray();

    // Auto-update: a no-op until you publish releases on GitHub
    // (see the "publish" section in package.json and the README).
    if (app.isPackaged) {
      try {
        require("electron-updater").autoUpdater.checkForUpdatesAndNotify();
      } catch {
        /* not configured yet — fine */
      }
    }
  });

  // Keep running in the tray even with the window closed.
  app.on("window-all-closed", () => {});
}
