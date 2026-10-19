/* 当前轻量桌面包真实启动：工作区门禁、组件管理、自检及本地模型复用。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, 'builds/component-live-validation');
const bundle = path.join(repo, 'builds/VoxCPM-Studio-Lightweight-2.0.2-components');
const previous = path.resolve(repo, '../Electron版本/builds/VoxCPM-Studio-Electron-Portable-2.0.1/runtime/python');
const sourceModels = path.resolve(repo, '../models');
const sourceShell = path.join(repo, 'frontend/voxcpm_studio_electron');
let client, child;
async function screenshot(name) {
  await client.evaluate('Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 250))])');
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, name), Buffer.from(result.data, 'base64'));
}
(async () => {
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(bundle)) {
    if (entry === 'lightweight.json') continue; // 本次用独立Python核心引用已验证的旧依赖，不创建第二份CUDA。
    fs.cpSync(path.join(bundle, entry), path.join(root, entry), { recursive: true });
  }
  const appDir = path.join(root, 'resources/app');
  for (const name of ['main.js','window-behavior.js','preload.js','component-service.js','install-protocol.js','music-config.json','runtime-service.js','updater.py']) fs.copyFileSync(path.join(sourceShell,name),path.join(appDir,name));
  fs.cpSync(path.join(sourceShell,'dist'),path.join(appDir,'dist'),{recursive:true});
  for (const name of ['music_worker.py','music_install.py']) fs.copyFileSync(path.join(repo,'backend/voxcpm',name),path.join(root,'app/src/voxcpm',name));
  const python = path.join(root, 'runtime/python'); fs.mkdirSync(python,{recursive:true});
  for (const name of fs.readdirSync(previous)) if (/^(python(?:3|312)?\.(?:exe|dll|zip)|vcruntime.*\.dll)$/.test(name)) fs.copyFileSync(path.join(previous,name),path.join(python,name));
  const pth=path.join(python,'python312._pth'), pthContent=['python312.zip','.',previous,path.join(previous,'Lib/site-packages'),path.join(root,'app/src'),'import site',''].join('\n');
  if(!fs.existsSync(pth)||fs.readFileSync(pth,'utf8')!==pthContent) fs.writeFileSync(pth,pthContent);
  const config=JSON.parse(fs.readFileSync(path.join(appDir,'runtime-config.json')));
  for(const model of config.models) for(const file of model.files) {
    const relative=path.join(model.folder,file.name), target=path.join(root,'models',relative);
    fs.mkdirSync(path.dirname(target),{recursive:true}); if(!fs.existsSync(target)) fs.linkSync(path.join(sourceModels,relative),target);
  }
  fs.mkdirSync(path.join(root,'data'),{recursive:true});
  fs.writeFileSync(path.join(root,'data/component-selection.json'),JSON.stringify({selected:[],removed:['heartmula'],defaultModel:'ace-xl-turbo'}));
  const environment={...process.env,VOXCPM_COMPONENT_REUSE_ROOT:'G:\\app\\minimax',VOXCPM_DATA_ROOT:path.join(root,'data'),VOXCPM_PYTHON_EXE:path.join(python,'python.exe')};
  delete environment.ELECTRON_RUN_AS_NODE;
  child=spawn(path.join(root,'VoxCPM Studio.exe'),['--remote-debugging-port=19246','--voxcpm-run','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],{cwd:root,env:environment,windowsHide:true,stdio:'ignore'});
  client=await connect(19246);
  await until(()=>client.evaluate("document.querySelector('.startup-gate') !== null"));
  assert.equal(await client.evaluate("document.querySelector('.sidebar') === null"),true);
  await screenshot('startup-gate.png');
  await until(async()=>{
    const state=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if(state.status==='error') throw new Error(state.detail); return state.status==='ready';
  },180000);
  assert.equal(await client.evaluate("document.querySelector('.startup-gate') === null"),true);
  await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='功能与模型管理' && b.getBoundingClientRect().width>0).click()");
  await until(()=>client.evaluate("Array.from(document.querySelectorAll('dialog[open][aria-label=\"功能与模型管理\"]')).some(d=>d.getBoundingClientRect().width>100)"));
  assert.equal(await client.evaluate("Array.from(document.querySelectorAll('dialog[open]')).filter(d=>d.getBoundingClientRect().width>100).flatMap(d=>[...d.querySelectorAll('input[role=switch]')]).length"),5);
  await screenshot('component-manager.png');
  await client.evaluate('window.voxcpmDesktop.selectComponents({selected:["ace-xl-turbo"],removed:["heartmula"],defaultModel:"ace-xl-turbo"})');
  await client.evaluate('void window.voxcpmDesktop.startBackend().catch(e => console.error(e))');
  await until(async()=> (await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status==='ready', 600000);
  const ready=JSON.parse(fs.readFileSync(path.join(root,'data/cache/component-ready.json')));
  assert.deepEqual(ready.selected,['ace-xl-turbo']);
  const profile=JSON.parse(fs.readFileSync(path.join(root,'data/component-selection.json')));
  assert.deepEqual(profile.removed,['heartmula']);
  await screenshot('workspace-ready.png');
  console.log('PASS 真实启动门禁、5项切换开关、移除状态保留及ACE资源复用、自检完成');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(client) { await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(()=>{}); client.close(); }
  if(child?.pid) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
});
