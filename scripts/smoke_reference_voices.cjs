// 真实 Electron、HTTP API、文件归档和音频解码；文件选择器返回夹具，不执行模型生成。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), project = path.join(root, 'frontend/voxcpm_studio_electron');
const output = path.join(root, 'builds/reference-voice-validation'), run = path.join(output, String(Date.now()));
const data = path.join(run, 'data'), picker = path.join(run, 'picker.json');
const python = require('./lib/electron_test_runtime.cjs').preparePython(root, run);
const exe = path.join(project, 'node_modules/electron/dist/electron.exe');
const env = { ...process.env, VOXCPM_DATA_ROOT: data, VOXCPM_PYTHON_EXE: python,
  VOXCPM_MODEL_DIR: path.resolve(root, '../models/openbmb__VoxCPM2') };
delete env.ELECTRON_RUN_AS_NODE;
let child, c, boot; const cases = [];
function wav(seconds) {
  const rate = 16000, bytes = rate * seconds * 2, b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
async function api(route) { const r = await fetch(boot.backendBaseUrl + route); assert.ok(r.ok); return r.json(); }
async function click(selector) { await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click()})()`); await wait(80); }
async function nav(label) { await c.evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`); await wait(100); }
async function change(selector, value) {
  await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`); await wait(80);
}
async function card(name, label) {
  if (label === '继续设计' || label === '删除音色') {
    await c.evaluate(`(()=>{const a=[...document.querySelectorAll('.ps-voice-card')].find(e=>e.querySelector('h3').textContent===${JSON.stringify(name)}),t=a.querySelector('.ps-voice-more-toggle');if(t.getAttribute('aria-expanded')!=='true'){t.focus();t.click()}})()`); await wait(80);
  }
  await c.evaluate(`(()=>{const a=[...document.querySelectorAll('.ps-voice-card')].find(e=>e.querySelector('h3').textContent===${JSON.stringify(name)}),b=[...a.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}));b.focus();b.click()})()`); await wait(100);
}

async function shot(name) {
  await wait(300); const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(r.data, 'base64'));
}
async function library(count) { await until(() => c.evaluate(`document.querySelectorAll('.ps-voice-card').length===${count}`)); }
async function saved() { await until(() => c.evaluate("document.querySelector('.ps-save-state')?.classList.contains('saved')")); }
async function choose(file, selector) {
  fs.writeFileSync(picker, JSON.stringify({ canceled: false, filePaths: [file] }));
  await click(selector);
  await until(() => c.evaluate(`document.querySelector('.reference-audio-meta span')?.textContent===${JSON.stringify(file)}`));
}
(async () => {
  fs.mkdirSync(run, { recursive: true });
  const original = path.join(run, '原始参考.wav'), replacement = path.join(run, '替换参考.wav');
  fs.writeFileSync(original, wav(2)); fs.writeFileSync(replacement, wav(3));
  const wrapper = path.join(run, 'main.cjs');
  fs.writeFileSync(wrapper, `const fs=require('fs');require('electron').dialog.showOpenDialog=async()=>JSON.parse(fs.readFileSync(${JSON.stringify(picker)},'utf8'));require(${JSON.stringify(path.join(project, 'main.js'))});`);
  child = spawn(exe, [wrapper, '--remote-debugging-port=19241', `--user-data-dir=${path.join(run, 'profile')}`], { cwd: project, env, windowsHide: true, stdio: 'ignore' });
  c = await connect(19241);
  boot = await until(() => c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready'&&s)"), 180000);
  assert.deepEqual(await c.evaluate("[...document.querySelectorAll('.nav-item')].slice(0,2).map(e=>e.textContent.trim())"), ['声音设计与克隆', '配音工作台']);
  cases.push('menu-order');
  await nav('声音设计与克隆');
  await choose(original, '.reference-audio-card-empty');
  assert.equal(await c.evaluate("document.querySelector('.workspace-save-voice').disabled"), true);
  await click('.workspace-save-reference');
  assert.ok(await c.evaluate("document.querySelector('.save-voice-dialog').textContent.includes('无需生成')"));
  await change('#save-voice-name', '收藏参考'); await change('#save-voice-tags', '旁白，自然');
  await click('.save-voice-actions .primary-button'); await library(1);
  let voice = (await api('/api/workspace/voices')).items[0];
  assert.equal(voice.config.mode, '可控克隆'); assert.equal(voice.name, '收藏参考');
  assert.deepEqual(voice.tags, ['旁白', '自然']); assert.equal(voice.previewAudio, undefined);
  assert.deepEqual(fs.readFileSync(voice.config.referenceAudio), fs.readFileSync(original));
  fs.unlinkSync(original); cases.push('save-reference-without-generation-and-own-file');
  await card('收藏参考', '试听');
  await until(() => c.evaluate("(()=>{const a=document.querySelector('.production-studio > audio');return !a.paused&&a.duration===2&&a.currentTime>.1})()"));
  await click('[aria-label="暂停播放"]'); cases.push('preview-after-original-deletion');
  await card('收藏参考', '应用'); await saved();
  const projectId = (await api('/api/workspace/projects')).items[0].id;
  assert.equal((await api('/api/workspace/projects/' + projectId)).roles[0].config.referenceAudio, voice.config.referenceAudio);
  cases.push('apply-reference-to-role');
  await card('收藏参考', '编辑音色');
  await until(() => c.evaluate("Boolean(document.querySelector('.workspace-save-reference'))"));
  assert.equal(await c.evaluate("document.querySelector('.reference-audio-meta span').textContent"), voice.config.referenceAudio);
  await choose(replacement, '.reference-audio-actions button:last-child');
  await change('.panel-card-workspace select', '极致克隆');
  await change('.workspace-reference-panel textarea', '新的参考文本');
  await change('.panel-card-workspace input[type="range"]', 2.7);
  await change('[aria-label="合成文本"]', '编辑后的合成文案');
  await click('.workspace-save-voice');
  assert.equal(await c.evaluate("document.querySelector('#save-voice-name').value"), '收藏参考');
  await change('#save-voice-name', '编辑后的参考'); await change('#save-voice-tags', '更新，克隆');
  await click('.save-voice-actions .primary-button'); await library(1);
  const edited = (await api('/api/workspace/voices')).items[0];
  assert.equal(edited.id, voice.id); assert.equal(edited.createdAt, voice.createdAt);
  assert.equal(edited.config.mode, '极致克隆'); assert.equal(edited.config.promptText, '新的参考文本');
  assert.equal(edited.config.cfgValue, 2.7); assert.equal(edited.sampleText, '编辑后的合成文案');
  assert.deepEqual(edited.tags, ['更新', '克隆']); assert.ok(fs.existsSync(voice.config.referenceAudio));
  assert.equal((await api('/api/workspace/projects/' + projectId)).roles[0].config.referenceAudio, voice.config.referenceAudio);
  fs.unlinkSync(replacement); cases.push('edit-same-record-and-preserve-applied-reference');
  await card('编辑后的参考', '试听');
  await until(() => c.evaluate("(()=>{const a=document.querySelector('.production-studio > audio');return !a.paused&&a.duration===3&&a.currentTime>.1})()"));
  await click('[aria-label="暂停播放"]');
  await card('编辑后的参考', '应用'); await saved();
  assert.equal((await api('/api/workspace/projects/' + projectId)).roles[0].config.referenceAudio, edited.config.referenceAudio);
  cases.push('preview-and-apply-edited-reference');
  for (const [width, height] of [[1544, 941], [1180, 760]]) for (const theme of ['light', 'dark']) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`);
    assert.equal(await c.evaluate('document.documentElement.scrollWidth>innerWidth'), false);
    await shot(`${width}-${theme}-library`);
    await card('编辑后的参考', '编辑音色');
    assert.equal(await c.evaluate("document.querySelector('.workspace-reference-panel textarea').value"), '新的参考文本');
    assert.equal(await c.evaluate("document.querySelector('[aria-label=\"合成文本\"]').value"), '编辑后的合成文案');
    await click('.workspace-save-reference');
    assert.ok(await c.evaluate("(()=>{const d=document.querySelector('.save-voice-dialog'),r=d.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&d.contains(document.activeElement)&&document.documentElement.scrollWidth<=innerWidth})()"));
    await shot(`${width}-${theme}-edit`);
    await click('.save-voice-actions .ghost-button'); await nav('音色库'); await library(1);
  }
  cases.push('edit-dialog-and-library-light-dark-two-sizes');
  await card('编辑后的参考', '继续设计');
  await click('.workspace-save-voice');
  assert.equal(await c.evaluate("document.querySelector('#save-voice-name').value"), '编辑后的参考（新版本）');
  await click('.save-voice-actions .primary-button'); await library(2);
  const voices = (await api('/api/workspace/voices')).items;
  assert.notEqual(voices[0].id, voice.id); cases.push('continue-design-keeps-new-version-behavior');
  await c.evaluate('window.__referenceBeforeReload=true'); await c.send('Page.reload');
  await until(() => c.evaluate("typeof window.__referenceBeforeReload==='undefined'&&Boolean(document.querySelector('.nav-item'))"));
  await nav('音色库'); await library(2);
  assert.deepEqual((await api('/api/workspace/voices')).items, voices); cases.push('reload-persistence');
  const longName = '温柔而坚定的长名称叙述音色测试';
  const seeded = await fetch(boot.backendBaseUrl + '/api/workspace/voices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: longName, tags: ['旁白', '自然'], config: { ...edited.config, control: '温柔自然、节奏舒缓，适合长篇叙述与情绪表达。' } }) });
  assert.ok(seeded.ok);
  await nav('声音设计与克隆'); await nav('音色库'); await library(3);
  for (const [width, height] of [[1544, 941], [1180, 760]]) for (const theme of ['light', 'dark']) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`);
    assert.ok(await c.evaluate(`([...document.querySelectorAll('.ps-voice-card')].every(card=>{const buttons=[...card.querySelectorAll('.ps-voice-card-actions>button')],r=buttons.map(b=>b.getBoundingClientRect());return buttons.length===2&&r[0].top===r[1].top&&r[1].right<=card.getBoundingClientRect().right&&buttons.every(b=>b.scrollWidth<=b.clientWidth)}))`));
    await shot(`${width}-${theme}-library`);
    await click('.ps-voice-more-toggle');
    assert.equal(await c.evaluate("document.querySelectorAll('.ps-voice-card[data-actions-open=true]').length"), 1);
    assert.ok(await c.evaluate("(()=>{const a=document.querySelector('.ps-voice-more-actions'),m=a.getBoundingClientRect(),card=a.closest('.ps-voice-card');return m.left>=0&&m.right<=innerWidth&&m.top>=card.querySelector('.ps-voice-tags').getBoundingClientRect().bottom&&m.bottom<=card.querySelector('.ps-voice-card-footer').getBoundingClientRect().top&&getComputedStyle(a).position==='static'})()"));
    await shot(`${width}-${theme}-menu`);
    await c.evaluate("document.querySelector('.ps-voice-more-toggle[aria-expanded=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await c.evaluate("document.querySelectorAll('.ps-voice-card[data-actions-open=true]').length"), 0);
  }
  await click('.ps-voice-more-toggle');
  await c.evaluate("document.querySelector('[aria-label=\"搜索音色\"]').focus()");
  assert.equal(await c.evaluate("document.querySelectorAll('.ps-voice-card[data-actions-open=true]').length"), 0);
  await click('.ps-voice-more-toggle');
  await c.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  assert.equal(await c.evaluate("document.querySelectorAll('.ps-voice-card[data-actions-open=true]').length"), 0);
  await card(longName, '删除音色'); await library(2);
  cases.push('two-aligned-primary-actions-long-name-inline-more-actions-without-overlap-keyboard-blur-and-delete');
  assert.equal(c.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  const report = { result: 'passed', cases, javascriptErrors: 0, run };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async e => { console.error(e); try { if (c) await shot('failure'); } catch {} process.exitCode = 1; })
  .finally(() => { c?.close(); if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); });
