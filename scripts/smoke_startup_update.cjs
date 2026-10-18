/* 真实音频服务启动+可信签名清单HTTP；状态夹具仅覆盖缺失/暂停/错误界面。 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
if (!process.argv[2]) { console.error('用法：node scripts/smoke_startup_update.cjs <已准备好的本机预览目录>'); process.exit(2); }
const preview = path.resolve(process.argv[2]);
const run = path.join(root, 'builds/startup-update-validation', String(Date.now()));
const shell = path.join(run, 'resources/app'), data = path.join(run, 'data'), mailbox = path.join(run, 'events.json');
const stateLog = path.join(run, 'preparation.jsonl'), checks = [], requests = [], launches = [];
let child, client, server, failing = false;
async function click(text) {
  await client.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getBoundingClientRect().width>0).click()`);
  await wait(200);
}
async function shot(name) {
  await wait(300); const s = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(run, name + '.png'), Buffer.from(s.data, 'base64'));
}
async function events(items) { fs.writeFileSync(mailbox, JSON.stringify(items)); await wait(350); }
async function stop() {
  if (client) { await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(() => {}); client.close(); client = null; }
  if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  child = null;
}
async function launch(autoCheck) {
  fs.writeFileSync(path.join(data, 'config/update-settings.json'), JSON.stringify({ autoCheck }));
  const started = Date.now();
  const env = { ...process.env, VOXCPM_APP_ROOT: path.join(preview, 'app'), VOXCPM_DATA_ROOT: data,
    VOXCPM_PYTHON_EXE: path.join(preview, 'runtime/python/python.exe'), VOXCPM_MODEL_DIR: path.join(preview, 'models/openbmb__VoxCPM2') };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(run, 'electron.log'), 'a');
  child = spawn(path.join(frontend, 'node_modules/electron/dist/electron.exe'), [run, '--voxcpm-run', '--remote-debugging-port=19251', `--user-data-dir=${path.join(run, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { cwd: run, env, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  client = await connect(19251);
  await until(() => client.evaluate("document.querySelector('.runtime-startup-dialog')?.open"));
  assert.equal(await client.evaluate("document.querySelector('#runtime-title').textContent"), '音频系统启动中');
  await shot('actual-startup-' + launches.length);
  const boot = await until(async () => {
    const b = await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if (b.status === 'error') throw new Error(b.detail);
    return b.status === 'ready' && b;
  }, 240000);
  await until(() => client.evaluate("!!document.querySelector('.studio-shell')"));
  const preparation = await client.evaluate('window.voxcpmDesktop.getPreparationState()');
  launches.push({ autoCheck, elapsedMs: Date.now() - started, cached: preparation.cached });
  assert.equal(await client.evaluate("document.querySelector('.runtime-startup-dialog').open"), false);
  return boot;
}
(async () => {
  fs.mkdirSync(shell, { recursive: true }); fs.mkdirSync(path.join(data, 'config'), { recursive: true });
  fs.writeFileSync(path.join(run, 'runtime_manifest.json'), JSON.stringify({ protocol: 1 }));
  fs.writeFileSync(path.join(run, 'package.json'), JSON.stringify({ name: 'voxcpm-startup-validation', version: '2.0.2', main: 'harness.cjs' }));
  fs.writeFileSync(path.join(data, 'component-selection.json'), JSON.stringify({ selected: [], removed: ['heartmula'], defaultModel: 'ace-xl-turbo' }));
  fs.writeFileSync(mailbox, '[]');
  fs.symlinkSync(path.join(preview, 'models'), path.join(run, 'models'), 'junction');
  for (const file of ['main.js', 'preload.js', 'package.json', 'runtime-service.js', 'runtime-config.json', 'runtime-requirements.txt', 'component-service.js', 'music-config.json', 'update-service.js', 'update-window.js', 'update-config.json', 'updater.py', 'install-protocol.js', 'app.ico', 'app-icon.png']) fs.copyFileSync(path.join(frontend, file), path.join(shell, file));
  fs.cpSync(path.join(frontend, 'dist'), path.join(shell, 'dist'), { recursive: true });
  const envelope = fs.readFileSync(path.join(root, 'builds/updates/2.0.2-20261018125140/envelope.json'));
  server = http.createServer((req, res) => { requests.push({ at: Date.now(), failing }); res.writeHead(failing ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(failing ? '{}' : envelope); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const configFile = path.join(shell, 'update-config.json'), config = JSON.parse(fs.readFileSync(configFile));
  config.releaseId = '00000000000000'; config.manifestUrl = `http://127.0.0.1:${server.address().port}/latest`;
  fs.writeFileSync(configFile, JSON.stringify(config));
  // 拒绝实际资源变更；模块自检和音频API均真实运行。
  fs.writeFileSync(path.join(run, 'harness.cjs'), `const fs=require('fs'),{BrowserWindow}=require('electron'),{RuntimeService}=require(${JSON.stringify(path.join(shell, 'runtime-service.js'))});const original=RuntimeService.prototype.emit;RuntimeService.prototype.emit=function(part){fs.appendFileSync(${JSON.stringify(stateLog)},JSON.stringify({at:Date.now(),...part})+String.fromCharCode(10));if(part.activity==='prepare')throw new Error('验收环境已有全部资源，禁止额外下载或安装');return original.call(this,part)};require(${JSON.stringify(path.join(shell, 'main.js'))});fs.watchFile(${JSON.stringify(mailbox)},{interval:100},()=>{try{for(const e of JSON.parse(fs.readFileSync(${JSON.stringify(mailbox)},'utf8')))for(const w of BrowserWindow.getAllWindows())w.webContents.send('runtime:event',e)}catch{}});`);
  const boot = await launch(true);
  await until(() => client.evaluate("document.querySelector('.update-available-dialog')?.open"));
  const update = await client.evaluate('window.voxcpmDesktop.getUpdateState()');
  assert.equal(update.checkSource, 'startup'); assert.equal(requests.length, 1);
  const states = fs.readFileSync(stateLog, 'utf8').trim().split('\n').map(JSON.parse);
  const ready = states.filter(s => s.phase === 'ready').at(-1);
  assert.ok(requests[0].at >= ready.at);
  assert.ok(states.every(s => s.activity !== 'prepare'));
  checks.push('真实音频服务就绪后才自动检查，可信签名新版弹窗，无资源下载');
  for (const theme of ['light', 'dark']) { await client.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`); await shot('update-available-' + theme); }
  await click('稍后再说');
  await events([{ type: 'update-state', update }]);
  assert.equal(await client.evaluate("document.querySelector('.update-available-dialog').open"), false);
  checks.push('同次启动相同新版不重复弹窗');
  await click('检查更新');
  await until(() => client.evaluate("window.voxcpmDesktop.getUpdateState().then(s=>s.status==='available'&&s.checkSource==='manual')"));
  assert.ok(await client.evaluate("!!document.querySelector('#software-update-panel') && !document.querySelector('.update-available-dialog').open"));
  checks.push('手动检查仍定位设置，不额外弹窗');
  const preparingBoot = { ...boot, type: 'boot', status: 'preparing' };
  await events([preparingBoot, { type: 'runtime-preparation', preparation: { status: 'checking', activity: 'startup', phase: 'models', modelName: 'VoxCPM 2', modelState: 'checking', message: 'VoxCPM 2 模型文件检查中' } }]);
  assert.equal(await client.evaluate("document.querySelector('#runtime-title').textContent"), '音频系统启动中');
  assert.ok(await client.evaluate("!document.querySelector('.runtime-startup-dialog').innerText.includes('补齐') && document.querySelector('.runtime-model-state').textContent.includes('检查中')"));
  for (const theme of ['light', 'dark']) { await client.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`); await shot('model-check-' + theme); }
  await events([{ type: 'runtime-preparation', preparation: { status: 'checking', activity: 'startup', phase: 'models', modelName: 'VoxCPM 2', modelState: 'ready', message: 'VoxCPM 2 模型文件检查完成' } }]);
  assert.ok(await client.evaluate("document.querySelector('.runtime-model-state').textContent.includes('检查完成')"));
  await events([{ type: 'runtime-preparation', preparation: { status: 'checking', activity: 'startup', phase: 'service', modelName: '音频服务', modelState: 'loading', message: '音频服务加载中' } }]);
  assert.equal(await client.evaluate("document.querySelector('progress[aria-label=音频系统启动进度]').hasAttribute('value')"), false);
  await shot('audio-loading'); checks.push('正常模型检查/完成/音频加载使用明确文案与真实阶段进度');
  await events([{ type: 'runtime-preparation', preparation: { status: 'working', activity: 'prepare', phase: 'models', message: '正在下载缺失资源', name: 'missing-model.bin', downloaded: 20, size: 100 } }]);
  assert.equal(await client.evaluate("document.querySelector('progress[aria-label=资源准备进度]').value"), 20);
  await shot('actual-resource-missing');
  await events([{ type: 'runtime-preparation', preparation: { status: 'cancelled', activity: 'prepare', phase: 'models', message: '资源准备已暂停' } }]);
  assert.equal(await client.evaluate("document.querySelector('#runtime-title').textContent"), '资源准备已暂停');
  await events([{ ...boot, type: 'error', status: 'error', detail: '测试音频组件启动失败' }, { type: 'runtime-preparation', preparation: { status: 'error', activity: 'startup', phase: 'service', message: '测试音频组件启动失败' } }]);
  assert.equal(await client.evaluate("document.querySelector('#runtime-title').textContent"), '音频系统启动未完成');
  await events([{ type: 'runtime-preparation', preparation: { status: 'ready', activity: 'startup', phase: 'ready', message: '音频系统启动完成' } }, { ...boot, type: 'ready' }]);
  assert.equal(await client.evaluate("document.querySelector('.runtime-startup-dialog').open"), false);
  checks.push('真实缺失文案、字节进度、暂停/错误/恢复界面夹具通过');
  await stop();
  const beforeDisabled = requests.length;
  await launch(false); await wait(2200);
  assert.equal(requests.length, beforeDisabled);
  assert.equal(await client.evaluate("document.querySelector('.update-available-dialog').open"), false);
  assert.equal(launches[1].cached, true);
  checks.push('连续启动复用已安装环境，关闭自动检查时不请求更新');
  await stop(); failing = true;
  await launch(true);
  await until(() => client.evaluate("window.voxcpmDesktop.getUpdateState().then(s=>s.status==='error')"));
  assert.equal(await client.evaluate("document.querySelector('.update-available-dialog').open"), false);
  assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status, 'ready');
  checks.push('更新网络失败保持工作区可用且不弹错误窗口');
  assert.equal(client.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify({ checks, launches, requests, signedManifestFixture: true, downloads: 0, run }, null, 2));
  console.log('PASS ' + checks.join('；')); console.log(run);
})().catch(async error => { console.error(error); try { if (client) await shot('failure'); } catch {} process.exitCode = 1; }).finally(async () => { await stop(); if (server) await new Promise(resolve => server.close(resolve)); });
