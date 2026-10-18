/* 真实Electron：已有AI配置、音乐创作、可编辑草稿、模型适配提示和浅深主题。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..');
const run = path.join(root, 'builds/music-ui-live-validation');
const bundle = path.join(root, 'builds/VoxCPM-Studio-Lightweight-2.0.2-music-ai');
const previous = path.resolve(root, '../Electron版本/builds/VoxCPM-Studio-Electron-Portable-2.0.1/runtime/python');
let child, client;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function capture(name) {
  await delay(300);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(run,name),Buffer.from(shot.data,'base64'));
}
async function click(text) {
  await client.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getBoundingClientRect().width>0).click()`);
  await delay(200);
}
async function fill(selector, value) {
  await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
(async()=>{
  fs.mkdirSync(run,{recursive:true});
  for(const name of fs.readdirSync(bundle)) if(name!=='lightweight.json') fs.cpSync(path.join(bundle,name),path.join(run,name),{recursive:true});
  const python=path.join(run,'runtime/python');fs.mkdirSync(python,{recursive:true});
  for(const name of fs.readdirSync(previous)) if(/^(python(?:3|312)?\.(?:exe|dll|zip)|vcruntime.*\.dll)$/.test(name) && !fs.existsSync(path.join(python,name))) fs.copyFileSync(path.join(previous,name),path.join(python,name));
  const pth=path.join(python,'python312._pth'),text=['python312.zip','.',previous,path.join(previous,'Lib/site-packages'),path.join(run,'app/src'),'import site',''].join('\n');
  if(!fs.existsSync(pth)||fs.readFileSync(pth,'utf8')!==text) fs.writeFileSync(pth,text);
  const config=JSON.parse(fs.readFileSync(path.join(run,'resources/app/runtime-config.json')));
  for(const model of config.models) for(const asset of model.files){
    const relative=path.join(model.folder,asset.name),file=path.join(run,'models',relative);
    fs.mkdirSync(path.dirname(file),{recursive:true}); if(!fs.existsSync(file)) fs.linkSync(path.resolve(root,'../models',relative),file);
  }
  fs.mkdirSync(path.join(run,'data/config'),{recursive:true});
  fs.copyFileSync(path.join(root,'builds/music-ai-live-validation/data/config/assistant-providers.json'),path.join(run,'data/config/assistant-providers.json'));
  fs.writeFileSync(path.join(run,'data/component-selection.json'),JSON.stringify({selected:[],removed:[],defaultModel:'ace-xl-turbo'}));
  fs.writeFileSync(path.join(run,'.voxcpm-install.json'),'{}'); // 隔离Electron配置目录，避免影响用户实际窗口。
  const env={...process.env,VOXCPM_DATA_ROOT:path.join(run,'data'),VOXCPM_PYTHON_EXE:path.join(python,'python.exe'),
    VOXCPM_MUSIC_ENGINE_ROOT:path.resolve(root,'../启动准备开发/builds/component-live-validation/runtime/music/20261018-v1'),
    VOXCPM_MUSIC_MODELS_ROOT:path.join(root,'builds/music-ai-live-validation/models')};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(path.join(run,'VoxCPM Studio.exe'),['--voxcpm-run','--remote-debugging-port=19247','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],{cwd:run,env,windowsHide:true,stdio:'ignore'});
  client=await connect(19247);
  await client.evaluate("localStorage.removeItem('voxcpm-music-studio-v1')"); await client.send('Page.reload');
  await until(async()=>{
    const s=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if(s.status==='error') throw new Error(s.detail);return s.status==='ready';
  },240000);
  fs.writeFileSync(path.join(run,'data/component-selection.json'),JSON.stringify({selected:['ace-xl-turbo','minimax-music3','yue2','heartmula'],removed:[],defaultModel:'ace-xl-turbo'}));
  await click('音乐创作');
  await until(()=>client.evaluate("document.querySelector('.music-options select')?.options.length===4"));
  if(await client.evaluate("document.body.getAttribute('data-theme')!=='light'")) { await client.evaluate("document.querySelector('.studio-theme-button').click()"); await delay(250); }
  await fill('.music-idea','创作一首中文史诗歌曲，回望人类五十万年的战争与文明，从石器、青铜到工业时代，苍凉而壮阔，最后走向和平。男中音，不要说唱。');
  await fill('.music-parameter-grid input[type=number]','60');
  await capture('music-before.png');
  await click('AI 创作 / 优化');
  await until(()=>client.evaluate("document.querySelector('.music-ready-label')?.textContent==='已适配当前模型'"),240000);
  assert.ok(await client.evaluate("document.querySelector('textarea[aria-label=最终风格提示词]').value.length>30"));
  await capture('music-ai-light.png');
  await click('歌词');
  const lyrics=await client.evaluate("document.querySelector('textarea[aria-label=最终歌词]').value");
  assert.ok(/[\u4e00-\u9fff]/.test(lyrics));
  await capture('music-lyrics-light.png');
  await client.evaluate("document.querySelector('.studio-theme-button').click()");await delay(300);
  await capture('music-ai-dark.png');
  await click('风格与编曲');
  await client.evaluate("(()=>{const e=document.querySelector('.music-options select');e.value='minimax-music3';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until(()=>client.evaluate("document.querySelector('.music-ready-label').textContent.includes('等待适配')"));
  assert.equal(await client.evaluate("document.querySelector('textarea[aria-label=最终风格提示词]').value.length>0"),true);
  await click('设置');
  await until(()=>client.evaluate("document.querySelectorAll('.assistant-provider').length===1"));
  assert.equal(await client.evaluate("document.querySelector('.assistant-provider input[type=password]').value"),'');
  assert.ok(await client.evaluate("document.querySelector('.assistant-provider input[type=password]').placeholder.includes('已保存')"));
  await capture('assistant-settings-dark.png');
  console.log('PASS 真实音乐页面、4模型、实际AI创作、中文歌词、切换待适配、浅深主题及密钥隐藏');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(client){await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(()=>{});client.close();}
  if(child?.pid) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
});
