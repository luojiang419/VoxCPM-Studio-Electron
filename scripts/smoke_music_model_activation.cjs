/* 运行真实 MusicStudio/Electron；组件准备和服务使用隔离夹具，不下载模型或调用 AI/GPU。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const out = path.join(root, 'builds/music-model-activation-validation');
const checks = [];
let child, client;
const entry = `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import MusicStudio from ${JSON.stringify(path.join(frontend, 'src/MusicStudio.tsx'))};
import ${JSON.stringify(path.join(frontend, 'src/styles.css'))};
import ${JSON.stringify(path.join(frontend, 'src/studio-shell.css'))};
const ids=['ace-xl-turbo','minimax-music3','yue2','heartmula'];
const reactRoot=createRoot(document.getElementById('root'));
function Harness(){const [screen,setScreen]=useState('music'),[base,setBase]=useState('http://before');window.setScreen=setScreen;window.setBase=setBase;
return screen==='music'?<MusicStudio backendBaseUrl={base}/>:<p>{screen}</p>;}
window.reset=(mode,target,withProfile=true)=>{
  window.mode=mode;window.target=target;window.installed=ids.filter(id=>id!==target);window.calls=[];window.preparing=false;window.prepared=false;
  window.profile=withProfile?{selected:['lipsync',...ids.filter(id=>id!==target&&id!=='heartmula')],removed:[...new Set([target,'heartmula'])],defaultModel:ids.find(id=>id!==target)}:null;
  window.initialProfile=JSON.parse(JSON.stringify(window.profile));
  window.seed={brief:{modelId:ids.find(id=>id!==target),idea:'测试音乐需求',title:'保留作品名',lyrics:'保留输入歌词',instrumental:false},
    packet:{modelId:'old-model',draft:{title:'已有草稿',caption:'cinematic,orchestral',lyrics:'保留最终歌词',metadata:{},modelId:'old-model'},inputs:{},warnings:[],canGenerate:true},preparedKey:'previous',previousWriterKey:'previous'};
  localStorage.setItem('voxcpm-music-studio-v1',JSON.stringify(window.seed));
  reactRoot.render(<Harness key={window.epoch=(window.epoch||0)+1}/>);
};
window.voxcpmDesktop={
  getComponents:async()=>({profile:window.profile}),
  selectComponents:async(value)=>{window.profile=value;window.calls.push({kind:'select',value});if(window.mode==='remount')window.setScreen('准备中');return value;},
  startBackend:()=>new Promise((resolve,reject)=>{window.preparing=true;window.finishPreparation=(ready=true,failed=false)=>{
    window.preparing=false;
    if(failed){reject(new Error('测试：补齐失败'));return;}
    if(ready)window.installed.push(window.target);window.prepared=true;
    if(window.mode==='remount'){window.setBase('http://after');window.setScreen('music');}
    resolve({status:'ready',backendBaseUrl:'http://after'});
  };})
};
window.fetch=async(url,options={})=>{
  window.calls.push({kind:'fetch',url,body:options.body?JSON.parse(options.body):null});
  let data={};
  if(url.endsWith('/api/music/status'))data={models:ids.map(id=>({id,name:id,ready:window.installed.includes(id)&&!!window.profile?.selected.includes(id)&&!window.profile?.removed.includes(id),installed:window.installed.includes(id),selected:!!window.profile?.selected.includes(id),size:1024**3})),defaultModel:window.profile?.defaultModel||ids[0],runtimeReady:true,rules:{version:'fixture',models:[]}};
  else if(url.endsWith('/api/assistant/settings'))data={autoOptimizeMusic:true,providers:[]};
  else if(url.endsWith('/api/music/results'))data={items:[]};
  else if(url.endsWith('/api/music/generate'))data={taskId:'fixture-audio',status:'queued'};
  else if(url.endsWith('/api/tasks/fixture-audio'))data={status:'failed',error:'测试结束，不调用GPU'};
  return {ok:true,json:async()=>data};
};
window.reset('stay','minimax-music3');`;
async function click(label) {
  await client.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
}
async function choose(target) {
  await client.evaluate(`(()=>{const e=document.querySelector('.music-options select');e.value=${JSON.stringify(target)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => client.evaluate(`document.querySelector('.music-options select')?.value===${JSON.stringify(target)} && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='启用并补齐此模型'&&!b.disabled)`));
}
async function reset(mode, target, withProfile = true) {
  await client.evaluate(`window.reset(${JSON.stringify(mode)},${JSON.stringify(target)},${withProfile})`);
  await until(() => client.evaluate("document.querySelector('.music-options select')?.options.length===4 && document.querySelector('.music-model-facts')!==null"));
  await choose(target);
}
const generateDisabled = () => client.evaluate("document.querySelector('.workspace-action-bar .primary-button').disabled");
async function checkDraft(target) {
  const saved = await client.evaluate("JSON.parse(localStorage.getItem('voxcpm-music-studio-v1'))");
  assert.equal(saved.brief.modelId, target);
  assert.equal(saved.brief.idea, '测试音乐需求');
  assert.equal(saved.brief.title, '保留作品名');
  assert.equal(saved.brief.lyrics, '保留输入歌词');
  assert.equal(saved.packet.draft.lyrics, '保留最终歌词');
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await require(path.join(frontend, 'node_modules/esbuild')).build({ stdin: { contents: entry, loader: 'tsx', resolveDir: frontend }, bundle: true, outfile: path.join(out, 'bundle.js'), loader: { '.png': 'dataurl', '.webp': 'dataurl' }, jsx: 'automatic' });
  fs.writeFileSync(path.join(out, 'index.html'), '<html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><body data-theme="dark"><div class="studio-shell" id="root"></div><script src="bundle.js"></script></body></html>');
  fs.writeFileSync(path.join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{let w=new BrowserWindow({width:1500,height:1050,show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false,offscreen:true}});w.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require(path.join(frontend, 'node_modules/electron')).trim(), [path.join(out, 'main.cjs'), '--remote-debugging-port=19483', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19483);
  await until(() => client.evaluate("typeof window.reset==='function' && document.querySelector('.music-model-facts')!==null"));
  for (const mode of ['stay', 'remount']) for (const target of ['ace-xl-turbo', 'minimax-music3', 'yue2', 'heartmula']) {
    await reset(mode, target);
    assert.equal(await generateDisabled(), true);
    await click('启用并补齐此模型');
    await until(() => client.evaluate('window.preparing'));
    const selection = await client.evaluate('({profile:window.profile,initial:window.initialProfile})');
    assert.equal(selection.profile.defaultModel, target);
    assert.deepEqual(selection.profile.selected, [...selection.initial.selected, target]);
    assert.deepEqual(selection.profile.removed, selection.initial.removed.filter(id => id !== target));
    if (mode === 'stay') assert.equal(await generateDisabled(), true);
    else await until(() => client.evaluate("!document.querySelector('.music-options select')"));
    await client.evaluate('window.finishPreparation()');
    await until(() => client.evaluate(`document.querySelector('.music-options select')?.value===${JSON.stringify(target)} && !document.querySelector('.workspace-action-bar .primary-button').disabled`));
    assert.equal(await client.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='启用并补齐此模型')"), false);
    assert.ok(await client.evaluate("window.calls.some(c=>c.url==='http://after/api/music/status')"));
    await checkDraft(target);
    await click('生成音乐');
    await until(() => client.evaluate("window.calls.some(c=>c.url?.endsWith('/api/music/generate'))"));
    const generated = await client.evaluate("window.calls.find(c=>c.url?.endsWith('/api/music/generate')).body");
    assert.equal(generated.brief.modelId, target);
    assert.equal(generated.brief.title, '保留作品名');
    checks.push(`${mode}：${target} 补齐后自动选用、按钮启用、草稿保留及生成请求`);
  }
  await reset('stay', 'heartmula', false);
  await click('启用并补齐此模型');
  await until(() => client.evaluate('window.preparing'));
  assert.deepEqual(await client.evaluate('window.profile'), { selected: ['heartmula'], removed: [], defaultModel: 'heartmula' });
  await client.evaluate('window.finishPreparation()');
  await until(async () => !await generateDisabled());
  checks.push('首次无组件配置仍自动选用目标模型');

  await reset('stay', 'minimax-music3');
  await click('启用并补齐此模型');
  await until(() => client.evaluate('window.preparing'));
  await client.evaluate('window.finishPreparation(false,true)');
  await until(() => client.evaluate("document.body.textContent.includes('测试：补齐失败') && !Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='启用并补齐此模型').disabled"));
  assert.equal(await generateDisabled(), true);
  await checkDraft('minimax-music3');
  checks.push('补齐失败保留草稿，生成禁用且可重试');
  await click('启用并补齐此模型');
  await until(() => client.evaluate('window.preparing'));
  await client.evaluate('window.finishPreparation(false)');
  await until(() => client.evaluate("document.body.textContent.includes('模型尚未就绪')"));
  assert.equal(await generateDisabled(), true);
  checks.push('准备返回但模型未就绪时仍禁用生成');
  await click('启用并补齐此模型');
  await until(() => client.evaluate('window.preparing'));
  await client.evaluate('window.finishPreparation()');
  await until(async () => !await generateDisabled());
  checks.push('失败后再次补齐成功自动恢复生成');
  await client.evaluate("document.querySelector('.workspace-action-bar').scrollIntoView({block:'end'})");
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'activated.png'), Buffer.from(shot.data, 'base64'));
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, fixture: '组件准备/音乐 API 夹具，无下载和 AI/GPU 调用', checks }, null, 2));
  console.log(`PASS 真实 Electron 音乐模型补齐，${checks.length} 项交互检查`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close();
  if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
});
