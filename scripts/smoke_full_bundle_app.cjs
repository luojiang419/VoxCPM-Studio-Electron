// 实际解压、移动后的全量程序；不借用正式安装目录或开发 Python。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const root = path.resolve(process.argv[2]);
const appDir = path.join(root, 'resources/app'), output = path.resolve(process.argv[3]);
const { RuntimeService, selectProfile } = require(path.join(appDir, 'runtime-service.js'));
let child, client;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  for (const key of Object.keys(process.env)) if (key.startsWith('VOXCPM_')) delete process.env[key];
  process.env.VOXCPM_OFFLINE = '1';
  const service = new RuntimeService({ root, appRoot: path.join(root, 'app'), dataRoot: path.join(root, 'data'), appDir });
  service.prepare = async () => { throw Error('完整双环境应直接选用，不应联网重装'); };
  const cu126 = path.join(root, 'runtime/managed/py312-cu126/python.exe');
  const cu128 = path.join(root, 'runtime/managed/py312-cu128/python.exe');
  const physical = await service.launch({ existingPython: cu128, managed: true });
  assert.equal(physical.python, cu126); // 本机 4070 Ti SUPER。
  service.detect = async () => selectProfile([{ index: '0', name: 'RTX 5090', capability: 12, driver: '580.97' }]);
  const simulated = await service.launch({ existingPython: cu126, managed: true });
  assert.equal(simulated.python, cu128);
  assert.equal(simulated.env.VOXCPM_LOCAL_ASSET_DIRS, path.join(root, 'offline-assets'));
  const config = path.join(root, 'data/config'); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'update-settings.json'), '{"autoCheck":false}');
  const env = { ...process.env, HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', PIP_NO_INDEX: '1',
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  child = spawn(path.join(root, 'JVOX Studio配音系统.exe'), ['--voxcpm-run', '--remote-debugging-port=19291',
    `--user-data-dir=${path.join(root, 'data/validation-profile')}`], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19291);
  const boot = await until(async () => {
    const state = await client.evaluate('window.voxcpmDesktop && window.voxcpmDesktop.getBootstrapState()');
    if (state?.status === 'error') throw Error(state.detail);
    return state?.status === 'ready' && state;
  }, 180000);
  const backend = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/electron_backend_state.json')));
  assert.equal(backend.projectRoot, root); assert.equal(backend.appRoot, path.join(root, 'app'));
  assert.equal(backend.pythonCommand, cu126);
  const health = await (await fetch(boot.backendBaseUrl + '/api/health')).json(); assert.equal(health.ok, true);
  const music = await (await fetch(boot.backendBaseUrl + '/api/music/status')).json();
  assert.equal(music.models.length, 4);
  assert.equal(music.models.find(model => model.id === 'ace-xl-turbo').installed, true);
  await client.evaluate('document.querySelector(".jvox-announcement .jvox-update")?.click()');
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, 'workspace.png'), Buffer.from(screenshot.data, 'base64'));
  const report = { passed: true, root, physicalGpuProfile: 'cu126', simulatedRTX50Profile: 'cu128',
    RTX50PhysicalTest: false, runtimeReinstall: false, borrowedResources: false, health, musicModels: music.models.length,
    aceInstalled: true, python: backend.pythonCommand, offlineAssets: simulated.env.VOXCPM_LOCAL_ASSET_DIRS };
  fs.writeFileSync(path.join(output, 'app-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close();
  if (child && child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
