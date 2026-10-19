/* 实际 MusicStudio/Electron 交互；API 使用隔离夹具，不调用 AI/GPU。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const out = path.join(root, 'builds/music-bilingual-validation');
let child, client;
const checks = [];
const english = 'Mid-tempo boom-bap rap, tribal hand percussion, deep sub bass, sparse bone-flute sample, gritty vinyl texture; dark, primal, cinematic; male rapped vocal with low double-tracked ad-libs; hollow drum intro into a heavy head-nodding groove, then bare drums and voice before a final chanting outro';
const chinese = '中速经典嘻哈说唱，部落手打击乐、深沉的超低音与稀疏骨笛采样，带有粗粝的黑胶质感；氛围黑暗、原始，具有电影感。男声说唱搭配低声双轨即兴应答；空洞鼓声开场，进入厚重、让人随之点头的律动，随后只保留鼓与人声，最后以吟唱收尾。';
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import MusicStudio from ${JSON.stringify(path.join(frontend, 'src/MusicStudio.tsx'))};
import ${JSON.stringify(path.join(frontend, 'src/styles.css'))};
import ${JSON.stringify(path.join(frontend, 'src/studio-shell.css'))};
import ${JSON.stringify(path.join(frontend, 'src/voice-workspace.css'))};
import ${JSON.stringify(path.join(frontend, 'src/light-theme.css'))};
window.calls=[];window.autoOptimize=true;window.failAudio=false;
const english=${JSON.stringify(english)},chinese=${JSON.stringify(chinese)};
const ids=['ace-xl-turbo','minimax-music3','yue2','heartmula'];
window.voxcpmDesktop={openExternal:async()=>{}};
function packet(brief,draft){
  draft=draft||{title:'文明回声',caption:english,captionZh:brief.captionZh||chinese,lyrics:'[Verse]\\n火种照亮荒原',metadata:{bpm:92,keyScale:'D minor',language:'zh',timeSignature:'4/4'},modelId:brief.modelId,instrumental:false,duration:brief.duration,seed:brief.seed};
  const field=brief.modelId==='yue2'?'style':brief.modelId==='minimax-music3'?'caption':'tags';
  return {modelId:brief.modelId,brief,draft,inputs:{[field]:draft.caption,lyrics:draft.lyrics},warnings:[],canGenerate:true,rulesVersion:'fixture'};
}
window.fetch=async(url,options={})=>{
 const body=options.body?JSON.parse(options.body):null;window.calls.push({url,body});let data={};
 if(url.endsWith('/api/music/status'))data={models:ids.map(id=>({id,name:id,ready:true,installed:true,selected:true,size:1024**3})),defaultModel:ids[0],runtimeReady:true,rules:{version:'fixture',models:[]}};
 else if(url.endsWith('/api/assistant/settings'))data={autoOptimizeMusic:localStorage.getItem('music-bilingual-auto-optimize')!=='false',providers:[]};
 else if(url.endsWith('/api/music/results'))data={items:[]};
 else if(url.endsWith('/api/music/compile'))data=packet(body.brief,body.draft);
 else if(url.endsWith('/api/music/compose')){window.prepared=packet(body);data={taskId:'prompt-fixture',status:'queued'};}
 else if(url.endsWith('/api/music/prompt-tasks/prompt-fixture'))data={taskId:'prompt-fixture',status:'succeeded',result:window.prepared};
 else if(url.endsWith('/api/music/generate')){window.audioPacket=body.autoOptimize?packet(body.brief):packet(body.brief,body.draft);data={taskId:'audio-fixture',status:'queued'};}
 else if(url.endsWith('/api/tasks/audio-fixture'))data={taskId:'audio-fixture',status:window.failAudio?'failed':'cancelled',error:'测试：推理未完成，草稿保留',result:{packet:window.audioPacket}};
 return {ok:true,json:async()=>data};
};
createRoot(document.getElementById('root')).render(<main className="panel-shell music-workspace-shell"><MusicStudio backendBaseUrl="http://fixture"/></main>);`;
const style = () => client.evaluate("document.querySelector('textarea[aria-label=最终风格提示词]').value");
const saved = () => client.evaluate("JSON.parse(localStorage.getItem('voxcpm-music-studio-v1'))");
async function click(text) {
  await client.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('按钮不可用：'+${JSON.stringify(text)});b.click();})()`);
}
async function fill(selector, value) {
  await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function ready() {
  await until(() => client.evaluate("document.querySelector('.music-ready-label')?.textContent==='已适配当前模型' && !document.querySelector('.music-brief-actions .primary-button').disabled"));
  await until(() => client.evaluate("document.querySelector('.music-input-preview')?.textContent.includes('lyrics')"));
}
async function capture(name) {
  await client.evaluate("document.querySelector('.music-prompt-card').scrollIntoView({block:'start'})");
  await wait(150);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name), Buffer.from(shot.data, 'base64'));
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await require(path.join(frontend, 'node_modules/esbuild')).build({ stdin: { contents: entry, loader: 'tsx', resolveDir: frontend }, bundle: true, outfile: path.join(out, 'bundle.js'), loader: { '.png': 'dataurl', '.webp': 'dataurl' }, jsx: 'automatic' });
  fs.writeFileSync(path.join(out, 'index.html'), '<html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><body data-theme="dark"><div class="studio-shell" id="root"></div><script src="bundle.js"></script></body></html>');
  fs.writeFileSync(path.join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1500,height:1050,show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false,offscreen:true}});w.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require(path.join(frontend, 'node_modules/electron')).trim(), [path.join(out, 'main.cjs'), '--remote-debugging-port=19484', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19484);
  await client.evaluate("localStorage.removeItem('voxcpm-music-studio-v1');localStorage.removeItem('music-bilingual-auto-optimize')");
  await client.send('Page.reload');
  await until(() => client.evaluate("document.querySelector('.music-options select')?.options.length===4"));
  await fill('.music-idea', '文明与战争，原始部落鼓点的中文说唱');
  await click('AI 创作 / 优化'); await ready();
  assert.equal(await style(), chinese);
  assert.equal((await saved()).packet.draft.caption, english);
  assert.equal(await client.evaluate("document.querySelector('.music-input-preview').textContent.includes('部落')"), false);
  checks.push('默认展示完整中文，详情为配套英文输入，歌词仍为中文');
  await capture('bilingual-dark.png');
  await client.evaluate("document.body.setAttribute('data-theme','light')");
  await capture('bilingual-light.png');

  await click('再次优化 / 创作'); await ready();
  const repeated = await client.evaluate("window.calls.filter(c=>c.url.endsWith('/api/music/compose')).at(-1).body");
  assert.equal(repeated.caption, english); assert.equal(repeated.captionZh, chinese);
  checks.push('再次优化同时携带中英文，保留当前草稿');

  await click('歌词'); await fill('textarea[aria-label=最终歌词]', '[Verse]\n用户编辑的中文歌词');
  await click('风格与编曲');
  const revised = '改成轻快的女声流行曲，钢琴开场，副歌加入弦乐，结尾收束。';
  await fill('textarea[aria-label=最终风格提示词]', revised);
  await until(() => client.evaluate("document.querySelector('.music-ready-label').textContent.includes('中文已修改')"));
  assert.equal((await saved()).packet.draft.captionNeedsAdaptation, true);
  await client.send('Page.reload');
  await until(async () => await style() === revised);
  assert.ok(await client.evaluate("document.querySelector('.music-ready-label').textContent.includes('中文已修改')"));
  await click('生成音乐');
  await until(() => client.evaluate("window.calls.some(c=>c.url.endsWith('/api/music/generate')) && !document.querySelector('.music-brief-actions .primary-button').disabled"));
  const generated = await client.evaluate("window.calls.find(c=>c.url.endsWith('/api/music/generate')).body");
  assert.equal(generated.autoOptimize, true);
  assert.equal(generated.brief.captionZh, revised); assert.equal(generated.brief.caption, '');
  assert.equal(generated.draft, undefined);
  assert.equal(generated.brief.lyrics, '[Verse]\n用户编辑的中文歌词');
  checks.push('中文和歌词编辑后刷新不丢失，直接生成先创作配套双版本，未提交旧英文');

  await ready();
  await client.evaluate('window.failAudio=true');
  await click('生成音乐');
  await until(() => client.evaluate("window.calls.filter(c=>c.url.endsWith('/api/music/generate')).length===2 && !document.querySelector('.music-brief-actions .primary-button').disabled"));
  const cached = await client.evaluate("window.calls.filter(c=>c.url.endsWith('/api/music/generate')).at(-1).body");
  assert.equal(cached.autoOptimize, false); assert.equal(cached.draft.captionZh, revised);
  assert.equal(cached.draft.caption, english);
  await ready();
  checks.push('已配套草稿直接使用英文；推理失败后中英文均保留，重试无需临时翻译');

  for (const model of ['minimax-music3', 'yue2', 'heartmula']) {
    await client.evaluate(`(()=>{const e=document.querySelector('.music-options select');e.value=${JSON.stringify(model)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('AI 适配所选模型'); await ready();
    assert.equal(await style(), revised);
    assert.equal((await saved()).packet.modelId, model);
  }
  checks.push('切换其余三个模型后重新适配并继续显示中文');

  await client.evaluate("localStorage.setItem('music-bilingual-auto-optimize','false');localStorage.setItem('voxcpm-music-studio-v1',JSON.stringify({...JSON.parse(localStorage.getItem('voxcpm-music-studio-v1')),packet:{...window.prepared,draft:{...window.prepared.draft,captionZh:undefined}}}));");
  await client.send('Page.reload');
  await until(() => client.evaluate("document.querySelector('.music-options select')?.options.length===4"));
  assert.equal(await style(), '');
  assert.ok(await client.evaluate("document.querySelector('textarea[aria-label=最终风格提示词]').placeholder.includes('旧草稿')"));
  assert.equal(await client.evaluate("document.querySelector('.workspace-action-bar .primary-button').disabled"), true);
  await click('AI 适配所选模型'); await ready();
  assert.equal(await client.evaluate("document.querySelector('.workspace-action-bar .primary-button').disabled"), false);
  await fill('textarea[aria-label=最终风格提示词]', '新的中文要求');
  assert.equal(await client.evaluate("document.querySelector('.workspace-action-bar .primary-button').disabled"), true);
  checks.push('旧英文草稿提示重新适配，关闭自动创作时阻止旧稿或修改未适配的稿件生成');

  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, fixture: '实际 Electron + MusicStudio，API 使用夹具；未调用 AI/GPU', checks }, null, 2));
  console.log(`PASS 实际 Electron 中英双版本，${checks.length} 项交互检查`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close();
  if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
});
