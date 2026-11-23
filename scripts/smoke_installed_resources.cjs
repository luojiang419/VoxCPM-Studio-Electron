/* 实际 Electron/当前 API 直接读取安装目录；不复制权重、不下载、不运行推理。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const repo = path.resolve(__dirname, '..'), frontend = path.join(repo, 'frontend/voxcpm_studio_electron');
const installed = process.env.VOXCPM_INSTALLED_ROOT;
assert.ok(installed && process.env.VOXCPM_INSTALLED_RESOURCES_READONLY === '1', '请通过 validate_local.ps1 读取真实安装目录后运行');
const run = path.join(repo, 'builds/installed-resources-validation', String(Date.now()));
const data = path.join(run, 'data');
let child, client;
function snapshot() {
  const files = [];
  function walk(folder) {
    if (!fs.existsSync(folder)) return;
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(file);
      else { const s = fs.statSync(file); files.push([file, s.size, s.mtimeMs, s.ctimeMs]); }
    }
  }
  // 核对模型和配置的指纹，不导入/遍历几万项 Python 依赖。
  walk(path.join(installed, 'models')); walk(path.join(installed, 'data/config'));
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}
(async () => {
  const before = snapshot();
  fs.mkdirSync(path.join(data, 'config'), { recursive: true });
  fs.writeFileSync(path.join(data, 'config/update-settings.json'), '{"autoCheck":false}');
  fs.writeFileSync(path.join(data, 'config/studio_config.json'), JSON.stringify({ model_dir: 'Z:/obsolete-model', zipenhancer_path: 'Z:/obsolete-denoiser' }));
  fs.writeFileSync(path.join(data, 'component-selection.json'), JSON.stringify({ selected: ['ace-xl-turbo'], removed: [], defaultModel: 'ace-xl-turbo' }));
  const env = { ...process.env, VOXCPM_APP_ROOT: path.join(repo, 'scripts/dev_backend'), VOXCPM_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(run, 'electron.log'), 'a');
  child = spawn(path.join(frontend, 'node_modules/electron/dist/electron.exe'), [frontend, '--voxcpm-run', '--remote-debugging-port=19485', `--user-data-dir=${path.join(run, 'profile')}`],
    { cwd: frontend, env, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  client = await connect(19485);
  const boot = await until(async () => {
    const state = await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if (state.status === 'error') throw new Error(state.detail);
    return state.status === 'ready' && state;
  }, 120000);
  async function api(route) {
    const response = await fetch(boot.backendBaseUrl + route);
    assert.ok(response.ok, route); return response.json();
  }
  const summary = await api('/api/runtime/summary');
  const { settings } = await api('/api/settings');
  const music = await api('/api/music/status');
  const lipsync = await api('/api/lipsync/status');
  const components = await client.evaluate('window.voxcpmDesktop.getComponents()');
  const state = JSON.parse(fs.readFileSync(path.join(data, 'cache/electron_backend_state.json')));
  assert.equal(path.resolve(state.pythonCommand), path.resolve(process.env.VOXCPM_PYTHON_EXE));
  assert.equal(path.resolve(summary.current_model_source), path.resolve(process.env.VOXCPM_MODEL_DIR));
  assert.equal(path.resolve(settings.zipenhancer_path), path.resolve(process.env.ZIPENHANCER_MODEL_PATH));
  assert.equal(path.resolve(lipsync.root), path.resolve(process.env.VOXCPM_LIPSYNC_ROOT));
  assert.equal(path.resolve(summary.data_root), path.resolve(data));
  assert.equal(music.runtimeReady, true);
  assert.equal(music.models.find(m => m.id === 'ace-xl-turbo').ready, true);
  assert.equal(components.options.find(m => m.id === 'ace-xl-turbo').installed, true);
  assert.ok(!fs.existsSync(path.join(run, 'models')));
  assert.ok(!fs.existsSync(path.join(data, 'cache/runtime-downloads')));
  assert.deepEqual(snapshot(), before, '读取安装资源不修改模型或已安装软件配置');
  const report = { passed: true, installedRoot: installed, python: state.pythonCommand, voice: summary.current_model_source,
    asr: path.join(process.env.VOXCPM_MODELS_ROOT, 'iic__SenseVoiceSmall'), denoiser: settings.zipenhancer_path,
    musicModels: process.env.VOXCPM_MUSIC_MODELS_ROOT, musicEngine: process.env.VOXCPM_MUSIC_ENGINE_ROOT,
    lipsync: lipsync.root, installedVideoVersions: lipsync.installedVersions, musicRuntimeReady: music.runtimeReady,
    checkedInstalledFiles: before.length, installedFilesUnchanged: true, staleModelSettingsOverridden: true, copiedModels: 0, modelDownloads: 0, inferenceRun: false };
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, run }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (client) { await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(() => {}); client.close(); }
  if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
