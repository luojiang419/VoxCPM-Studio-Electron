// 真实EXE/API/魔搭下载；已有主权重可预置到测试目录，独立视频环境必须首次建立。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'builds/lipsync-auto-prepare-validation');
const run = path.join(output, `ui-${Date.now()}`);
const models = path.join(output, '中文 模型');
const bundle = path.join(root, 'builds/VoxCPM-Studio-2.0.2-LipSync-AutoPrepare-Local-20261018');
let child, c, base;
const cases = [];
async function api(url, body) {
  const r = await fetch(base + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
async function nav() {
  await c.evaluate("[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()==='视频对口型').click()");
  await until(() => c.evaluate("Boolean(document.querySelector('.ls-studio'))"));
}
async function screenshot(name) {
  const data = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data.data, 'base64'));
}
(async () => {
  fs.mkdirSync(run, { recursive: true });
  assert.ok(!fs.existsSync(path.join(models, 'env/Scripts/python.exe')), '使用尚未建立视频环境的模型目录');
  const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(run, 'data'), VOXCPM_PYTHON_EXE: path.join(bundle, 'runtime/python/python.exe'),
    VOXCPM_LIPSYNC_ROOT: models, VOXCPM_MODEL_DIR: path.resolve(root, '../models/openbmb__VoxCPM2') };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(bundle, 'VoxCPM Studio.exe'), ['--remote-debugging-port=19250', '--disable-background-timer-throttling', `--user-data-dir=${path.join(run, 'profile')}`], { env, windowsHide: true, stdio: 'ignore' });
  c = await connect(19250);
  await until(() => c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"), 180000);
  base = await c.evaluate("window.voxcpmDesktop.getBootstrapState().then(s=>s.backendBaseUrl)");
  await nav();
  const first = await until(async () => { const status = await api('/api/lipsync/status'); return status.preparing && status; }, 30000);
  assert.equal(first.preferredVersion, '1.6');
  assert.ok(await c.evaluate("document.querySelector('.ls-footer .primary-button').disabled"));
  cases.push('auto-detect-and-start-16-before-generation');
  const id = first.preparationTaskId;
  assert.equal((await api('/api/lipsync/prepare', {})).taskId, id);
  cases.push('duplicate-request-reuses-task');
  const partial = path.join(models, 'tools/ffprobe.exe.part');
  await until(async () => {
    const task = await api(`/api/tasks/${id}`);
    if (task.status === 'failed') throw new Error(task.error);
    return fs.existsSync(partial) && fs.statSync(partial).size > 0 || task.completed >= 20;
  }, 180000);
  await c.evaluate("document.querySelector('.ls-preparation button').click()");
  await until(async () => (await api(`/api/tasks/${id}`)).status === 'cancelled', 30000);
  await until(() => c.evaluate("document.querySelector('.ls-preparation button')?.textContent==='继续补齐'"));
  const partialBytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  await screenshot('paused'); cases.push('pause-keeps-downloaded-parts');
  await c.evaluate("document.querySelector('.ls-preparation button').click()");
  const second = await until(async () => { const s = await api('/api/lipsync/status'); return s.preparationTaskId !== id && s.preparing && s; });
  await c.send('Page.reload');
  await until(() => c.evaluate("Boolean(document.querySelector('.nav-item'))")); await nav();
  await until(() => c.evaluate("Boolean(document.querySelector('.ls-preparation progress'))"));
  await screenshot('preparing'); cases.push('resume-and-attach-after-reload');
  const task = await until(async () => {
    const t = await api(`/api/tasks/${second.preparationTaskId}`);
    return ['failed', 'cancelled', 'succeeded'].includes(t.status) && t;
  }, 1200000);
  assert.equal(task.status, 'succeeded', task.error);
  await until(() => c.evaluate("document.querySelector('.ls-engine')?.classList.contains('ready')&&!document.querySelector('.ls-preparation')"), 30000);
  const ready = await api('/api/lipsync/status');
  assert.equal(ready.needsPreparation, false); assert.equal(ready.selectedVersion, '1.6');
  assert.deepEqual(ready.installedVersions, ['1.6']);
  cases.push('fresh-private-environment-and-correct-model-ready');
  for (const [width, height] of [[1366,768], [1180,760], [900,760]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await wait(80);
    assert.ok(await c.evaluate("document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.ls-footer').getBoundingClientRect().bottom<=innerHeight"));
  }
  await screenshot('ready');
  await c.send('Page.reload'); await until(() => c.evaluate("Boolean(document.querySelector('.nav-item'))")); await nav();
  await until(() => c.evaluate("document.querySelector('.ls-engine')?.classList.contains('ready')"));
  assert.equal((await api('/api/lipsync/status')).preparationTaskId, second.preparationTaskId);
  cases.push('ready-cache-no-new-preparation-after-reload');
  const errors = c.events.filter(e => e.method === 'Runtime.exceptionThrown'); assert.equal(errors.length, 0);
  const report = { result: 'passed', cases, partialBytes, status: ready, taskId: second.preparationTaskId, javascriptErrors: errors.length,
    validationNote: '主权重与共享VAE/Whisper/ONNX由已有本地缓存复用；引擎、ffprobe、视频依赖和torchvision从魔搭实际下载，首次建立专用Python。' };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ result: 'passed', cases, partialBytes }, null, 2));
})().catch(async e => { console.error(e); try { if (c) await screenshot('failure'); } catch {} process.exitCode = 1; })
  .finally(() => { c?.close(); if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); });
