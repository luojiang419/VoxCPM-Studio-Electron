/* 使用已准备好的本机预览和两条真实作品，验证共用播放器；不调用AI或GPU。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
if (!process.argv[2] || !process.argv[3]) {
  console.error('用法：node scripts/smoke_music_player.cjs <已准备好的本机预览目录> <真实音乐作品目录>');
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
const preview = path.resolve(process.argv[2]);
const fixtures = path.resolve(process.argv[3]);
const run = path.join(root, 'builds/music-player-validation');
const data = path.join(run, 'data');
let child, client, backend;
const checks = [];
async function check(name, probe) { assert.ok(await probe(), name); checks.push(name); }
async function click(text) {
  await client.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getBoundingClientRect().width>0).click()`);
  await wait(200);
}
async function shot(name) {
  await wait(300);
  const image = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(run, name), Buffer.from(image.data, 'base64'));
}
async function fill(selector, value) {
  await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
const audio = expression => client.evaluate(`(()=>{const a=document.querySelector('.workspace-generation-footer audio');return ${expression};})()`);
(async () => {
  fs.mkdirSync(path.join(data, 'outputs/music'), { recursive: true });
  const records = [];
  for (const [index, id] of ['3664c7feff7544649b785be9a58e4650', 'c48349c800d24cc39d1a63ec155ac8f0'].entries()) {
    const source = path.join(fixtures, id);
    const target = path.join(data, 'outputs/music', `player-${index}`);
    fs.mkdirSync(target, { recursive: true });
    const record = JSON.parse(fs.readFileSync(path.join(source, 'result.json'), 'utf8'));
    record.outputPath = path.join(target, 'audio.wav');
    record.previewUrl = '/media?path=' + encodeURIComponent(record.outputPath);
    record.requestPath = path.join(target, 'request.json');
    if (!fs.existsSync(record.outputPath)) fs.linkSync(path.join(source, 'audio.wav'), record.outputPath);
    fs.copyFileSync(path.join(source, 'request.json'), record.requestPath);
    fs.writeFileSync(path.join(target, 'result.json'), JSON.stringify(record));
    records.push(record);
  }
  fs.writeFileSync(path.join(data, 'component-selection.json'), JSON.stringify({ selected: [], removed: [], defaultModel: 'ace-xl-turbo' }));
  const env = { ...process.env, VOXCPM_DATA_ROOT: data, VOXCPM_COMPONENT_REUSE_ROOT: 'G:\\app\\minimax', VOXCPM_PYTHON_EXE: path.join(preview, 'runtime/python/python.exe') };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(preview, 'VoxCPM Studio.exe'), ['--voxcpm-run', '--remote-debugging-port=19248', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { cwd: preview, env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19248);
  await until(async () => {
    const state = await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if (state.status === 'error') throw new Error(state.detail);
    backend = state.backendBaseUrl;
    return state.status === 'ready';
  }, 240000);
  backend = await client.evaluate('(async()=> (await window.voxcpmDesktop.getBootstrapState()).backendBaseUrl)()');
  const assistant = await (await fetch(backend + '/api/assistant/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoOptimizeMusic: true, providers: [{ id: 'sole-assistant', name: '默认创作助手', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', enabled: true }] }) })).json();
  assert.equal(assistant.defaultProviderId, 'sole-assistant');
  await client.evaluate("localStorage.setItem('voxcpm-music-studio-v1',JSON.stringify({brief:{providerId:'obsolete-provider'},autoOptimize:false}))");
  await click('音乐创作');
  await until(() => audio('a && a.duration > 1'));
  await check('创作页隐藏助手与后端设置，显示当前模型特色', async () => client.evaluate("!document.querySelector('.music-backend') && !document.querySelector('.music-ai-pill') && !Array.from(document.querySelectorAll('.music-options h3')).some(e=>e.textContent==='AI 助手') && document.querySelector('.music-model-description').textContent.includes('推荐主力')"));
  for (const id of ['minimax-music3', 'yue2', 'heartmula', 'ace-xl-turbo']) {
    await client.evaluate(`(()=>{const e=document.querySelector('.music-options select');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(100);
    assert.ok(await client.evaluate("document.querySelector('.music-model-description').textContent.length>25"));
  }
  checks.push('切换四模型分别展示特色');
  await check('音乐页仅有一个共用播放器，隐藏保存音色且不自动播放', async () => client.evaluate("document.querySelectorAll('.workspace-generation-footer').length===1 && document.querySelectorAll('audio[controls]').length===0 && !document.querySelector('.workspace-save-voice') && document.querySelector('.workspace-generation-footer audio').paused"));
  const firstSource = await audio('a.src');
  await client.evaluate("document.querySelector('.workspace-mute-button').click();document.querySelector('.workspace-play-button').click()");
  await until(() => audio('!a.paused && a.currentTime > .15'));
  await check('真实WAV播放与静音', () => audio('a.muted && !a.paused'));
  await client.evaluate("document.querySelector('.workspace-play-button').click()");
  await check('暂停', () => audio('a.paused'));
  // 使用真实鼠标输入拖动range，覆盖React事件与音频seek。
  const rect = await client.evaluate("(()=>{const r=document.querySelector('.workspace-audio-seek').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()");
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + rect.w * .2, y: rect.y + rect.h / 2, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w * .6, y: rect.y + rect.h / 2, button: 'left', buttons: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + rect.w * .6, y: rect.y + rect.h / 2, button: 'left', clickCount: 1 });
  await until(() => audio('a.currentTime > a.duration * .5'));
  await check('拖动进度条后从目标位置继续播放', async () => {
    await client.evaluate("document.querySelector('.workspace-play-button').click()");
    await until(() => audio('!a.paused && a.currentTime > a.duration * .5'));
    return true;
  });
  await client.evaluate("window.__previousMusicAudio=document.querySelector('.workspace-generation-footer audio');document.querySelector('.music-layout').scrollTop=100000");
  const bottom = await client.evaluate("document.querySelector('.workspace-generation-footer').getBoundingClientRect().bottom");
  await check('内容滚动时底部播放器保持可见', async () => client.evaluate(`document.querySelector('.music-layout').scrollTop>0 && Math.abs(document.querySelector('.workspace-generation-footer').getBoundingClientRect().bottom-${bottom})<1 && ${bottom}<=innerHeight`));
  await client.evaluate("Array.from(document.querySelectorAll('.music-history > button')).find(b=>b.getAttribute('aria-pressed')==='false').click()");
  await until(() => audio(`a.src!==${JSON.stringify(firstSource)} && a.duration>1 && a.paused && a.currentTime===0`));
  checks.push('切换最近作品停止旧音频并重置进度');
  // 文件导出实际调用已有API；另存对话框与目录按钮保留原生桥接，不弹出用户窗口。
  const exported = path.join(run, 'exported.wav');
  const response = await fetch(backend + '/api/files/save-as', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourcePath: records[0].outputPath, targetPath: exported }) });
  assert.equal(response.status, 200);
  assert.equal(fs.statSync(exported).size, fs.statSync(records[0].outputPath).size);
  checks.push('真实后端另存音频API写出完整WAV');
  await client.evaluate("document.querySelector('.music-layout').scrollTop=0");
  if (await client.evaluate("document.body.getAttribute('data-theme')!=='light'")) await client.evaluate("document.querySelector('.studio-theme-button').click()");
  await shot('music-player-light.png');
  await client.evaluate("document.querySelector('.studio-theme-button').click()");
  await shot('music-player-dark.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
  await check('窄窗口底栏与进度条可见且无横向溢出', async () => client.evaluate("(()=>{const f=document.querySelector('.workspace-generation-footer').getBoundingClientRect(),s=document.querySelector('.workspace-audio-seek').getBoundingClientRect();return f.bottom<=innerHeight && s.width>50 && f.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth;})()"));
  await shot('music-player-compact.png');
  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.evaluate("document.querySelector('.workspace-play-button').click()");
  await until(() => audio('!a.paused'));
  await client.evaluate("void(window.__previousMusicAudio=document.querySelector('.workspace-generation-footer audio'))");
  await click('声音设计与克隆');
  await check('切换语音页停止音乐并保留原语音播放器和保存音色', async () => client.evaluate("window.__previousMusicAudio.paused && !!document.querySelector('footer[aria-label=合成音频播放器]') && !!document.querySelector('.workspace-save-voice')"));
  await shot('voice-player-regression.png');
  await click('音乐创作');
  await until(() => audio('a && a.duration > 1'));
  // 仅替换任务响应，使用真实已有WAV模拟任务完成，不重复调用GPU/AI。
  const completed = { ...records[0], title: '新生成作品 · 底栏验收' };
  await client.evaluate(`(()=>{const original=window.fetch;window.fetch=async (url,options)=>{
    if(String(url).endsWith('/api/music/generate')) {window.__musicGenerationRequest=JSON.parse(options.body);return new Response(JSON.stringify({taskId:'player-fixture',status:'queued'}),{status:200});}
    if(String(url).endsWith('/api/tasks/player-fixture')) {const result=${JSON.stringify(completed)};result.title=window.__musicGenerationRequest.brief.title;return new Response(JSON.stringify({taskId:'player-fixture',status:'succeeded',result}),{status:200});}
    return original(url,options);
  };})()`);
  // 保持真实模型就绪检查，只在隔离数据目录选用本机现有模型。
  fs.writeFileSync(path.join(data, 'component-selection.json'), JSON.stringify({ selected: ['ace-xl-turbo'], removed: [], defaultModel: 'ace-xl-turbo' }));
  await click('声音设计与克隆'); await click('音乐创作');
  await fill('.music-title-input input', '用户填写的歌名');
  await fill('.music-idea', '中文史诗音乐');
  await until(() => client.evaluate("!document.querySelector('.workspace-action-bar .primary-button').disabled"));
  await click('生成音乐');
  await until(() => client.evaluate("document.querySelector('.workspace-now-playing strong')?.textContent==='用户填写的歌名'"));
  await check('任务成功自动载入底栏，等待用户播放', () => audio('a.paused && a.currentTime===0'));
  await check('旧页面助手覆盖失效，使用全局默认助手及自动优化偏好', async () => client.evaluate("window.__musicGenerationRequest.brief.providerId==='' && window.__musicGenerationRequest.autoOptimize===true && !window.__musicGenerationRequest.draft"));
  await fill('.music-final-text', 'Cinematic piano and strings');
  await click('歌词'); await fill('.music-final-text', '[Verse]\n星火照亮和平');
  await until(() => client.evaluate("document.querySelector('.music-ready-label').textContent==='已适配当前模型'"));
  await fill('.music-title-input input', '改名后的歌曲');
  await check('修改作品名保持已适配草稿，不重新请求AI', async () => client.evaluate("document.querySelector('.music-ready-label').textContent==='已适配当前模型'"));
  await click('生成音乐');
  await until(() => client.evaluate("document.querySelector('.workspace-now-playing strong')?.textContent==='改名后的歌曲'"));
  assert.ok(await client.evaluate("window.__musicGenerationRequest.brief.title==='改名后的歌曲' && window.__musicGenerationRequest.autoOptimize===false && !!window.__musicGenerationRequest.draft"));
  await shot('music-player-completed.png');
  await click('设置');
  await until(() => client.evaluate("document.querySelectorAll('.assistant-provider').length===1"));
  await check('设置页单个助手自动成为默认，无重复默认选择器', async () => client.evaluate("!Array.from(document.querySelectorAll('.assistant-settings .field > span')).some(e=>e.textContent==='默认助手') && document.querySelector('.assistant-provider input[type=password]').value===''"));
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify({ checks, note: '播放和另存API使用真实WAV；生成完成采用任务响应夹具，不调用AI/GPU；未操作原生另存对话框和资源管理器。' }, null, 2));
  console.log('PASS ' + checks.join('；'));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (client) { await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(() => {}); client.close(); }
  if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
});
