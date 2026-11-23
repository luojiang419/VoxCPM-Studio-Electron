const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { resolveManagedPython } = require("./runtime-service");

app.whenReady().then(() => {
  const session = process.argv[process.argv.indexOf("--voxcpm-updater") + 1];
  const settings = JSON.parse(fs.readFileSync(path.join(session, "session.json"), "utf8"));
  const win = new BrowserWindow({ width: 580, height: 300, resizable: false, title: "JVOX Studio配音系统 更新器",
    autoHideMenuBar: true, backgroundColor: "#111318", webPreferences: { nodeIntegration: false, contextIsolation: true } });
  let finished = false;
  win.on("close", (event) => { if (!finished) event.preventDefault(); });
  const loaded = win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{background:#181817;color:#eee;font:16px 'Microsoft YaHei',sans-serif;margin:36px}h2{font-size:23px}progress{width:100%;height:18px;accent-color:#f6a66d}p{line-height:1.6;color:#aaa69d}</style><h2>正在更新 JVOX Studio配音系统</h2><p id="message">正在准备独立更新器…</p><progress id="progress" max="100" value="0"></progress><p>请保持此窗口打开，完成后软件会自动启动。</p></html>`));
  const python = settings.pythonExecutable || resolveManagedPython(settings.root) || path.join(settings.root, "runtime", "python", "python.exe");
  const worker = spawn(python, ["-u", path.join(session, "updater.py"), session], {
    cwd: session, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(session, "updater.log"), { flags: "a" });
  let buffer = "";
  worker.stdout.on("data", async (chunk) => {
    log.write(chunk); buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/); buffer = lines.pop();
    for (const line of lines) {
      try {
        const state = JSON.parse(line);
        await loaded;
        if (!win.isDestroyed()) await win.webContents.executeJavaScript(`document.getElementById('message').textContent=${JSON.stringify(state.message)};document.getElementById('progress').value=${Number(state.progress) || 0}`);
      } catch { /* 非进度输出仅保存在日志中。 */ }
    }
  });
  worker.stderr.pipe(log, { end: false });
  async function finish(code, error) {
    if (finished) return;
    finished = true; log.end();
    if (code !== 0) {
      let status = {};
      try { status = JSON.parse(fs.readFileSync(path.join(session, "status.json"), "utf8")); } catch { /* Python 可能尚未启动。 */ }
      const message = error || status.message || `更新器退出（${code}）`;
      const result = { ...status, status: status.status === "rolled-back" ? "rolled-back" : "error", message,
        session, finishedAt: Date.now() / 1000 };
      fs.writeFileSync(path.join(session, "status.json"), JSON.stringify(result));
      fs.writeFileSync(settings.resultPath || path.join(settings.root, "data/cache/updates/last-result.json"), JSON.stringify(result));
      error = message;
    }
    if (code !== 0) await dialog.showMessageBox(win, { type: "error", title: "更新未完成",
      message: "更新未完成，原版本已保留或恢复。", detail: `${error || "请查看更新日志"}\n${path.join(session, "updater.log")}` });
    app.quit();
  }
  worker.once("error", (error) => finish(1, error.message));
  worker.once("exit", (code) => finish(code));
});
