const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voxcpmDesktop", {
  getBootstrapState: () => ipcRenderer.invoke("runtime:get-bootstrap-state"),
  startBackend: () => ipcRenderer.invoke("runtime:start-backend"),
  stopBackend: () => ipcRenderer.invoke("runtime:stop-backend"),
  getResourceStats: () => ipcRenderer.invoke("runtime:get-resource-stats"),
  setThemeSource: (themeSource) => ipcRenderer.invoke("runtime:set-theme-source", themeSource),
  openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
  saveDialog: (options) => ipcRenderer.invoke("dialog:save", options),
  openExternal: (targetUrl) => ipcRenderer.invoke("shell:open-external", targetUrl),
  openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke("shell:show-item-in-folder", targetPath),
  onRuntimeEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("runtime:event", listener);
    return () => ipcRenderer.removeListener("runtime:event", listener);
  },
});
