// 对最终安装副本运行原 EXE、原主进程和真实 API，不修改应用代码或共享依赖。
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { connect, until, wait } = require("./lib/electron_cdp.cjs");
const repo = path.resolve(__dirname, ".."), installed = path.resolve(process.argv[2]);
assert.ok(installed.startsWith(path.join(repo, "builds") + path.sep), "仅验收隔离安装副本");
const out = path.join(repo, "builds/installed-close-validation", String(Date.now()));
const exe = path.join(installed, "JVOX Studio配音系统.exe"), data = path.join(installed, "data");
const env = { ...process.env, VOXCPM_DATA_ROOT: data };
for (const key of ["ELECTRON_RUN_AS_NODE", "VOXCPM_APP_ROOT", "VOXCPM_PYTHON_EXE", "VOXCPM_UPDATE_SESSION", "VOXCPM_UPDATE_HEALTH_FILE"]) delete env[key];
let child, client, boot;
async function click(selector) { await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function launch() {
  child = spawn(exe, ["--voxcpm-run", "--remote-debugging-port=19464"], { cwd: installed, env, stdio: "ignore" });
  client = await connect(19464);
  await until(() => client.evaluate('!!document.querySelector(".studio-shell") && !!document.body.dataset.theme'));
  if (await client.evaluate('!!document.querySelector(".jvox-announcement[open]")')) await click(".jvox-update");
  boot = await until(() => client.evaluate('window.voxcpmDesktop.getBootstrapState().then(s=>s.status==="ready"&&s.backendRunning&&s)'), 180000);
  await until(() => client.evaluate('document.visibilityState === "visible"'));
}
async function open() { await client.evaluate('window.voxcpmDesktop.requestWindowClose()'); await until(() => client.evaluate('!!document.querySelector(".window-close-dialog[open]")')); }
async function restore() {
  // 实际再次运行同一 EXE，检验 single-instance 路径能从托盘唤回窗口。
  const second = spawn(exe, ["--voxcpm-run"], { cwd: installed, env, stdio: "ignore" });
  await until(() => second.exitCode !== null);
  assert.equal(second.exitCode, 0);
  await until(() => client.evaluate('document.visibilityState === "visible"'));
}
async function exited() {
  const base = boot.backendBaseUrl;
  client?.close(); client = null; await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
  await until(async () => { try { await fetch(base + "/api/health"); return false; } catch { return true; } });
}
async function shot(name) { await wait(220); const image = await client.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(image.data, "base64")); }
(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(data, "config"), { recursive: true });
  fs.writeFileSync(path.join(data, "config/update-settings.json"), '{"autoCheck":false}');
  await launch();
  assert.equal((await client.evaluate('window.voxcpmDesktop.getWindowBehavior()')).behavior, "ask");
  await open(); await shot("close-dark");
  await click(".wc-cancel");
  assert.equal((await client.evaluate('window.voxcpmDesktop.getWindowBehavior()')).behavior, "ask");
  await client.evaluate('[...document.querySelectorAll(".nav-item")].find(e=>e.textContent.trim()==="设置").click()');
  await client.evaluate('[...document.querySelectorAll(".settings-navigation button")].find(e=>e.textContent.includes("界面与工具")).click()');
  await until(() => client.evaluate('document.querySelectorAll(".wc-setting-option").length===3'));
  await click('[aria-label="切换界面主题"]'); await shot("settings-light");
  await open(); await shot("close-light");
  const originalPid = boot.backendPid;
  await click('.window-close-dialog input[value="background"]'); await click(".window-close-dialog .wc-primary");
  await until(() => client.evaluate('document.visibilityState === "hidden"'));
  assert.equal((await fetch(boot.backendBaseUrl + "/api/health")).ok, true);
  assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).backendPid, originalPid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "config/window-behavior.json"))).behavior, "background");
  await restore(); await client.evaluate('window.voxcpmDesktop.requestWindowClose()');
  await until(() => client.evaluate('document.visibilityState === "hidden"'));
  assert.equal(await client.evaluate('!!document.querySelector(".window-close-dialog")'), false);
  await restore(); await click('.wc-setting-option:last-child');
  await until(() => client.evaluate('window.voxcpmDesktop.getWindowBehavior().then(s=>s.behavior==="ask")'));
  await open(); await click('.window-close-dialog input[value="ask"]'); await click(".window-close-dialog .wc-primary");
  await exited();
  await launch();
  assert.equal((await client.evaluate('window.voxcpmDesktop.getWindowBehavior()')).behavior, "ask");
  assert.equal(await client.evaluate('document.body.dataset.theme'), "light");
  assert.equal(await client.evaluate('!!document.querySelector(".jvox-announcement")'), false);
  await open(); await click('.window-close-dialog input[value="quit"]'); await click(".window-close-dialog .wc-primary"); await exited();
  await launch();
  assert.equal((await client.evaluate('window.voxcpmDesktop.getWindowBehavior()')).behavior, "quit");
  const version = (await client.evaluate('window.voxcpmDesktop.getUpdateState()')).currentVersion;
  assert.equal(client.events.filter(e => e.method === "Runtime.exceptionThrown").length, 0);
  await client.send("Runtime.evaluate", { expression: "setTimeout(()=>window.close(),100)", awaitPromise: false }); await exited();
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ passed: true, installed, version, actualPackagedExe: true,
    firstCloseAsks: true, bothThemes: true, cancelDoesNotSave: true, backgroundKeepsSameBackend: true, realSingleInstanceRestoresWindow: true,
    rememberedBackgroundDoesNotPromptAgain: true, settingsCanResetToAsk: true, askSurvivesProcessRestart: true,
    fixedQuitSurvivesProcessRestart: true, quitStopsBackend: true, themeAndWelcomePreserved: true, noModelInference: true }, null, 2));
  console.log("PASS 最终安装EXE退出弹窗、后台保留服务、再次启动唤回、跨重启偏好：" + out);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close(); if (child && child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
});
