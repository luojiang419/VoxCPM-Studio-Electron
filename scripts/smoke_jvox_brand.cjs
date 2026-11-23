// 使用最终安装副本验收实际主进程、API、庆祝弹窗和持久化；不修改应用源码。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), installed = path.resolve(process.argv[2]);
assert.ok(installed.startsWith(path.join(root, 'builds') + path.sep), '仅接受隔离验收安装目录');
const out = path.join(root, 'builds/jvox-brand-validation', String(Date.now()));
fs.mkdirSync(out, { recursive: true });
let child, client;
(async () => {
  const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(installed, 'data') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VOXCPM_APP_ROOT', 'VOXCPM_PYTHON_EXE', 'VOXCPM_UPDATE_SESSION', 'VOXCPM_UPDATE_HEALTH_FILE']) delete env[key];
  child = spawn(path.join(installed, 'JVOX Studio配音系统.exe'), ['--voxcpm-run', '--remote-debugging-port=19441'], { cwd: installed, env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19441);
  async function ready() { return until(() => client.evaluate('window.voxcpmDesktop.getBootstrapState().then(s=>s.status==="ready" && s.backendRunning && !!document.querySelector(".brand-copy") && !!document.body.dataset.theme)'), 180000); }
  async function dialog() { return until(() => client.evaluate('!!document.querySelector(".jvox-announcement[open]")')); }
  async function click(selector) { await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function shot(name) { await wait(300); const s = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); }
  await ready();
  await client.evaluate('localStorage.removeItem("jvox-brand-welcome-2026")');
  await client.send('Page.reload'); await ready(); await dialog();
  assert.equal(await client.evaluate('document.title'), 'JVOX Studio配音系统');
  assert.equal(await client.evaluate('document.querySelector(".jvox-announcement h2").textContent'), 'JVOX Studio配音系统');
  assert.equal(await client.evaluate('document.querySelector(".jvox-update").textContent.trim().startsWith("开启新声，开始创作")'), true);
  assert.equal(await client.evaluate('document.querySelector(".brand-copy").textContent.replace(/\\s/g, "")'), 'JVOXStudio配音系统');
  if (await client.evaluate('document.body.dataset.theme!=="dark"')) await click('[aria-label="切换弹窗深浅主题"]');
  await shot('welcome-dark');
  await click('[aria-label="切换弹窗深浅主题"]');
  await until(() => client.evaluate('document.body.dataset.theme === "light"'));
  await shot('welcome-light');
  await click('.jvox-later'); assert.equal(await client.evaluate('!!document.querySelector(".jvox-announcement")'), false);
  await client.send('Page.reload'); await ready(); await dialog();
  await click('.jvox-update');
  assert.equal(await client.evaluate('localStorage.getItem("jvox-brand-welcome-2026")'), 'seen');
  await client.send('Page.reload'); await ready();
  assert.equal(await client.evaluate('!!document.querySelector(".jvox-announcement")'), false);
  assert.equal(await client.evaluate('document.body.dataset.theme'), 'light');
  await client.evaluate('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.trim()==="配音工作台").click()');
  await shot('production');
  const state = await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
  assert.equal((await (await fetch(state.backendBaseUrl + '/api/runtime/summary')).json()).runtime_pending, true);
  const version = JSON.parse(fs.readFileSync(path.join(installed, 'resources/app/package.json'))).version;
  await client.evaluate('Promise.resolve(window.voxcpmDesktop.setWindowBehavior?.("quit")).then(()=>setTimeout(()=>window.close(),100))'); client.close(); client = null;
  await until(() => child.exitCode !== null);
  child = spawn(path.join(installed, 'JVOX Studio配音系统.exe'), ['--voxcpm-run', '--remote-debugging-port=19441'], { cwd: installed, env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19441); await ready();
  assert.equal(await client.evaluate('localStorage.getItem("jvox-brand-welcome-2026")'), 'seen');
  assert.equal(await client.evaluate('!!document.querySelector(".jvox-announcement")'), false);
  const report = { passed: true, installed, version, actualMainAndApi: true, windowTitle: 'JVOX Studio配音系统', sidebarRenamed: true,
    firstReadyWelcome: true, postInstallButton: true, bothThemes: true, deferRemindsNextLoad: true, acknowledgedDoesNotRepeat: true, acknowledgedDoesNotRepeatAfterProcessRestart: true, previousThemeKeyPreserved: true, noModelInference: true };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS 真实工作台、更名弹窗及确认持久化：' + out);
  await client.evaluate('Promise.resolve(window.voxcpmDesktop.setWindowBehavior?.("quit")).then(()=>setTimeout(()=>window.close(),100))'); client.close(); client = null;
  await until(() => child.exitCode !== null);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  client?.close(); if (child && !child.killed) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
