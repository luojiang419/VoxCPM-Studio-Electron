/* 真实魔搭 -> 旧版测试副本 -> 下载 -> 独立更新器 -> 重启健康检查。 */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const assert = require("assert/strict");
const { UpdateService, digest } = require("../frontend/voxcpm_studio_electron/update-service");
const root = path.resolve(__dirname, "..");
const original = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1"));
const testRoot = path.join(root, "builds", "update-smoke-" + Date.now());
const fromVersion = process.argv.includes("--same-version") ? "2.0.2" : "2.0.1";
const lightweight = process.argv.includes("--lightweight");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeClient;
async function until(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await sleep(500);
  }
  throw new Error("测试等待超时：" + (last?.message || "条件未满足"));
}
async function cdp(port) {
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return pages.find((page) => page.type === "page");
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

(async () => {
  fs.mkdirSync(testRoot, { recursive: true });
  for (const entry of fs.readdirSync(original, { withFileTypes: true })) {
    if (entry.isFile() || ["locales", "resources", "app"].includes(entry.name)) {
      fs.cpSync(path.join(original, entry.name), path.join(testRoot, entry.name), { recursive: true });
    }
  }
  // 大型固定资源共享只读目录；更新器白名单禁止写入这些目录。
  for (const directory of ["runtime", "models", "ffmpeg"]) {
    if (lightweight && directory === "runtime") {
      const source = path.join(root, "builds/bootstrap-validation/runtime/managed/py312-cu126"), target = path.join(testRoot, "runtime/managed/py312-cu126");
      fs.mkdirSync(path.join(target, "Lib"), { recursive: true });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) if (entry.isFile() && /\.(exe|dll|pyd|zip|_pth|json)$/.test(entry.name)) fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
      fs.symlinkSync(path.join(source, "Lib/site-packages"), path.join(target, "Lib/site-packages"), "junction");
    } else if (lightweight && directory === "models") fs.symlinkSync(path.resolve(root, "../models"), path.join(testRoot, directory), "junction");
    else if (fs.existsSync(path.join(original, directory))) fs.symlinkSync(path.join(original, directory), path.join(testRoot, directory), "junction");
  }
  const appDir = path.join(testRoot, "resources/app");
  const packagePath = path.join(appDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath)); pkg.version = fromVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  const configPath = path.join(appDir, "update-config.json");
  const config = JSON.parse(fs.readFileSync(configPath)); config.releaseId = "00000000000000";
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const sentinel = path.join(testRoot, "data", "config", "update-test-user-data.txt");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, "用户配置、音频和模型不得被升级覆盖");
  const dataHash = await digest(sentinel);
  const modelConfig = path.join(testRoot, fs.existsSync(path.join(testRoot, "models/config.json")) ? "models/config.json" : "models/openbmb__VoxCPM2/config.json");
  const modelHash = await digest(modelConfig);
  console.log("测试副本：" + testRoot);
  const exe = path.join(testRoot, "VoxCPM Studio.exe");
  const child = spawn(exe, ["--voxcpm-run", "--remote-debugging-port=19228"], { cwd: testRoot, windowsHide: true, stdio: "ignore" });
  const client = await cdp(19228);
  activeClient = client;
  await until(async () => client.evaluate("Boolean(window.voxcpmDesktop && document.querySelector('button'))"));
  console.log("旧版界面已渲染");
  const boot = await until(async () => {
    const state = await client.evaluate("window.voxcpmDesktop.getBootstrapState()");
    if (state.status === "error") throw new Error(state.detail);
    return state.backendRunning && state.status === "ready" && state;
  }, 180000);
  console.log("旧版本地 API 已就绪：" + boot.backendBaseUrl);
  await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='设置').click()");
  await until(async () => client.evaluate("document.body.innerText.includes('软件更新')"));
  const state = await client.evaluate("window.voxcpmDesktop.checkUpdate()");
  assert.equal(state.status, "available", JSON.stringify(state));
  assert.equal(state.latestVersion, "2.0.2");
  assert.equal(await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存设置').disabled"), false,
    "更新状态事件不能覆盖已有后端连接状态");
  console.log("魔搭检查更新成功：" + fromVersion + " -> " + state.latestVersion);
  await client.evaluate("window.voxcpmDesktop.setAutoCheckUpdate(false)");
  assert.equal((await client.evaluate("window.voxcpmDesktop.getUpdateState()")).autoCheck, false);
  await client.evaluate("window.voxcpmDesktop.setAutoCheckUpdate(true)");
  const downloaded = await client.evaluate("window.voxcpmDesktop.downloadUpdate()");
  assert.equal(downloaded.status, "downloaded", JSON.stringify(downloaded));
  assert.equal(await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存设置').disabled"), false);
  await until(async () => client.evaluate("document.body.innerText.includes('重启并安装')"));
  const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(testRoot, "settings-before-update.png"), Buffer.from(screenshot.data, "base64"));
  console.log("设置页版本、更新说明、下载和自动检查开关已验证");
  client.close();
  activeClient = null;
  // 使用同一更新会话启动独立更新器；绕开交互确认仅用于自动化冒烟测试。
  const cache = path.join(testRoot, "data/cache/updates");
  const session = fs.readdirSync(cache).filter((name) => name.startsWith("session-")).sort().at(-1);
  const service = new UpdateService({ root: testRoot, dataRoot: path.join(testRoot, "data"), appDir, currentVersion: fromVersion });
  service.session = path.join(cache, session); service.state.status = "downloaded";
  await service.launch();
  // 主进程在生产中调用 app.quit；测试通过 taskkill 关闭本次测试进程树。
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  const statusPath = path.join(service.session, "status.json");
  const result = await until(() => {
    if (!fs.existsSync(statusPath)) return false;
    const status = JSON.parse(fs.readFileSync(statusPath));
    if (status.status === "error") throw new Error(status.message);
    return status.status === "complete" && status;
  }, 240000);
  assert.equal(result.version, "2.0.2");
  assert.equal(JSON.parse(fs.readFileSync(packagePath)).version, "2.0.2");
  assert.equal(await digest(sentinel), dataHash);
  assert.equal(await digest(modelConfig), modelHash);
  if (lightweight) assert.ok(fs.readFileSync(path.join(testRoot, "data/cache/runtime-bootstrap.log"), "utf8").includes("已复用验证通过的本地环境"), "更新重启未复用已验证运行时");
  const backendState = JSON.parse(fs.readFileSync(path.join(testRoot, "data/cache/electron_backend_state.json")));
  const health = await (await fetch(backendState.serviceUrl + "/api/health")).json();
  const report = { result: "passed", fromVersion, toVersion: "2.0.2", testRoot, session: service.session,
    userDataPreserved: true, modelPreserved: true, restartedBackend: backendState.serviceUrl, health };
  fs.writeFileSync(path.join(testRoot, "smoke-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // 测试进程通过退出关闭；正式便携包与原有服务不受影响。
  const processes = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const items = JSON.parse(processes.stdout || "[]");
  for (const item of Array.isArray(items) ? items : [items]) if (item.ExecutablePath?.toLowerCase() === exe.toLowerCase()) {
    spawnSync("taskkill", ["/PID", String(item.ProcessId), "/T", "/F"], { windowsHide: true });
  }
})().catch((error) => {
  activeClient?.close();
  console.error(error); process.exitCode = 1;
  const processes = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const items = JSON.parse(processes.stdout || "[]");
  const exe = path.join(testRoot, "VoxCPM Studio.exe").toLowerCase();
  for (const item of Array.isArray(items) ? items : [items]) if (item.ExecutablePath?.toLowerCase() === exe) {
    spawnSync("taskkill", ["/PID", String(item.ProcessId), "/T", "/F"], { windowsHide: true });
  }
});
