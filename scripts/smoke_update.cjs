/* 真实魔搭 -> 旧版测试副本 -> 下载 -> 独立更新器 -> 重启健康检查。 */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const assert = require("assert/strict");
const { UpdateService, digest } = require("../frontend/voxcpm_studio_electron/update-service");
const root = path.resolve(__dirname, "..");
const original = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1"));
const testRoot = path.join(root, "builds", "update-smoke-" + Date.now());
const targetVersion = JSON.parse(fs.readFileSync(path.join(root, "frontend/voxcpm_studio_electron/package.json"))).version;
const preserveIdentity = process.argv.includes("--preserve-installed-identity");
const fromVersion = preserveIdentity ? JSON.parse(fs.readFileSync(path.join(original, "resources/app/package.json"))).version : process.argv.includes("--same-version") ? "2.0.2" : "2.0.1";
const lightweight = process.argv.includes("--lightweight");
const promptFlow = process.argv.includes("--prompt-flow");
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
    if (["allow-main-exit.json", "smoke-result.json", "settings-before-update.png", "standalone-updater.png"].includes(entry.name)) continue;
    if (entry.isFile() || ["locales", "resources", "app"].includes(entry.name)) {
      fs.cpSync(path.join(original, entry.name), path.join(testRoot, entry.name), { recursive: true,
        filter: source => !path.basename(source).startsWith("app-held-for-independence-test") });
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
  if (process.argv.includes("--fixed-client")) {
    const source = path.join(root, "frontend/voxcpm_studio_electron");
    for (const file of ["main.js", "update-service.js", "update-window.js"]) fs.copyFileSync(path.join(source, file), path.join(appDir, file));
    fs.cpSync(path.join(source, "dist"), path.join(appDir, "dist"), { recursive: true });
    // 故意破坏旧脚本，验证首次下载使用签名新版，不能沿用本机旧脚本。
    fs.writeFileSync(path.join(appDir, "updater.py"), "raise RuntimeError('旧更新器不应执行')\n");
  }
  const allowExitFile = path.join(testRoot, "allow-main-exit.json");
  fs.rmSync(allowExitFile, { force: true });
  if (process.argv.includes("--main-install")) {
    const mainPath = path.join(appDir, "main.js");
    // 仅在隔离夹具里确认弹窗并延迟退出，留出验证独立进程与移开旧文件的时间。
    const harness = `var __updateTestApp=require('electron').app,__updateTestDialog=require('electron').dialog,__updateTestFs=require('fs');
var __updateTestQuit=__updateTestApp.quit.bind(__updateTestApp),__updateTestPending=false;
__updateTestApp.quit=()=>{if(__updateTestPending)return;__updateTestPending=true;var t=setInterval(()=>{if(__updateTestFs.existsSync(${JSON.stringify(allowExitFile)})){clearInterval(t);__updateTestQuit();}},100);};
var __updateTestAsk=__updateTestDialog.showMessageBox.bind(__updateTestDialog);
__updateTestDialog.showMessageBox=(...args)=>['启动独立更新器','重启并更新'].includes(args.at(-1)?.title)?Promise.resolve({response:1}):__updateTestAsk(...args);
`;
    fs.writeFileSync(mainPath, harness + fs.readFileSync(mainPath, "utf8"));
  }
  const packagePath = path.join(appDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath)); pkg.version = fromVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  const configPath = path.join(appDir, "update-config.json");
  const config = JSON.parse(fs.readFileSync(configPath));
  if (!preserveIdentity) config.releaseId = "00000000000000";
  const manifestArgument = process.argv.indexOf("--manifest-url");
  if (manifestArgument >= 0) config.manifestUrl = process.argv[manifestArgument + 1];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const sentinel = path.join(testRoot, "data", "config", "update-test-user-data.txt");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, "用户配置、音频和模型不得被升级覆盖");
  const componentProfile = process.argv.includes("--empty-components") ? { selected: [], removed: ["heartmula"], defaultModel: "ace-xl-turbo" } : null;
  if (componentProfile) fs.writeFileSync(path.join(testRoot, "data/component-selection.json"), JSON.stringify(componentProfile));
  const dataHash = await digest(sentinel);
  const modelConfig = path.join(testRoot, fs.existsSync(path.join(testRoot, "models/config.json")) ? "models/config.json" : "models/openbmb__VoxCPM2/config.json");
  const modelHash = await digest(modelConfig);
  console.log("测试副本：" + testRoot);
  const exe = path.join(testRoot, fs.existsSync(path.join(testRoot, "JVOX Studio配音系统.exe")) ? "JVOX Studio配音系统.exe" : "VoxCPM Studio.exe");
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
  await client.evaluate('document.querySelector(".jvox-announcement .jvox-update")?.click()');
  await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='设置').click()");
  await until(async () => client.evaluate("document.body.innerText.includes('软件更新')"));
  await client.evaluate("Array.from(document.querySelectorAll('.settings-navigation button')).find(b=>b.textContent.includes('软件更新'))?.click()");
  if (promptFlow) await until(() => client.evaluate("window.voxcpmDesktop.getUpdateState().then(s=>s.promptOpen)"));
  const state = await client.evaluate("window.voxcpmDesktop.checkUpdate()");
  assert.equal(state.status, "available", JSON.stringify(state));
  assert.equal(state.latestVersion, targetVersion);
  assert.equal((await client.evaluate("window.voxcpmDesktop.getBootstrapState()")).backendRunning, true,
    "更新状态事件不能覆盖已有后端连接状态");
  console.log("魔搭检查更新成功：" + fromVersion + " -> " + state.latestVersion);
  await client.evaluate("window.voxcpmDesktop.setAutoCheckUpdate(false)");
  assert.equal((await client.evaluate("window.voxcpmDesktop.getUpdateState()")).autoCheck, false);
  await client.evaluate("window.voxcpmDesktop.setAutoCheckUpdate(true)");
  if (promptFlow) {
    const cache = path.join(testRoot, "data/cache/updates");
    assert.equal(fs.readdirSync(cache).filter(name=>name.startsWith('session-')).length, 0, '选择前不应下载或准备安装事务');
    const folder=await until(()=>fs.readdirSync(cache).filter(name=>name.startsWith('prompt-')).map(name=>path.join(cache,name)).find(folder=>fs.existsSync(path.join(folder,'prompt-ready.json'))));
    const prompt=JSON.parse(fs.readFileSync(path.join(folder,'prompt-ready.json')));
    const selected=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/lib/invoke_updater_button.ps1'),'-UpdaterProcessId',String(prompt.hostPid),'-ButtonName','现在更新'],{windowsHide:true,encoding:'utf8'});
    assert.equal(selected.status,0,selected.stderr);
    await until(()=>client.evaluate("window.voxcpmDesktop.getUpdateState().then(s=>s.status==='installing')"),180000);
    console.log('启动自动原生提示，一次选择现在更新后自动下载并交接安装');
  } else {
    const downloaded = await client.evaluate("window.voxcpmDesktop.downloadUpdate()");
    assert.equal(downloaded.status, "downloaded", JSON.stringify(downloaded));
    await until(async () => client.evaluate("/重启并安装|启动独立更新器|现在更新/.test(document.body.innerText)"));
  }
  assert.equal((await client.evaluate("window.voxcpmDesktop.getBootstrapState()")).backendRunning, true);
  const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(testRoot, "settings-before-update.png"), Buffer.from(screenshot.data, "base64"));
  console.log("设置页版本、更新说明、下载和自动检查开关已验证");
  client.close();
  activeClient = null;
  // 使用同一更新会话启动独立更新器；绕开交互确认仅用于自动化冒烟测试。
  const cache = path.join(testRoot, "data/cache/updates");
  const latestSession = () => fs.readdirSync(cache).filter((name) => name.startsWith("session-")).sort((a, b) => fs.statSync(path.join(cache, a)).mtimeMs - fs.statSync(path.join(cache, b)).mtimeMs).at(-1);
  let nativeFailurePreservedMain = false;
  if (process.argv.includes("--native-failure-first")) {
    const failedSession = path.join(cache, latestSession());
    fs.renameSync(path.join(failedSession, "updater.py"), path.join(failedSession, "updater.py.disabled"));
    const failureClient = await cdp(19228);
    const failure = await failureClient.evaluate("window.voxcpmDesktop.installUpdate().then(()=>({ok:true})).catch(e=>({error:String(e)}))");
    assert.ok(failure.error);
    assert.equal((await failureClient.evaluate("window.voxcpmDesktop.getUpdateState()")).status, "error");
    assert.equal((await failureClient.evaluate("window.voxcpmDesktop.getBootstrapState()")).backendRunning, true);
    assert.equal(child.exitCode, null);
    assert.equal(fs.existsSync(path.join(failedSession, "cancel.json")), true);
    assert.ok(fs.readFileSync(path.join(failedSession, "updater.log"), "utf8").includes("Python"));
    nativeFailurePreservedMain = true;
    const closeCode = "$target=" + "'" + path.join(failedSession, fs.existsSync(path.join(failedSession, "JVOX Updater.exe")) ? "JVOX Updater.exe" : "VoxCPM Updater.exe").replaceAll("'", "''") + "'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { (Get-Process -Id $_.ProcessId).CloseMainWindow() | Out-Null }";
    spawnSync("powershell.exe", ["-NoProfile", "-Command", closeCode], { windowsHide: true });
    assert.equal((await failureClient.evaluate("window.voxcpmDesktop.downloadUpdate()")).status, "downloaded");
    failureClient.close();
    console.log("原生更新器环境失败时主程序与本地服务保持可用，重新准备后继续安装");
  }
  const session = latestSession();
  const Launcher = process.argv.includes("--legacy-client") ? require(path.join(appDir, "update-service.js")).UpdateService : UpdateService;
  const service = new Launcher({ root: testRoot, dataRoot: path.join(testRoot, "data"), appDir, currentVersion: fromVersion });
  service.session = path.join(cache, session); service.state.status = "downloaded";
  if (process.argv.includes("--main-install")) {
    const installClient = await cdp(19228);
    if (!promptFlow) await installClient.send("Runtime.evaluate", { expression: "void window.voxcpmDesktop.installUpdate()", awaitPromise: false });
    installClient.close();
    await until(() => fs.existsSync(path.join(service.session, "host-ready.json")) && fs.existsSync(path.join(service.session, "ready.json")));
  } else await service.launch();
  let standalone;
  if (process.argv.includes("--assert-native")) {
    standalone = JSON.parse(fs.readFileSync(path.join(service.session, "host-ready.json")));
    const worker = JSON.parse(fs.readFileSync(path.join(service.session, "ready.json")));
    assert.equal(standalone.workerPid, worker.pid);
    assert.equal(standalone.independent, true);
    assert.equal(path.dirname(standalone.executable), service.session);
    assert.ok(["JVOX Updater.exe", "VoxCPM Updater.exe"].includes(path.basename(standalone.executable)));
    assert.notEqual(standalone.hostPid, child.pid);
    if (process.argv.includes("--main-install")) {
      const parent = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(standalone.hostPid)}' | Select-Object -ExpandProperty ParentProcessId`], { encoding: "utf8", windowsHide: true });
      assert.equal(Number(parent.stdout.trim()), child.pid, "更新器必须由实际主进程启动，不能用测试外部进程代替");
      standalone.launchedByActualMain = true;
    }
    const capture = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/capture_update_window.ps1"),
      "-UpdaterProcessId", String(standalone.hostPid), "-OutputPath", path.join(testRoot, "standalone-updater.png")], { encoding: "utf8", windowsHide: true });
    assert.equal(capture.status, 0, capture.stderr);
    // 更新器就绪后，整个旧前端目录变为不可用，验证安装不再加载其中的JS或页面。
    fs.renameSync(appDir, appDir + "-held-for-independence-test-" + Date.now());
    console.log("原生独立窗口已显示，旧resources/app目录已移开，继续关闭主程序并安装");
  }
  // 主进程在生产中调用 app.quit；测试通过 taskkill 关闭本次测试进程树。
  if (process.argv.includes("--main-install")) {
    fs.writeFileSync(allowExitFile, "{}");
    await until(() => child.exitCode !== null, 30000);
  } else spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  const statusPath = path.join(service.session, "status.json");
  const result = await until(() => {
    if (!fs.existsSync(statusPath)) return false;
    const status = JSON.parse(fs.readFileSync(statusPath));
    if (["error", "rolled-back"].includes(status.status)) throw new Error(status.message);
    return status.status === "complete" && status;
  }, 240000);
  assert.equal(result.version, targetVersion);
  assert.equal(JSON.parse(fs.readFileSync(packagePath)).version, targetVersion);
  const installedConfig = JSON.parse(fs.readFileSync(configPath));
  const targetManifest = JSON.parse(JSON.parse(fs.readFileSync(path.join(service.session, "envelope.json"))).payload);
  assert.equal(installedConfig.releaseId, targetManifest.releaseId);
  const recheck = new UpdateService({ root: testRoot, dataRoot: path.join(testRoot, "data"), appDir, currentVersion: targetVersion,
    config: { ...installedConfig, ...(manifestArgument >= 0 ? { manifestUrl: process.argv[manifestArgument + 1] } : {}) } });
  assert.equal((await recheck.check()).status, "current", "重启后不能重复提示同一发布更新");
  if (!process.argv.includes("--legacy-client")) assert.equal(recheck.getState().lastResult?.status, "complete");
  assert.equal(await digest(sentinel), dataHash);
  assert.equal(await digest(modelConfig), modelHash);
  const backendState = JSON.parse(fs.readFileSync(path.join(testRoot, "data/cache/electron_backend_state.json")));
  const health = await (await fetch(backendState.serviceUrl + "/api/health")).json();
  if (lightweight) {
    if (fs.readFileSync(path.join(appDir, "runtime-service.js"), "utf8").includes("async launch(")) {
      const runtime = await (await fetch(backendState.serviceUrl + "/api/runtime/summary")).json();
      assert.equal(runtime.runtime_pending, true, "正常更新重启应走按需加载，不重新导入所有模型框架");
    } else assert.ok(fs.readFileSync(path.join(testRoot, "data/cache/runtime-bootstrap.log"), "utf8").includes("已复用验证通过的本地环境"), "更新重启未复用已验证运行时");
  }
  let music;
  if (componentProfile) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(testRoot, "data/component-selection.json"))), componentProfile);
    music = await (await fetch(backendState.serviceUrl + "/api/music/status")).json();
    assert.equal(music.models.length, 4);
    assert.equal(music.rules.models.length, 4);
  }
  const report = { result: "passed", fromVersion, toVersion: targetVersion, testRoot, session: service.session,
    installedReleaseId: installedConfig.releaseId, recheckStatus: recheck.state.status, signedUpdaterBootstrap: process.argv.includes("--fixed-client"),
    legacyClient: process.argv.includes("--legacy-client"),
    startupPromptFlow: promptFlow,
    nativeFailurePreservedMain,
    ...(standalone ? { standalone, previousAppDirectoryUnavailable: true } : {}),
    userDataPreserved: true, modelPreserved: true, restartedBackend: backendState.serviceUrl, health,
    ...(componentProfile ? { componentSelectionPreserved: true, musicModels: music.models.length, officialRules: music.rules.models.length } : {}) };
  fs.writeFileSync(path.join(testRoot, "smoke-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // 测试进程通过退出关闭；正式便携包与原有服务不受影响。
  const processes = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe' OR Name='JVOX Studio配音系统.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const items = JSON.parse(processes.stdout || "[]");
  for (const item of Array.isArray(items) ? items : [items]) if ([exe.toLowerCase(), path.join(testRoot,"JVOX Studio配音系统.exe").toLowerCase()].includes(item.ExecutablePath?.toLowerCase())) {
    spawnSync("taskkill", ["/PID", String(item.ProcessId), "/T", "/F"], { windowsHide: true });
  }
})().catch((error) => {
  activeClient?.close();
  console.error(error); process.exitCode = 1;
  const processes = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe' OR Name='JVOX Studio配音系统.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const items = JSON.parse(processes.stdout || "[]");
  const exe = path.join(testRoot, "VoxCPM Studio.exe").toLowerCase();
  for (const item of Array.isArray(items) ? items : [items]) if ([exe, path.join(testRoot,"JVOX Studio配音系统.exe").toLowerCase()].includes(item.ExecutablePath?.toLowerCase())) {
    spawnSync("taskkill", ["/PID", String(item.ProcessId), "/T", "/F"], { windowsHide: true });
  }
});
