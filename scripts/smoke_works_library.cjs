/* 真实应用与本地 API；隔离作品夹具，不调用 AI/GPU，不修改正式安装。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const out = path.join(root, 'builds/works-library-validation', String(Date.now()));
const data = path.join(out, 'data');
let child, client, base;
const checks = [], layouts = [];
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function wav(file) {
  const rate = 24000, samples = rate * 4, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 440) * 1500), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buffer);
}
async function click(text) {
  const ok = await client.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&b.getBoundingClientRect().width>0);if(!b)return false;b.click();return true;})()`);
  assert.ok(ok, `找不到按钮 ${text}`); await wait(100);
}
async function fill(value) {
  await client.evaluate(`(()=>{const e=document.querySelector('[aria-label="搜索作品"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(100);
}
async function capture(name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function works() { await click('作品记录'); await until(() => client.evaluate("document.querySelector('.works-content')?.getAttribute('aria-busy')==='false' && !!document.querySelector('.works-row')")); }
(async () => {
  if (process.env.VOXCPM_INSTALLED_RESOURCES_READONLY !== '1') throw new Error('请通过 validate_local.ps1 -Script scripts/smoke_works_library.cjs 运行，复用安装资源');
  const audio = path.join(data, 'fixtures/清晨 # 音频.wav'); wav(audio);
  const video = path.join(data, 'lipsync-jobs/photo/output.mp4'); fs.mkdirSync(path.dirname(video), { recursive: true });
  const ffmpeg = path.resolve(root, '../runtime/ffmpeg/bin/ffmpeg.exe');
  const encoded = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x30263d:s=512x288:r=24:d=4', '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { windowsHide: true, encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.stderr);
  const config = { mode: '声音设计', control: '温暖柔和', referenceAudio: '', promptText: '', selectedLora: '不使用 LoRA', cfgValue: 2, normalize: false, denoise: false, inferenceTimesteps: 10 };
  const project = { id: 'history-project', name: '城市来信 · 双人配音', roles: [{ id: 'narrator', name: '旁白', color: '#f6a66d', config, volume: 1, pan: 0 }], segments: [], backgroundMusic: { path: '', volume: .2 }, createdAt: '2026-10-19T11:00:00', updatedAt: '2026-10-20T11:00:00' };
  const history = [
    { id: 'voice-1', kind: 'single', text: '清晨的第一束光，落在窗台。', projectName: '单条创作', config, audioPath: audio, duration: 4, createdAt: '2026-10-20T11:30:00' },
    { id: 'voice-2', kind: 'single', text: '每一次出发，都有新的故事。', projectName: '单条创作', config: { ...config, mode: '可控克隆' }, audioPath: audio, duration: 4, createdAt: '2026-10-19T10:30:00' },
    { id: 'voice-missing', kind: 'single', text: '原文件已移动的历史声音', projectName: '单条创作', audioPath: path.join(data, 'missing.wav'), duration: 4, createdAt: '2026-10-18T10:30:00' },
    { id: 'dubbing-1', kind: 'export', projectId: project.id, projectName: project.name, audioPath: audio, duration: 4, createdAt: '2026-10-20T12:30:00' },
    { id: 'dubbing-2', kind: 'segment', segmentId: 's1', projectId: project.id, projectName: project.name, text: '你听，这座城市也有自己的声音。', audioPath: audio, duration: 4, createdAt: '2026-10-20T12:00:00' },
  ];
  json(path.join(data, 'workspace/workspace.json'), { projects: [project], voices: [], history });
  for (let i = 0; i < 9; i++) {
    const target = path.join(data, `outputs/music/song-${i}/audio.wav`); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(audio, target);
    json(path.join(path.dirname(target), 'result.json'), { title: `山海回响 ${i + 1}`, outputPath: target, duration: 4, modelId: 'yue2', createdAt: `2026-10-${String(i + 10).padStart(2, '0')}T13:00:00`, packet: { draft: { captionZh: '中国西域风格的器乐主题，弦乐与拨弦交织。' } } });
  }
  json(path.join(path.dirname(video), 'result.json'), { outputPath: video, mode: 'photo', sourcePath: '老照片的故事.png', duration: 4 });
  const video2 = path.join(data, 'lipsync-jobs/video/output.mp4'); fs.mkdirSync(path.dirname(video2), { recursive: true }); fs.copyFileSync(video, video2);
  json(path.join(path.dirname(video2), 'result.json'), { outputPath: video2, mode: 'video', sourcePath: '秋日散步.mp4', duration: 4 });
  const batch = path.join(data, 'outputs/batch/20261020_有声读物'); fs.mkdirSync(batch, { recursive: true });
  const rows = [1, 2].map(index => { const name = `00${index}.wav`; fs.copyFileSync(audio, path.join(batch, name)); return { index, text: `有声读物第 ${index} 句`, output_file: name }; });
  json(path.join(batch, 'manifest.json'), rows);
  const archive = spawnSync(process.env.VOXCPM_PYTHON_EXE, ['-c', 'import sys,zipfile,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(str(p)+".zip","w"); [z.write(f,f.name) for f in p.iterdir()]; z.close()', batch], { windowsHide: true, encoding: 'utf8' });
  assert.equal(archive.status, 0, archive.stderr);
  json(path.join(data, 'config/studio_config.json'), { output_dir: path.join(data, 'outputs') });
  json(path.join(data, 'component-selection.json'), { selected: [], removed: [], defaultModel: 'ace-xl-turbo' });
  const launcher = path.join(out, 'launch.cjs');
  fs.writeFileSync(launcher, `const {app,dialog,shell}=require('electron');const fs=require('node:fs'),path=require('node:path');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});dialog.showSaveDialog=async(_w,o)=>({canceled:false,filePath:path.join(${JSON.stringify(out)},'exported.'+path.extname(o.defaultPath).slice(1))});shell.showItemInFolder=file=>fs.writeFileSync(${JSON.stringify(path.join(out, 'located.txt'))},file);require(${JSON.stringify(path.join(frontend, 'main.js'))});`);
  const env = { ...process.env, VOXCPM_APP_ROOT: path.join(root, 'scripts/dev_backend'), VOXCPM_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(frontend, 'node_modules/electron/dist/electron.exe'), [launcher, '--remote-debugging-port=19489', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19489);
  await until(async () => {
    const state = await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if (state.status === 'error') throw new Error(state.detail);
    base = state.backendBaseUrl; return state.status === 'ready';
  }, 180000);
  await until(() => client.evaluate("!!document.querySelector('.ps-project-name input')"));
  // 品牌公告属于隔离资料；关闭后再验收主界面。
  await client.evaluate("document.querySelector('.jvox-update')?.click()");
  await until(() => client.evaluate("document.querySelector('.studio-shell').getBoundingClientRect().width>0"));
  await works();
  assert.equal((await (await fetch(base + '/api/workspace/works')).json()).items.length, 18);
  assert.equal(await client.evaluate("document.querySelectorAll('.works-section').length"), 5);
  assert.equal(await client.evaluate("!!document.querySelector('.works-library .ps-project-bar') || !!document.querySelector('.works-library .ps-footer-actions')"), false);
  checks.push('真实 API 汇总五类18件作品；作品页独立于项目，无合成控件');
  for (const [width, height] of [[1932, 1178], [1366, 768], [1180, 760], [900, 760]]) {
    for (const theme of ['dark', 'light']) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await client.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)};document.querySelector('.works-content').scrollTop=0`); await wait(100);
      const state = await client.evaluate("(()=>{const e=document.querySelector('.works-content');return {scroll:document.documentElement.scrollWidth, body:document.body.scrollWidth, client:e.clientWidth, content:e.scrollWidth, height:e.getBoundingClientRect().bottom, rowHeight:document.querySelector('.works-row').getBoundingClientRect().height};})()");
      assert.ok(state.scroll <= width && state.body <= width && state.content <= state.client + 1 && state.height <= height + 1 && state.rowHeight < 140, JSON.stringify(state));
      layouts.push({ width, height, theme, ...state }); await capture(`works-${width}-${theme}`);
    }
  }
  checks.push('四个窗口尺寸、深浅主题，共8种布局，无横向溢出与拉伸行');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.evaluate("document.body.dataset.theme='dark';document.querySelector('.works-tone-music.works-category').click()");
  assert.equal(await client.evaluate("document.querySelectorAll('.works-row').length"), 6);
  await click('显示更多作品 · 还有 3 件');
  assert.equal(await client.evaluate("document.querySelectorAll('.works-row').length"), 9);
  await fill('山海回响 2'); assert.equal(await client.evaluate("document.querySelectorAll('.works-row').length"), 1);
  await fill('不存在的作品'); assert.ok(await client.evaluate("document.querySelector('.works-state h3').textContent.includes('没有找到')"));
  await click('重置筛选');
  checks.push('分类计数、展开全部记录、中文搜索与重置空态');
  await client.evaluate("document.querySelector('[aria-label=\"作品排序\"]').value='oldest';document.querySelector('[aria-label=\"作品排序\"]').dispatchEvent(new Event('change',{bubbles:true}))"); await wait(100);
  assert.ok(await client.evaluate("document.querySelector('.works-tone-voice.works-section .works-row h3').textContent.includes('原文件已移动')"));
  assert.equal(await client.evaluate("document.querySelector('.works-tone-voice.works-section .works-row .works-preview-button').disabled"), true);
  checks.push('按时间排序与缺失文件禁用预览');
  await client.evaluate("document.querySelector('.works-tone-voice.works-section .works-row:nth-child(2) .works-preview-button').click()");
  await until(() => client.evaluate("document.querySelector('.works-audio-player audio')?.duration>1 && !document.querySelector('.works-audio-player audio').paused"));
  const url = await client.evaluate("document.querySelector('.works-audio-player audio').src");
  assert.ok(url.includes('%23'));
  await capture('works-audio-playing');
  await client.evaluate("document.querySelector('.works-tone-music.works-section .works-preview-button').click()");
  await until(() => client.evaluate(`document.querySelector('.works-audio-player audio')?.src!==${JSON.stringify(url)} && document.querySelector('.works-audio-player audio').duration>1`));
  assert.equal(await client.evaluate("document.querySelectorAll('.works-audio-player audio').length"), 1);
  checks.push('真实 WAV 解码播放，切换作品共用播放器');
  await client.evaluate("document.querySelector('.works-tone-video.works-section .works-preview-button').click()");
  await until(() => client.evaluate("document.querySelector('.works-video-dialog video')?.readyState>=2"));
  assert.equal(await client.evaluate("document.querySelectorAll('.works-audio-player audio').length"), 0);
  await capture('works-video-preview');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await until(() => client.evaluate("!document.querySelector('.works-video-dialog')"));
  checks.push('真实 MP4 预览、切换停止音频、Escape关闭视频');
  // 仅替换主进程原生对话框的返回路径；按钮、IPC、文件写入仍运行真实应用代码。
  const exportTarget = path.join(out, 'exported.wav');
  await client.evaluate("document.querySelector('.works-tone-voice.works-section .works-row:nth-child(2) [aria-label^=\"导出作品\"]').click()");
  await until(() => fs.existsSync(exportTarget)); assert.deepEqual(fs.readFileSync(exportTarget), fs.readFileSync(audio));
  await client.evaluate("document.querySelector('.works-tone-voice.works-section .works-row:nth-child(2) [aria-label^=\"定位文件\"]').click()");
  await until(() => fs.existsSync(path.join(out, 'located.txt'))); assert.equal(fs.readFileSync(path.join(out, 'located.txt'), 'utf8'), audio);
  await client.evaluate("document.querySelector('.works-tone-batch.works-section .ps-text-button').closest('section').querySelector('.works-row .ps-text-button').click()");
  await until(() => fs.existsSync(path.join(out, 'exported.zip'))); assert.deepEqual(fs.readFileSync(path.join(out, 'exported.zip')), fs.readFileSync(batch + '.zip'));
  checks.push('实际点击文件定位、音频导出和整批 ZIP 导出，IPC/API及导出字节正确');
  await client.evaluate("document.querySelector('.works-tone-dubbing.works-section .ps-text-button').click()");
  await until(() => client.evaluate("document.querySelector('.ps-project-name input')?.value==='城市来信 · 双人配音'"));
  await works();
  await client.evaluate("Array.from(document.querySelectorAll('.works-tone-voice.works-section .works-row')).find(e=>e.textContent.includes('清晨的第一束光')).querySelector('.ps-text-button').click()");
  await until(() => client.evaluate("document.querySelector('[aria-label=\"合成文本\"]')?.value==='清晨的第一束光，落在窗台。'"));
  checks.push('打开原配音工程，单条声音恢复原文与音色配置');
  await works();
  // 模拟连接失败，保留已经读取的作品并允许重试。
  await client.evaluate("window.__worksFetch=window.fetch;window.fetch=(url,options)=>String(url).endsWith('/api/workspace/works')?Promise.reject(new Error('验收：连接中断')):window.__worksFetch(url,options)");
  await click('刷新记录');
  await until(() => client.evaluate("!!document.querySelector('.works-library [role=alert]')"));
  assert.ok(await client.evaluate("document.querySelectorAll('.works-row').length>0"));
  await client.evaluate("window.fetch=window.__worksFetch"); await click('刷新记录');
  await until(() => client.evaluate("!document.querySelector('.works-library [role=alert]') && document.querySelector('.works-content').getAttribute('aria-busy')==='false'"));
  checks.push('刷新失败保留作品、明确提示且重连可恢复');
  await client.evaluate("window.fetch=(url,options)=>String(url).endsWith('/api/workspace/works')?Promise.resolve(new Response(JSON.stringify({items:[],warnings:[]}))):window.__worksFetch(url,options)");
  await click('刷新记录');
  await until(() => client.evaluate("document.querySelectorAll('.works-section-empty').length===5 && document.querySelectorAll('.works-row').length===0"));
  await capture('works-empty-sections');
  await client.evaluate("window.fetch=window.__worksFetch"); await click('刷新记录');
  await until(() => client.evaluate("document.querySelectorAll('.works-row').length>0"));
  checks.push('首次无作品时展示五个功能空态与对应创作入口');
  const errors = client.events.filter(e => e.method === 'Runtime.exceptionThrown');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  json(path.join(out, 'result.json'), { ok: true, fixture: '完整 Electron + 真实 Python API；隔离音视频夹具；未调用GPU或AI', checks, layouts });
  console.log(`PASS 作品记录，${checks.length} 项复合验收；证据 ${out}`);
})().catch(async error => { console.error(error); if (client) { await capture('failure').catch(() => {}); fs.writeFileSync(path.join(out, 'failure.txt'), await client.evaluate('document.body.innerText').catch(() => '无法读取界面')); } process.exitCode = 1; }).finally(() => {
  client?.close(); if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
