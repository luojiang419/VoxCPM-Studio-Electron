/* 使用真实 Electron、Python API 和已生成音频，验证新版界面及重启持久化。 */
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawn, spawnSync } = require("child_process");
const { connect, until, wait } = require("./lib/electron_cdp.cjs");
const root = path.resolve(__dirname, "..");
const project = path.join(root, "frontend/voxcpm_studio_electron");
const validation = path.join(root, "builds/production-validation");
const data = path.join(validation, "data");
const real = JSON.parse(fs.readFileSync(path.join(validation, "real-inference.json")));
const portable = process.argv.includes("--portable");
const exe = portable ? path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1/VoxCPM Studio.exe") : path.join(project, "node_modules/electron/dist/electron.exe");
const errors = [];
let child, client;
const env = { ...process.env, VOXCPM_PYTHON_EXE: path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1/runtime/python/python.exe"),
  VOXCPM_DATA_ROOT: data, VOXCPM_MODEL_DIR: path.resolve(root, "../models/openbmb__VoxCPM2") };
delete env.ELECTRON_RUN_AS_NODE;
async function launch() {
  child = spawn(exe, [...(portable ? [] : [project]), "--remote-debugging-port=19231"], { cwd: path.dirname(exe), env, windowsHide: true, stdio: "ignore" });
  client = await connect(19231);
  await until(() => client.evaluate("Boolean(window.voxcpmDesktop && document.querySelector('.studio-page-tools'))"));
  const boot = await until(async () => {
    const state = await client.evaluate("window.voxcpmDesktop.getBootstrapState()");
    if (state.status === "error") throw new Error(state.detail);
    return state.status === "ready" && state;
  }, 190000);
  await until(() => client.evaluate("Boolean(document.querySelector('.ps-project-name input'))"));
  return boot;
}
async function screenshot(name, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await wait(250);
  const overflow = await client.evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth})");
  assert.ok(overflow.scroll <= width + 1 && overflow.body <= width + 1, JSON.stringify(overflow));
  const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(validation, name + ".png"), Buffer.from(shot.data, "base64"));
}
async function clickText(text) {
  assert.equal(await client.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true;})()`), true, `找不到按钮 ${text}`);
  await wait(200);
}
function stop() {
  client?.close(); client = null;
  if (child) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  child = null;
}
(async () => {
  let boot = await launch();
  const api = async (route, body, method) => {
    const response = await fetch(boot.backendBaseUrl + route, { method: method || (body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const projectList = await api("/api/workspace/projects");
  assert.ok(projectList.items.some(p => p.id === real.projectId));
  // 真正通过界面建立一个临时文案工程，覆盖导入、复制与自动保存。
  await clickText("新建项目");
  await until(() => client.evaluate("document.querySelectorAll('.ps-segment').length===0 && Boolean(document.querySelector('.ps-editor-empty'))"));
  const uiProjectId = await client.evaluate("document.querySelector('[aria-label=\"切换项目\"]').value");
  await clickText("导入文案");
  await until(() => client.evaluate("Boolean(document.querySelector('[aria-label=\"待导入文案\"]'))"));
  const scriptText = "{旁白}清晨的第一束光，落在窗台。\n{青禾}今天，我们一起出发。";
  await client.evaluate(`(()=>{const e=document.querySelector('[aria-label="待导入文案"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(scriptText)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickText("整理并导入");
  await until(() => client.evaluate("document.querySelectorAll('.ps-segment').length===2"));
  const imported = await api(`/api/workspace/projects/${uiProjectId}`);
  assert.equal(imported.roles.length, 2); assert.equal(imported.segments.length, 2);
  await client.evaluate("document.querySelector('[aria-label=\"复制台词\"]').click()");
  await until(() => client.evaluate("document.querySelectorAll('.ps-segment').length===3"));
  await until(async () => (await api(`/api/workspace/projects/${uiProjectId}`)).segments.length === 3);
  await client.evaluate("document.querySelector('[aria-label=\"搜索台词\"]').value=''");
  // 显式打开前一阶段完成真实推理的工程。
  await client.evaluate(`(()=>{const e=document.querySelector('[aria-label="切换项目"]');e.value=${JSON.stringify(real.projectId)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => client.evaluate("document.querySelector('.ps-project-name input')?.value.includes('双人配音')"));
  assert.equal(await client.evaluate("document.querySelectorAll('.ps-segment').length"), 2);
  assert.equal(await client.evaluate("document.querySelectorAll('.ps-segment-ready').length"), 2);
  await screenshot("studio-dark-1560", 1560, 980);
  await screenshot("studio-dark-1366", 1366, 768);
  await screenshot("studio-dark-1180", 1180, 760);
  await clickText("音色库");
  await until(() => client.evaluate("Boolean(document.querySelector('.ps-voice-card'))"));
  await screenshot("voice-library", 1560, 980);
  await clickText("作品记录");
  await until(() => client.evaluate("Boolean(document.querySelector('.works-row'))"));
  await screenshot("history", 1560, 980);
  await clickText("配音工作台");
  await client.evaluate("document.querySelector('[aria-label=\"切换界面主题\"]').click()");
  await until(() => client.evaluate("document.body.getAttribute('data-theme')==='light'"));
  await screenshot("studio-light", 1560, 980);
  await client.evaluate("document.querySelector('[aria-label=\"切换界面主题\"]').click()");
  // 实际点击预听，确保返回音频可解码并开始播放。
  await client.evaluate("Array.from(document.querySelectorAll('.ps-segment button')).find(b=>b.textContent.trim()==='试听').click()");
  await until(() => client.evaluate("Boolean(document.querySelector('audio')?.duration > .1)"));
  await until(() => client.evaluate("document.querySelector('audio')?.paused===false"));
  const audio = await client.evaluate("({duration:document.querySelector('audio').duration,ready:document.querySelector('audio').readyState,playing:!document.querySelector('audio').paused})");
  assert.ok(audio.duration > .1);
  await client.evaluate("document.querySelector('audio').pause()");
  await clickText("导出");
  await until(() => client.evaluate("Boolean(document.querySelector('.ps-export-ready'))"));
  await until(() => client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='新建项目')?.disabled===false"));
  assert.equal((await api(`/api/workspace/projects/${real.projectId}`)).lastExport.stale, false);
  // 真实编辑项目名，等待自动保存，再重启加载同一项目。
  const name = "双人配音 · 创作工作台验收完成";
  await client.evaluate(`(()=>{const e=document.querySelector('[aria-label="项目名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(name)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(async () => (await api(`/api/workspace/projects/${real.projectId}`)).name === name);
  await until(() => client.evaluate("document.querySelector('.ps-save-state')?.classList.contains('saved')"));
  assert.equal(await client.evaluate("document.querySelectorAll('.ps-alert-error').length"), 0);
  const javascriptErrors = client.events.filter(e => e.method === "Runtime.exceptionThrown");
  errors.push(...javascriptErrors);
  assert.equal(javascriptErrors.length, 0, JSON.stringify(javascriptErrors));
  await screenshot("studio-final", 1560, 980);
  stop(); await wait(1000);
  boot = await launch();
  await until(() => client.evaluate(`document.querySelector('[aria-label="项目名称"]')?.value===${JSON.stringify(name)}`));
  assert.equal(await client.evaluate("document.querySelectorAll('.ps-segment-ready').length"), 2);
  await screenshot("studio-restarted", 1560, 980);
  const restored = await api(`/api/workspace/projects/${real.projectId}`);
  assert.equal(restored.name, name);
  assert.equal(restored.segments.length, 2);
  const report = { result: "passed", mode: portable ? "portable" : "source", projectId: real.projectId, backendBaseUrl: boot.backendBaseUrl,
    layouts: ["1560x980 dark", "1366x768 dark", "1180x760 dark", "1560x980 light"], voices: true, history: true,
    audioPreview: audio, autoSave: true, restoredAfterRestart: true, javascriptErrors: errors.length };
  report.uiImportAndDuplicate = true; report.uiExport = true;
  fs.writeFileSync(path.join(validation, "ui-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
