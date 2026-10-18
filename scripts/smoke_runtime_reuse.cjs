// 真实 Electron、托管 Python、GPU 校验和模型复用；连续两次启动，界面故障状态另用事件夹具。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const output = path.join(root, 'builds/runtime-reuse-validation'), run = path.join(output, String(Date.now()));
const fixture = path.join(run, 'desktop'), shell = path.join(fixture, 'resources/app'), data = path.join(fixture, 'data');
const sourcePython = path.join(root, 'builds/bootstrap-validation/runtime/managed/py312-cu126');
const runtime = path.join(fixture, 'runtime/managed/py312-cu126'), mailbox = path.join(run, 'events.json');
const exe = path.join(frontend, 'node_modules/electron/dist/electron.exe');
const env = { ...process.env, VOXCPM_APP_ROOT: path.join(fixture, 'app'), VOXCPM_DATA_ROOT: data,
  VOXCPM_MODEL_DIR: path.resolve(root, '../models/openbmb__VoxCPM2') };
delete env.ELECTRON_RUN_AS_NODE; delete env.VOXCPM_PYTHON_EXE;
let child, c; const launches = [];
function stop() { c?.close(); c = null; if (child) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); child = null; } }
async function events(items) { fs.writeFileSync(mailbox, JSON.stringify(items)); await wait(400); }
async function shot(name) { await wait(250); const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(r.data, 'base64')); }
async function launch(number) {
  const started = Date.now();
  child = spawn(exe, [path.join(run, 'main.cjs'), '--voxcpm-run', '--remote-debugging-port=19243', `--user-data-dir=${path.join(run, 'profile')}`], { cwd: shell, env, windowsHide: true, stdio: 'ignore' });
  c = await connect(19243);
  await until(() => c.evaluate("Boolean(document.body && window.voxcpmDesktop)"));
  await c.evaluate(`(()=>{window.__runtimeStates=[];window.__runtimeDialogs=[];window.voxcpmDesktop.onRuntimeEvent(e=>{if(e.type==='runtime-preparation')window.__runtimeStates.push({status:e.preparation.status,phase:e.preparation.phase,cached:e.preparation.cached,at:Date.now()})});new MutationObserver(()=>{const d=document.querySelector('.runtime-dialog');if(d?.open)window.__runtimeDialogs.push(d.innerText)}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']})})()`);
  const boot = await until(() => c.evaluate(`window.voxcpmDesktop.getBootstrapState().then(s=>{if(s.status==='error')return {failed:s.detail};return s.status==='ready'&&s})`), 180000);
  assert.ok(!boot.failed, boot.failed);
  await until(() => c.evaluate("Boolean(document.querySelector('.ps-project-bar'))"));
  const prep = await c.evaluate('window.voxcpmDesktop.getPreparationState()');
  const states = await c.evaluate('window.__runtimeStates'), dialogs = await c.evaluate('window.__runtimeDialogs');
  assert.equal(await c.evaluate("document.querySelector('.runtime-dialog').open"), false);
  assert.ok(dialogs.every(text => !text.includes('补齐') && !text.includes('首次运行')), JSON.stringify(dialogs));
  assert.ok(!states.some(state => state.status === 'working'), JSON.stringify(states));
  if (number === 2) assert.equal(prep.cached, true);
  const timing = JSON.parse(fs.readFileSync(path.join(run, 'preparation-timing.json'), 'utf8'));
  const result = { launch: number, elapsedMs: Date.now() - started, cached: prep.cached, preparationMs: timing.elapsedMs, dialogs: dialogs.length };
  launches.push(result); await shot(`launch-${number}-ready`); return boot;
}
(async () => {
  fs.mkdirSync(shell, { recursive: true }); fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(fixture, 'app/src'), { recursive: true });
  for (const file of ['desktop_api.py', 'app.py', 'pyproject.toml']) fs.copyFileSync(path.resolve(root, '..', file), path.join(fixture, 'app', file));
  for (const folder of ['src/voxcpm', 'assets', 'conf']) fs.cpSync(path.resolve(root, '..', folder), path.join(fixture, 'app', folder), { recursive: true, filter: name => !name.endsWith('__pycache__') && !name.endsWith('.pyc') });
  for (const file of ['main.js', 'preload.js', 'package.json', 'update-service.js', 'update-window.js', 'update-config.json', 'updater.py', 'runtime-service.js', 'runtime-config.json', 'runtime-requirements.txt', 'component-service.js', 'music-config.json', 'install-protocol.js', 'app.ico', 'app-icon.png']) fs.copyFileSync(path.join(frontend, file), path.join(shell, file));
  fs.cpSync(path.join(root, 'backend/voxcpm'), path.join(fixture, 'app/src/voxcpm'), { recursive: true });
  fs.mkdirSync(path.join(data, 'config'), { recursive: true });
  fs.writeFileSync(path.join(data, 'component-selection.json'), JSON.stringify({ selected: [], removed: [], defaultModel: 'ace-xl-turbo' }));
  fs.writeFileSync(path.join(data, 'config/update-settings.json'), JSON.stringify({ autoCheck: false }));
  fs.cpSync(path.join(frontend, 'dist'), path.join(shell, 'dist'), { recursive: true });
  for (const entry of fs.readdirSync(sourcePython, { withFileTypes: true })) if (entry.isFile() && /\.(exe|dll|pyd|zip|_pth)$/.test(entry.name)) fs.copyFileSync(path.join(sourcePython, entry.name), path.join(runtime, entry.name));
  fs.mkdirSync(path.join(runtime, 'Lib'), { recursive: true });
  fs.symlinkSync(path.join(sourcePython, 'Lib/site-packages'), path.join(runtime, 'Lib/site-packages'), 'junction');
  fs.copyFileSync(path.join(sourcePython, 'ready.json'), path.join(runtime, 'ready.json'));
  fs.symlinkSync(path.resolve(root, '../models'), path.join(fixture, 'models'), 'junction');
  for (const file of ['runtime_manifest.json', 'lightweight.json']) fs.writeFileSync(path.join(fixture, file), JSON.stringify({ mode: 'lightweight', protocol: 1 }));
  fs.writeFileSync(path.join(run, 'main.cjs'), `const fs=require('fs'),{BrowserWindow}=require('electron'),{RuntimeService}=require(${JSON.stringify(path.join(shell, 'runtime-service.js'))});const emit=RuntimeService.prototype.emit,prepare=RuntimeService.prototype.prepare;RuntimeService.prototype.emit=function(part){if(part.status==='working'){this.controller?.abort(new Error('验收禁止安装依赖或下载模型'));throw new Error('测试环境未就绪，已停止而不改动共享依赖')}return emit.call(this,part)};RuntimeService.prototype.prepare=function(options){const start=Date.now();return prepare.call(this,options).then(result=>{fs.writeFileSync(${JSON.stringify(path.join(run, 'preparation-timing.json'))},JSON.stringify({elapsedMs:Date.now()-start,cached:this.state.cached}));return result})};require(${JSON.stringify(path.join(shell, 'main.js'))});fs.watchFile(${JSON.stringify(mailbox)},{interval:100},()=>{try{for(const e of JSON.parse(fs.readFileSync(${JSON.stringify(mailbox)},'utf8')))for(const w of BrowserWindow.getAllWindows())w.webContents.send('runtime:event',e)}catch{}});`);
  await launch(1); stop(); await wait(500);
  const boot = await launch(2);
  const quick = launches[1]; assert.ok(quick.preparationMs < launches[0].preparationMs, JSON.stringify(launches));
  await events([{ ...boot, type: 'boot', status: 'preparing' }, { type: 'runtime-preparation', preparation: { status: 'checking', phase: 'check', message: '正在检查本地运行环境' } }]);
  assert.equal(await c.evaluate("document.querySelector('.runtime-dialog').open"), true);
  assert.equal(await c.evaluate("document.querySelector('#runtime-title').textContent"), '音频系统启动中');
  for (const theme of ['light', 'dark']) {
    await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`); await shot(`normal-check-${theme}`);
  }
  await events([{ type: 'runtime-preparation', preparation: { status: 'working', phase: 'dependencies', message: '正在补齐缺失的组件', name: 'missing.whl', downloaded: 5, size: 10 } }]);
  assert.equal(await c.evaluate("document.querySelector('.runtime-dialog').open"), true);
  assert.ok(await c.evaluate("document.querySelector('#runtime-title').textContent.includes('缺失的音频资源')"));
  assert.equal(await c.evaluate("document.querySelector('.runtime-dialog').innerText.includes('首次运行')"), false);
  for (const theme of ['light', 'dark']) {
    await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`); await shot(`actual-repair-${theme}`);
  }
  await events([{ type: 'runtime-preparation', preparation: { status: 'ready', phase: 'ready', message: '本地环境已就绪' } }, { ...boot, type: 'error', status: 'error', detail: '模拟应用源码启动错误' }]);
  assert.equal(await c.evaluate("document.querySelector('.runtime-dialog').open"), true);
  assert.equal(await c.evaluate("document.querySelector('#runtime-title').textContent"), '音频系统启动未完成');
  await events([{ ...boot, type: 'ready' }]);
  assert.equal(await c.evaluate("document.querySelector('.runtime-dialog').open"), false);
  assert.equal(c.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  const report = { result: 'passed', launches, realRuntime: 'Python 3.12 / cu126 / RTX 4070 Ti SUPER', uiFixtures: ['startup-progress', 'actual-repair', 'backend-error', 'ready-close'], javascriptErrors: 0, run };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => { console.error(error); try { if (c) await shot('failure'); } catch {} process.exitCode = 1; }).finally(stop);
