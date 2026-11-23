// 真实 Electron、真实本地 API 与 CUDA 生成。仅文件选择/另存路径由验收脚本注入。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), project = path.join(root, 'frontend/voxcpm_studio_electron');
const appIndex = process.argv.indexOf('--app');
const bundle = appIndex >= 0 ? path.resolve(process.argv[appIndex + 1]) : path.join(root, 'builds/VoxCPM-Studio-Electron-Portable-2.0.1');
const portable = process.argv.includes('--portable') || appIndex >= 0, mode = portable ? 'portable' : 'source';
function option(name, fallback) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; }
const modelVersion = option('--model-version', '1.5'), photoModelVersion = option('--photo-model-version', modelVersion);
const output = path.resolve(root, option('--output', 'builds/lipsync-1.5-validation')), run = path.join(output, `${mode}-${Date.now()}`);
const modelIndex = process.argv.indexOf('--model-root');
const modelRoot = modelIndex >= 0 ? path.resolve(process.argv[modelIndex + 1]) : path.resolve(root, '../data/lipsync');
const python = portable ? path.join(bundle, 'runtime/python/python.exe') : require('./lib/electron_test_runtime.cjs').preparePython(root, run);
const exe = portable ? path.join(bundle, 'VoxCPM Studio.exe') : path.join(project, 'node_modules/electron/dist/electron.exe');
const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(run, 'data'), VOXCPM_PYTHON_EXE: python, VOXCPM_LIPSYNC_ROOT: modelRoot, VOXCPM_MODEL_DIR: path.resolve(root, '../models/openbmb__VoxCPM2') };
delete env.ELECTRON_RUN_AS_NODE;
let child, c, base; const cases = [], states = [];
async function shot(name) { const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, `${mode}-${name}.png`), Buffer.from(r.data, 'base64')); }
async function api(url, body) { const r = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data; }
async function nav() { await c.evaluate("[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()==='视频对口型').click()"); await until(() => c.evaluate("Boolean(document.querySelector('.ls-studio'))")); }
async function click(selector) { await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function generate() {
  await click('.ls-footer .primary-button');
  await until(() => c.evaluate("JSON.parse(localStorage.getItem('voxcpm-lipsync-task')||'null')"));
  const id = await c.evaluate("JSON.parse(localStorage.getItem('voxcpm-lipsync-task'))");
  const finished = await until(async () => { const task = await api(`/api/tasks/${id}`); return ['succeeded','failed','cancelled'].includes(task.status) && task; }, 600000);
  assert.equal(finished.status, 'succeeded', finished.error || finished.statusText);
  await until(() => c.evaluate("!JSON.parse(localStorage.getItem('voxcpm-lipsync-task')||'null')&&!!document.querySelector('.ls-result-preview video')"));
  const task = await api(`/api/tasks/${id}`); assert.equal(task.status, 'succeeded');
  return task.result;
}
(async () => {
  fs.mkdirSync(run, { recursive: true });
  const source = path.join(modelRoot, 'source/assets/demo1_video.mp4');
  const audio = path.join(run, '克隆 配音 & 验收.wav'), photo = path.join(output, 'portrait.png');
  const db = JSON.parse(fs.readFileSync(path.join(root, 'builds/production-validation/data/workspace/workspace.json'), 'utf8'));
  const cloned = db.history.find(item => item.config?.mode === '极致克隆' && fs.existsSync(item.audioPath));
  assert.ok(cloned, '复用上轮真实声音克隆的自产音频');
  const portrait = spawnSync('ffmpeg', ['-v','error','-y','-i',source,'-frames:v','1','-update','1',photo], {windowsHide:true,encoding:'utf8'}); assert.equal(portrait.status,0,portrait.stderr);
  const trim = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', cloned.audioPath, '-t', '1.36', audio], { windowsHide: true, encoding: 'utf8' }); assert.equal(trim.status, 0, trim.stderr);
  child = spawn(exe, [...(portable ? [] : [project]), '--remote-debugging-port=19248', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--user-data-dir=${path.join(run, 'profile')}`], { env, windowsHide: true, stdio: 'ignore' });
  c = await connect(19248);
  await until(() => c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"), 180000);
  base = await c.evaluate("window.voxcpmDesktop.getBootstrapState().then(s=>s.backendBaseUrl)");
  // 将测试素材放入持久草稿，不操作正式用户数据。
  await c.evaluate(`localStorage.setItem('voxcpm-lipsync-draft',JSON.stringify({mode:'video',modelVersion:${JSON.stringify(modelVersion)},video:${JSON.stringify(source)},photo:${JSON.stringify(photo)},audio:${JSON.stringify(audio)},steps:20,guidance:1.5,seed:1247,shortVideo:'loop'}))`);
  await nav(); await until(() => c.evaluate("document.querySelector('.ls-engine').classList.contains('ready')"));
  const hardwareStatus = await api(`/api/lipsync/status?modelVersion=${modelVersion}`);
  assert.equal(hardwareStatus.ready, true);
  assert.equal(await c.evaluate("document.querySelector('#ls-model-version').value"), modelVersion);
  assert.ok((await c.evaluate("document.querySelector('.ls-hardware').textContent")).includes(hardwareStatus.hardware.name));
  cases.push('hardware-detection-and-model-selector');
  for (const [width, height] of [[1544, 941], [1366, 768], [1180, 760], [900, 760]]) for (const theme of ['dark', 'light']) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`); await wait(80);
    const state = await c.evaluate("(()=>{const f=document.querySelector('.ls-footer').getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,footerBottom:f.bottom,footerTop:f.top,bodyScroll:document.documentElement.scrollTop}})()");
    assert.ok(state.scroll <= width && state.footerBottom <= height && state.footerTop > 100); assert.equal(state.bodyScroll, 0);
    states.push({ width, height, theme, ...state }); await shot(`${width}-${theme}`);
  }
  cases.push('eight-layout-states');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await c.evaluate("document.body.dataset.theme='dark'");
  const video = await generate();
  assert.ok(['1.5','1.6'].includes(video.report.selectedVersion));
  assert.equal(video.report.engine, `LatentSync ${video.report.selectedVersion}`);
  assert.equal(video.report.resolution, video.report.selectedVersion === '1.6' ? 512 : 256);
  if (modelVersion !== 'auto') assert.equal(video.report.selectedVersion, modelVersion);
  assert.equal(video.report.requestedVersion, modelVersion);
  assert.ok(Math.abs(video.duration - 1.36) <= .08); assert.equal(video.report.numFrames, 16);
  cases.push('real-video-with-cloned-audio');
  await c.evaluate("document.querySelector('.ls-result-preview video').play()");
  await until(() => c.evaluate("(()=>{const v=document.querySelector('.ls-result-preview video');return v.readyState>=3&&!v.paused&&v.currentTime>.1})()"));
  await shot('real-video-result'); cases.push('real-video-playback');
  // 文件API另存为验证，源/目标MP4逐字节相同。
  const saved = path.join(run, '另存为 成片.mp4'); await api('/api/files/save-as', { sourcePath: video.outputPath, targetPath: saved });
  assert.ok(fs.readFileSync(saved).equals(fs.readFileSync(video.outputPath))); cases.push('save-mp4-unicode-path');
  // 重载恢复已完成作品，照片模式再做一次真实CUDA推理。
  await c.send('Page.reload'); await until(() => c.evaluate("Boolean(document.querySelector('.ps-project-bar'))")); await nav();
  await until(() => c.evaluate("Boolean(document.querySelector('.ls-result-preview video'))"));
  assert.equal(await c.evaluate("document.querySelector('#ls-model-version').value"), modelVersion);
  await c.evaluate(`(()=>{const select=document.querySelector('#ls-model-version');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(photoModelVersion)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => c.evaluate(`document.querySelector('#ls-model-version').value===${JSON.stringify(photoModelVersion)}&&document.querySelector('.ls-engine').classList.contains('ready')`));
  await c.evaluate("[...document.querySelectorAll('.ls-tabs button')].find(e=>e.textContent==='照片说话').click()");
  await until(() => c.evaluate("Boolean(document.querySelector('.ls-source-preview img'))"));
  const photoResult = await generate();
  if (photoResult) { assert.equal(photoResult.mode, 'photo'); if (photoModelVersion !== 'auto') assert.equal(photoResult.report.selectedVersion, photoModelVersion); await c.evaluate("document.querySelector('.ls-result-preview video').play()"); await until(() => c.evaluate("(()=>{const v=document.querySelector('.ls-result-preview video');return v.readyState>=3&&!v.paused&&v.currentTime>.1})()")); await shot('real-photo-result'); cases.push('real-photo-with-cloned-audio-and-playback'); }
  cases.push('result-and-draft-reload');
  // 真正启动一次任务并取消，确认进程可停止、不会记为成功。
  await click('.ls-footer .primary-button');
  await until(() => c.evaluate("JSON.parse(localStorage.getItem('voxcpm-lipsync-task')||'null')"));
  const cancelId = await c.evaluate("JSON.parse(localStorage.getItem('voxcpm-lipsync-task'))");
  await until(async () => {const t=await api(`/api/tasks/${cancelId}`);return t.status==='running'&&t.completed>=3;},60000);
  await api(`/api/tasks/${cancelId}/cancel`, {});
  await until(async () => (await api(`/api/tasks/${cancelId}`)).status === 'cancelled', 30000);
  cases.push('cancel-running-process');
  assert.equal(c.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  const report = { result: 'passed', mode, modelVersion, photoModelVersion, hardwareStatus, cases, states, video, photo: photoResult, clonedAudioSource: cloned.audioPath, javascriptErrors: 0 };
  fs.writeFileSync(path.join(output, `${mode}-result.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'passed', mode, cases, video: video.report, photo: photoResult?.report }, null, 2));
})().catch(async error => { console.error(error); try { if (c) await shot('failure'); } catch {} process.exitCode = 1; }).finally(() => { c?.close(); if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); });
