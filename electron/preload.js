// The safe bridge between the dashboard webpage and the desktop app.
// The page can only call what's listed here — nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wmuxNative", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  version: () => ipcRenderer.invoke("app-version"),
});
