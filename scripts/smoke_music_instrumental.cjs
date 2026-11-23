/* 实际 MusicStudio/Electron 交互；API 使用隔离夹具，不调用 AI/GPU。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const out = path.join(root, 'builds/music-instrumental-validation');
let child, client;
const checks = [];
const english = 'Fully instrumental cinematic piano and strings, recurring motif, spacious intro, layered development, luminous climax and resolved outro; no vocals';
const chinese = '全器乐电影配乐，钢琴与弦乐，主题动机从疏朗前奏逐步发展，高潮后完整收束，无人声。';
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
  draft=draft||{title:'文明回声',caption:english,captionZh:brief.captionZh||chinese,lyrics:brief.instrumental?'':brief.lyrics||'[Verse]\\n保留原来的歌词',metadata:{bpm:92,keyScale:'D minor',language:'zh',timeSignature:'4/4'},modelId:brief.modelId,instrumental:brief.instrumental,duration:brief.duration,seed:brief.seed};
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
  await require(path.join(frontend, 'node_modules/esbuild')).build({ stdin: { contents: entry, loader: 'tsx', resolveDir: frontend }, bundle: true, outfile: path.join(out, 'bundle.js'), jsx: 'automatic' });
  fs.writeFileSync(path.join(out, 'index.html'), '<html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><body data-theme="dark"><div class="studio-shell" id="root"></div><script src="bundle.js"></script></body></html>');
  fs.writeFileSync(path.join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1500,height:1050,show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false,offscreen:true}});w.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require(path.join(frontend, 'node_modules/electron')).trim(), [path.join(out, 'main.cjs'), '--remote-debugging-port=19485', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19485);
  await client.evaluate("localStorage.clear()"); await client.send('Page.reload');
  await until(() => client.evaluate("document.querySelector('.music-options select')?.options.length===4"));
  await fill('.music-idea', '中国西域风格，从丝绸之路的繁盛走向河西走廊的苍凉');
  await click('AI 创作 / 优化'); await ready();
  assert.equal((await saved()).brief.lyrics, '');
  assert.equal((await saved()).packet.draft.lyrics, '[Verse]\n保留原来的歌词');
  await client.evaluate("document.querySelector('.music-brief-actions input').click()");
  for (const model of ['ace-xl-turbo', 'minimax-music3', 'yue2', 'heartmula']) {
    await client.evaluate(`(()=>{const e=document.querySelector('.music-options select');e.value=${JSON.stringify(model)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => client.evaluate("!document.querySelector('.workspace-action-bar .primary-button').disabled"));
    await click('生成音乐');
    await ready();
    let request = await client.evaluate("window.calls.filter(c=>c.url.endsWith('/api/music/generate')).at(-1).body");
    assert.equal(request.brief.modelId, model); assert.equal(request.brief.instrumental, true); assert.equal(request.autoOptimize, true);
    assert.equal((await saved()).packet.draft.lyrics, '');
    assert.equal(await client.evaluate("document.querySelectorAll('.music-tabs button')[1].disabled"), true);
    assert.equal(await client.evaluate("document.querySelectorAll('.music-parameter-grid select')[0].value"), 'unknown');
    await until(() => client.evaluate("!document.querySelector('.workspace-action-bar .primary-button').disabled"));
    await click('生成音乐'); await ready();
    request = await client.evaluate("window.calls.filter(c=>c.url.endsWith('/api/music/generate')).at(-1).body");
    assert.equal(request.autoOptimize, false); assert.equal(request.draft.instrumental, true); assert.equal(request.draft.lyrics, '');
    checks.push(`${model} 纯音乐首次自动适配及再次直接生成，空歌词，失败保稿，按钮可用`);
  }
  await capture('instrumental-dark.png');
  await client.evaluate("document.body.setAttribute('data-theme','light')"); await capture('instrumental-light.png');
  await client.send('Page.reload'); await ready();
  assert.equal((await saved()).brief.instrumental, true);
  await client.evaluate("document.querySelector('.music-brief-actions input').click()");
  assert.equal(await client.evaluate("document.querySelectorAll('.music-tabs button')[1].disabled"), false);
  assert.equal(await client.evaluate("document.querySelectorAll('.music-parameter-grid select')[0].value"), 'auto');
  assert.equal((await saved()).brief.lyrics, '[Verse]\n保留原来的歌词');
  await click('AI 适配所选模型'); await ready();
  assert.equal((await saved()).packet.draft.lyrics, '[Verse]\n保留原来的歌词');
  checks.push('刷新保留纯音乐状态；关闭后恢复歌词编辑、歌词语言与原始歌词');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ok:true, fixture:'实际 Electron + MusicStudio，隔离 API，未调用 GPU', checks}, null, 2));
  console.log(`PASS 纯音乐，${checks.length} 项复合交互检查`);
})().catch(error => { console.error(error); process.exitCode=1; }).finally(() => {
  client?.close();
  if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true});
});
