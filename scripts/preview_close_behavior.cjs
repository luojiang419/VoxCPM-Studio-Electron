// 真实 Electron 窗口 / 托盘 / IPC / 持久化演示，复用生产代码，不启动生成与更新服务。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const frontend = path.resolve(__dirname, "../frontend/voxcpm_studio_electron");
const { WindowBehavior } = require(path.join(frontend, "window-behavior.js"));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const demoRoot = path.resolve(option("demo-root") || path.resolve(__dirname, "../builds/close-behavior-preview"));
fs.mkdirSync(demoRoot, { recursive: true });
app.setName("JVOX Studio配音系统 · 退出行为演示");
app.setPath("userData", path.join(demoRoot, "profile"));
let window, behavior;
function writeState() {
  fs.writeFileSync(path.join(demoRoot, "state.json"), JSON.stringify({ pid: process.pid,
    visible: !!window && !window.isDestroyed() && window.isVisible(),
    tray: !!behavior?.tray && !behavior.tray.isDestroyed(), ...behavior?.state() }, null, 2));
}
app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  behavior = new WindowBehavior({ dataRoot: demoRoot, icon: path.join(frontend, "app.ico"), onEvent: (type, payload) => {
    if (window && !window.isDestroyed()) window.webContents.send("runtime:event", { type, ...payload });
    writeState();
  } });
  behavior.registerIpc();
  window = new BrowserWindow({ width: 1160, height: 850, minWidth: 440, minHeight: 460,
    title: "JVOX Studio配音系统 · 退出行为演示", autoHideMenuBar: true, show: false,
    icon: path.join(frontend, "app.ico"), backgroundColor: "#fafafa",
    webPreferences: { preload: path.join(frontend, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  behavior.attach(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.once("ready-to-show", () => { window.show(); writeState(); });
  window.on("hide", writeState); window.on("show", writeState);
  // 仅验证进程提供文件控制，调用实际托盘菜单回调；普通演示没有此测试通道。
  if (process.argv.includes("--validation")) {
    const timer = setInterval(() => {
      const commandFile = path.join(demoRoot, "command.json");
      if (!fs.existsSync(commandFile)) return;
      const command = JSON.parse(fs.readFileSync(commandFile)); fs.unlinkSync(commandFile);
      if (command.action === "restore") behavior.tray?.emit("double-click");
      if (command.action === "tray-quit") behavior.trayMenu?.items.find(item => item.label === "退出软件").click();
      if (command.action === "app-quit") app.quit();
      if (command.action === "close") window.close();
      if (command.action === "resize") window.setContentSize(command.width, command.height);
      writeState();
    }, 80); timer.unref();
  }
  await window.loadFile(path.join(frontend, "dist/index.html"), { query: { preview: "window-behavior" } });
  if (process.argv.includes("--show-dialog")) behavior.requestPrompt();
});
app.on("second-instance", () => behavior?.restore());
app.on("window-all-closed", () => app.quit());
