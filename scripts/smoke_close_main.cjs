// 隔离实际主进程和当前 HTTP API：后台保留服务，彻底退出释放本次服务；不生成/下载/发布。
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { connect, until, wait } = require("./lib/electron_cdp.cjs");
const root = path.resolve(__dirname, ".."), frontend = path.join(root, "frontend/voxcpm_studio_electron");
const out = path.join(root, "builds/close-main-validation", String(Date.now()));
const shell = path.join(out, "resources/app"), appRoot = path.join(out, "app"), data = path.join(out, "data");
let child, client, boot;
const commandFile = path.join(out, "command.json"), stateFile = path.join(out, "window.json");
const command = action => fs.writeFileSync(commandFile, JSON.stringify({ action }));
const windowState = () => JSON.parse(fs.readFileSync(stateFile));
async function click(selector) { await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function shot(name) { await wait(180); const image = await client.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(image.data, "base64")); }
(async () => {
  for (const dir of [shell, appRoot, path.join(data, "config")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(out, "runtime_manifest.json"), '{"protocol":1}');
  const pkg = JSON.parse(fs.readFileSync(path.join(frontend, "package.json")));
  for (const name of pkg.build.files.filter(name => !name.includes("*"))) fs.copyFileSync(path.join(frontend, name), path.join(shell, name));
  fs.cpSync(path.join(frontend, "dist"), path.join(shell, "dist"), { recursive: true });
  fs.writeFileSync(path.join(data, "config/update-settings.json"), '{"autoCheck":false}');
  // 用当前后端源码与已安装依赖启动真实 API，不对主进程和退出行为打桩。
  fs.writeFileSync(path.join(appRoot, "desktop_api.py"), `import os,sys,types\nfrom pathlib import Path\nif os.environ.get('VOXCPM_BACKEND_LOG'): sys.stdout=sys.stderr=open(os.environ['VOXCPM_BACKEND_LOG'],'a',encoding='utf8',buffering=1)\np=types.ModuleType('voxcpm');p.__path__=[${JSON.stringify(path.join(root, "backend/voxcpm"))},${JSON.stringify(path.resolve(root, "../src/voxcpm"))}];sys.modules['voxcpm']=p\nfrom voxcpm.studio_api import create_api_app\nimport uvicorn\nuvicorn.run(create_api_app(),host='127.0.0.1',port=int(sys.argv[sys.argv.index('--port')+1]),log_level='warning')\n`);
  const entry = path.join(out, "main.cjs");
  fs.writeFileSync(entry, `const fs=require('node:fs'),{app,BrowserWindow}=require('electron');
app.on('browser-window-created',(_e,win)=>{const write=()=>fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({visible:win.isVisible(),destroyed:win.isDestroyed()}));win.on('show',()=>setImmediate(write));win.on('hide',()=>setImmediate(write));win.once('ready-to-show',()=>setImmediate(write));});
require(${JSON.stringify(path.join(shell, "main.js"))});
const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(commandFile)}))return;const c=JSON.parse(fs.readFileSync(${JSON.stringify(commandFile)}));fs.unlinkSync(${JSON.stringify(commandFile)});if(c.action==='restore')app.emit('activate');if(c.action==='quit')app.quit();},80);timer.unref();`);
  const python = spawnSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", windowsHide: true }).stdout.trim();
  const env = { ...process.env, VOXCPM_APP_ROOT: appRoot, VOXCPM_DATA_ROOT: data, VOXCPM_PYTHON_EXE: python };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of ["VOXCPM_UPDATE_SESSION", "VOXCPM_UPDATE_HEALTH_FILE", "VOXCPM_INSTALL_REPORT", "VOXCPM_INSTALL_SESSION"]) delete env[key];
  const log = fs.openSync(path.join(out, "electron.log"), "a");
  child = spawn(path.join(frontend, "node_modules/electron/dist/electron.exe"), [entry, "--remote-debugging-port=19462", `--user-data-dir=${path.join(out, "profile")}`], { env, stdio: ["ignore", log, log] }); fs.closeSync(log);
  client = await connect(19462);
  await until(() => client.evaluate('!!document.querySelector(".studio-shell")'));
  await until(() => windowState().visible);
  if (await client.evaluate('!!document.querySelector(".jvox-announcement[open]")')) await click(".jvox-update");
  boot = await until(() => client.evaluate('window.voxcpmDesktop.getBootstrapState().then(s=>s.status==="ready"&&s.backendRunning&&s)'), 60000);
  await client.evaluate('[...document.querySelectorAll(".nav-item")].find(e=>e.textContent.trim()==="设置").click()');
  await client.evaluate('[...document.querySelectorAll(".settings-navigation button")].find(e=>e.textContent.includes("界面与工具")).click()');
  await until(() => client.evaluate('document.querySelectorAll(".wc-setting-option").length===3'));
  await shot("actual-settings-dark");
  await client.evaluate('window.voxcpmDesktop.requestWindowClose()');
  await until(() => client.evaluate('!!document.querySelector(".window-close-dialog[open]")'));
  await shot("actual-workbench-dialog-dark");
  assert.equal(await client.evaluate('!!document.activeElement.closest(".window-close-dialog")'), true);
  await click('.window-close-dialog input[value="background"]'); await click(".window-close-dialog .wc-primary");
  await until(() => !windowState().visible);
  assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).backendPid, boot.backendPid);
  assert.equal((await fetch(boot.backendBaseUrl + "/api/health")).ok, true);
  assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status, "ready");
  command("restore"); await until(() => windowState().visible);
  await client.evaluate('window.voxcpmDesktop.requestWindowClose()'); await until(() => !windowState().visible);
  assert.equal(await client.evaluate('!!document.querySelector(".window-close-dialog")'), false);
  command("restore"); await until(() => windowState().visible);
  await click('.wc-setting-option:last-child');
  await until(() => client.evaluate('window.voxcpmDesktop.getWindowBehavior().then(s=>s.behavior==="ask")'));
  await click('[aria-label="切换界面主题"]');
  await client.evaluate('window.voxcpmDesktop.requestWindowClose()');
  await until(() => client.evaluate('!!document.querySelector(".window-close-dialog[open]")'));
  await shot("actual-workbench-dialog-light");
  await click('.window-close-dialog input[value="quit"]'); await click(".window-close-dialog .wc-primary");
  client.close(); client = null; await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
  await until(async () => { try { await fetch(boot.backendBaseUrl + "/api/health"); return false; } catch { return true; } });
  assert.equal(fs.existsSync(path.join(data, "cache/electron_backend_state.json")), false);
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ passed: true, actualMain: true, actualApi: true, backendPid: boot.backendPid,
    backgroundKeepsSameBackend: true, backgroundKeepsApiHealthy: true, fixedChoiceDoesNotPromptAgain: true, settingsChangesBehavior: true,
    darkAndLight: true, quitStopsBackend: true, isolated: true, noInferenceOrDownloadsOrPublication: true }, null, 2));
  console.log("PASS 实际工作台、HTTP API、设置与后台/退出闭环：" + out);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close();
  if (child && child.exitCode === null) { command("quit"); spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
});
