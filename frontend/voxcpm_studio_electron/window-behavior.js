const { app, Tray, Menu, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { atomicJson } = require("./update-service");

const BEHAVIORS = ["quit", "background", "ask"];

// 主程序和独立演示共用：窗口关闭、磁盘偏好及托盘执行同一套逻辑。
class WindowBehavior {
  constructor({ dataRoot, icon, onEvent = () => {} }) {
    this.settingsPath = path.join(dataRoot, "config", "window-behavior.json");
    this.icon = icon;
    this.onEvent = onEvent;
    this.behavior = "ask";
    this.promptOpen = false;
    this.quitting = false;
    this.tray = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      if (BEHAVIORS.includes(saved.behavior)) this.behavior = saved.behavior;
    } catch { /* 首次使用或无效配置均重新询问，不静默退出。 */ }
    app.on("before-quit", () => { this.quitting = true; this.destroyTray(); });
  }

  state() { return { behavior: this.behavior, promptOpen: this.promptOpen }; }

  emit(type = "window-behavior-changed") { this.onEvent(type, { windowBehavior: this.state() }); }

  save(behavior) {
    if (!BEHAVIORS.includes(behavior)) throw new Error("无效的窗口退出行为");
    atomicJson(this.settingsPath, { behavior });
    this.behavior = behavior;
    this.emit();
    return this.state();
  }

  attach(window) {
    this.window = window;
    window.on("close", event => {
      // 更新安装、显式 app.quit() 和系统关机不再弹出偏好确认。
      if (this.quitting) return;
      if (window.webContents.isCrashed() || window.webContents.getURL().startsWith("data:")) {
        this.quit(); return;
      }
      event.preventDefault();
      if (this.behavior === "quit") this.quit();
      else if (this.behavior === "background") {
        try { this.background(); }
        catch { this.requestPrompt("系统托盘暂不可用，请选择关闭软件或取消。"); }
      } else this.requestPrompt();
    });
    window.on("query-session-end", () => { this.quitting = true; });
    window.on("closed", () => { this.window = null; this.destroyTray(); });
    window.webContents.on("did-finish-load", () => { if (this.promptOpen) this.emit("window-close-requested"); });
  }

  requestPrompt(error = "") {
    this.promptOpen = true;
    this.onEvent("window-close-requested", { windowBehavior: this.state(), error });
  }

  cancel() { this.promptOpen = false; this.emit(); return this.state(); }

  resolve({ behavior, action } = {}) {
    if (!this.promptOpen) throw new Error("没有待确认的退出操作");
    if (!BEHAVIORS.includes(behavior) || !["quit", "background"].includes(action) ||
        (behavior !== "ask" && behavior !== action)) throw new Error("退出选项不匹配");
    // 托盘就绪与偏好写入均成功才关闭窗口；失败保留模态供重试/取消。
    if (action === "background") this.ensureTray();
    this.save(behavior);
    this.promptOpen = false;
    this.emit();
    if (action === "background") this.background();
    else setImmediate(() => this.quit());
    return this.state();
  }

  restore() {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show(); this.window.focus();
  }

  ensureTray() {
    if (this.tray && !this.tray.isDestroyed()) return;
    const tray = new Tray(this.icon);
    try {
      tray.setToolTip("JVOX Studio配音系统 · 后台运行中");
      const menu = Menu.buildFromTemplate([
        { label: "打开 JVOX Studio", click: () => this.restore() },
        { type: "separator" },
        { label: "退出软件", click: () => this.quit() },
      ]);
      tray.setContextMenu(menu);
      tray.on("double-click", () => this.restore());
      this.tray = tray;
      this.trayMenu = menu;
    } catch (error) { tray.destroy(); throw error; }
  }

  background() { this.ensureTray(); this.window.hide(); }
  quit() { this.quitting = true; app.quit(); }
  destroyTray() { this.tray?.destroy(); this.tray = null; this.trayMenu = null; }

  registerIpc() {
    const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => {
      if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("仅主窗口可以修改退出行为");
      }
      return fn(...args);
    });
    handle("window:behavior", () => this.state());
    handle("window:set-behavior", behavior => this.save(behavior));
    handle("window:request-close", () => { this.window.close(); return true; });
    handle("window:resolve-close", options => this.resolve(options));
    handle("window:cancel-close", () => this.cancel());
  }
}

module.exports = { WindowBehavior };
