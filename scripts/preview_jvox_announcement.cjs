// 独立设计预览：不载入主程序、用户数据或更新服务。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setName("JVOX Studio配音系统 · 更名公告预览");
app.setPath("userData", path.resolve(__dirname, "../builds/jvox-announcement-preview/user-data"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1160, height: 860, minWidth: 480, minHeight: 560,
    title: "JVOX Studio配音系统 · 更名更新预览", autoHideMenuBar: true,
    icon: path.resolve(__dirname, "../frontend/voxcpm_studio_electron/app.ico"), backgroundColor: "#f1ede6",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  await win.loadFile(path.resolve(__dirname, "../frontend/voxcpm_studio_electron/dist/index.html"), { query: { preview: "jvox-announcement" } });
});
app.on("window-all-closed", () => app.quit());
