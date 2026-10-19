const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voxcpmDesktop", {
  getWindowBehavior: () => ipcRenderer.invoke("window:behavior"),
  setWindowBehavior: (behavior) => ipcRenderer.invoke("window:set-behavior", behavior),
  requestWindowClose: () => ipcRenderer.invoke("window:request-close"),
  resolveWindowClose: (options) => ipcRenderer.invoke("window:resolve-close", options),
  cancelWindowClose: () => ipcRenderer.invoke("window:cancel-close"),
  rendererReady: () => ipcRenderer.invoke("runtime:renderer-ready"),
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  setAutoCheckUpdate: (enabled) => ipcRenderer.invoke("update:auto-check", enabled),
  getBootstrapState: () => ipcRenderer.invoke("runtime:get-bootstrap-state"),
  startBackend: (options) => ipcRenderer.invoke("runtime:start-backend", options),
  getPreparationState: () => ipcRenderer.invoke("runtime:preparation-state"),
  cancelPreparation: () => ipcRenderer.invoke("runtime:cancel-preparation"),
  getComponents: () => ipcRenderer.invoke("components:state"),
  selectComponents: (value) => ipcRenderer.invoke("components:select", value),
  removeComponent: (id) => ipcRenderer.invoke("components:remove", id),
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
