/* 实际 Electron/API + 原生按钮/UIA + 本地签名更新；仅操作本次隔离副本。 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), {spawn, spawnSync, execFileSync} = require('node:child_process');
const {connect, until, wait} = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const run = path.join(root, 'builds/startup-updater-prompt-validation', String(Date.now()));
const shell = path.join(run, 'resources/app'), data = path.join(run, 'data'), cache = path.join(data, 'cache/updates');
const stage = path.join(run, 'package-stage'), checks = [], requests = [];
let child, client, server, latest, packageBytes, failManifest = false, failPackage = false;
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8',windowsHide:true}).trim();
const oldRelease = '20991019000001', newRelease = '20991019000002';
function folders(prefix) { return fs.existsSync(cache) ? fs.readdirSync(cache).filter(n=>n.startsWith(prefix)).map(n=>path.join(cache,n)) : []; }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function prompt() {
  return until(()=>folders('prompt-').map(folder=>({folder,file:path.join(folder,'prompt-ready.json')})).filter(p=>fs.existsSync(p.file)&&!fs.existsSync(path.join(p.folder,'choice.json'))).map(p=>({...read(p.file),folder:p.folder})).find(p=>{
    try { process.kill(p.hostPid,0); return read(path.join(p.folder,'prompt-state.json')).status!=='closed'; } catch { return false; }
  }));
}
function nativeButton(pid,name) {
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/lib/invoke_updater_button.ps1'),'-UpdaterProcessId',String(pid),'-ButtonName',name],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(result.status,0,result.stderr || result.stdout);
}
function nativeShot(pid,name) {
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/capture_update_window.ps1'),'-UpdaterProcessId',String(pid),'-OutputPath',path.join(run,name+'.png')],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);
}
async function click(text) { await client.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getBoundingClientRect().width>0).click()`); await wait(200); }
async function shot(name) { const result=await client.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(run,name+'.png'),Buffer.from(result.data,'base64')); }
async function launch(autoCheck) {
  fs.mkdirSync(path.join(data,'config'),{recursive:true});
  fs.writeFileSync(path.join(data,'config/update-settings.json'),JSON.stringify({autoCheck}));
  const env={...process.env,VOXCPM_APP_ROOT:path.join(run,'app'),VOXCPM_DATA_ROOT:data,VOXCPM_PYTHON_EXE:python};delete env.ELECTRON_RUN_AS_NODE;
  const log=fs.openSync(path.join(run,'electron.log'),'a');
  child=spawn(path.join(run,'VoxCPM Studio.exe'),['--voxcpm-run','--remote-debugging-port=19487'],{env,cwd:run,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
  client=await connect(19487);
  await until(()=>client.evaluate('!!document.querySelector(".studio-shell")'));
  return until(async()=>{const b=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');if(b.status==='error') throw Error(b.detail);return b.status==='ready'&&b;},30000);
}
async function stop() {
  if(client){await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(()=>{});client.close();client=null;}
  if(child?.pid && child.exitCode===null) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  child=null;
  // 重启后的进程来自原生更新器，只按本次隔离目录精确清理。
  const code="$target=$env:VOXCPM_PROMPT_TEST_ROOT; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target+'\\',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  spawnSync('powershell.exe',['-NoProfile','-Command',code],{env:{...process.env,VOXCPM_PROMPT_TEST_ROOT:run},windowsHide:true,stdio:'ignore'});
}
(async()=>{
  for(const directory of [shell,stage,path.join(run,'app'),path.join(data,'config')])fs.mkdirSync(directory,{recursive:true});
  const electron=path.join(frontend,'node_modules/electron/dist');
  for(const entry of fs.readdirSync(electron,{withFileTypes:true})) {
    if(entry.isFile() && entry.name!=='electron.exe')fs.copyFileSync(path.join(electron,entry.name),path.join(run,entry.name));
    else if(['locales','resources'].includes(entry.name))fs.cpSync(path.join(electron,entry.name),path.join(run,entry.name),{recursive:true});
  }
  fs.copyFileSync(path.join(electron,'electron.exe'),path.join(run,'VoxCPM Studio.exe'));
  fs.writeFileSync(path.join(run,'runtime_manifest.json'),'{"protocol":1}');
  const files=['main.js','preload.js','package.json','runtime-service.js','runtime-config.json','runtime-requirements.txt','component-service.js','music-config.json','update-service.js','update-window.js','update-config.json','updater.py','standalone-updater.exe','install-protocol.js','app.ico','app-icon.png'];
  for(const file of files)fs.copyFileSync(path.join(frontend,file),path.join(shell,file));
  fs.cpSync(path.join(frontend,'dist'),path.join(shell,'dist'),{recursive:true});
  // 实际 API，测试不依赖模型或独立Python的公网下载。
  const backend=path.join(root,'backend/voxcpm'), upstream=path.resolve(root,'../src/voxcpm');
  const wrapper=["import os,sys,types", "if os.environ.get('VOXCPM_BACKEND_LOG'): sys.stdout=sys.stderr=open(os.environ['VOXCPM_BACKEND_LOG'],'a',encoding='utf8',buffering=1)",
    `p=types.ModuleType('voxcpm');p.__path__=[${JSON.stringify(backend)},${JSON.stringify(upstream)}];sys.modules['voxcpm']=p`,
    'from voxcpm.studio_api import create_api_app','import uvicorn',"uvicorn.run(create_api_app(),host='127.0.0.1',port=int(sys.argv[sys.argv.index('--port')+1]),log_level='warning')"].join('\n');
  fs.writeFileSync(path.join(run,'app/desktop_api.py'),wrapper);
  server=http.createServer((req,res)=>{
    requests.push({at:Date.now(),url:req.url});
    if(req.url==='/latest'){res.writeHead(failManifest?503:200);res.end(failManifest?'{}':JSON.stringify(latest));}
    else {res.writeHead(failPackage?503:200);res.end(failPackage?'error':packageBytes);}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const config={...read(path.join(shell,'update-config.json')),publicKey,manifestUrl:base+'/latest',releaseId:oldRelease};
  fs.writeFileSync(path.join(shell,'update-config.json'),JSON.stringify(config));
  fs.cpSync(path.join(run,'resources'),path.join(stage,'resources'),{recursive:true});
  fs.mkdirSync(path.join(stage,'app'),{recursive:true});fs.copyFileSync(path.join(run,'app/desktop_api.py'),path.join(stage,'app/desktop_api.py'));
  fs.writeFileSync(path.join(stage,'resources/app/update-config.json'),JSON.stringify({...config,releaseId:newRelease}));
  const records=[];function inventory(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())inventory(file);else {const bytes=fs.readFileSync(file);records.push({path:path.relative(stage,file).replaceAll('\\','/'),size:bytes.length,sha256:digest(bytes)});}}}inventory(stage);
  // 排除Electron默认应用归档，不属于更新白名单。
  const selected=records.filter(r=>r.path.startsWith('resources/app/')||r.path==='app/desktop_api.py');
  fs.writeFileSync(path.join(run,'inventory.json'),JSON.stringify(selected));
  execFileSync(python,['-c',"import sys,json,zipfile,pathlib; stage=pathlib.Path(sys.argv[1]); records=json.load(open(sys.argv[2])); z=zipfile.ZipFile(sys.argv[3],'w',zipfile.ZIP_DEFLATED); [z.write(stage/r['path'],r['path']) for r in records]; z.close()",stage,path.join(run,'inventory.json'),path.join(run,'package.zip')],{windowsHide:true});
  packageBytes=fs.readFileSync(path.join(run,'package.zip'));
  const manifest={protocol:1,product:'voxcpm-studio',platform:'win32-x64',version:'2.0.2',releaseId:newRelease,minVersion:'2.0.2',notes:'启动发现新版时，直接打开独立更新器。\n新增现在更新与下次启动更新，保留模型、配置与作品。',package:{url:base+'/package',size:packageBytes.length,sha256:digest(packageBytes)},files:selected};
  const payload=JSON.stringify(manifest);latest={payload,signature:crypto.sign(null,Buffer.from(payload),keys.privateKey).toString('hex')};
  const sentinel=path.join(data,'user-work.txt');fs.writeFileSync(sentinel,'作品保留哨兵');const sentinelHash=digest(fs.readFileSync(sentinel));
  await launch(true);let p=await prompt();
  assert.equal(requests.filter(r=>r.url==='/package').length,0);assert.equal(folders('session-').length,0);
  assert.equal(await client.evaluate('!!document.querySelector(".update-available-dialog")'),false);
  const parent=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(p.hostPid)}').ParentProcessId`],{encoding:'utf8',windowsHide:true});assert.equal(Number(parent.trim()),child.pid);
  nativeShot(p.hostPid,'native-startup-choice-dark');nativeButton(p.hostPid,'切换更新器主题');nativeShot(p.hostPid,'native-startup-choice-light');
  nativeButton(p.hostPid,'下次启动更新');await until(()=>client.evaluate('window.voxcpmDesktop.getUpdateState().then(s=>!s.promptOpen)'));
  assert.equal(child.exitCode,null);assert.equal(requests.filter(r=>r.url==='/package').length,0);
  const count=folders('prompt-').length;await wait(1500);assert.equal(folders('prompt-').length,count);
  checks.push('真实启动自动弹原生独立选择窗口；选择前零包下载、无事务；延期保留工作台且本次不再自动打扰');
  await click('设置');await client.evaluate("Array.from(document.querySelectorAll('.settings-navigation button')).find(b=>b.textContent.includes('软件更新')).click()");await until(()=>client.evaluate('!!document.querySelector(".update-auto-check input[role=switch]")'));
  for(const theme of ['dark','light']){
    if(await client.evaluate('document.body.dataset.theme')!==theme)await client.evaluate("document.querySelector('.studio-theme-button').click()");
    await until(()=>client.evaluate(`document.body.dataset.theme===${JSON.stringify(theme)}`));
    await wait(250);await shot('settings-switch-'+theme);
  }
  const toggle=await client.evaluate("(()=>{const e=document.querySelector('.update-auto-check input');const s=getComputedStyle(e);return {width:e.offsetWidth,height:e.offsetHeight,appearance:s.appearance,checked:e.checked};})()");assert.deepEqual(toggle,{width:40,height:24,appearance:'none',checked:true});
  await client.evaluate("document.querySelector('.update-auto-check input').focus()");await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await until(()=>read(path.join(data,'config/update-settings.json')).autoCheck===false);checks.push('设置开关深浅主题、40×24圆角与键盘切换持久化通过');
  await stop();const before=requests.length;await launch(false);await wait(1800);assert.equal(requests.length,before);checks.push('关闭自动检查后重启不请求、不弹窗');
  await client.evaluate('window.voxcpmDesktop.checkUpdate()');p=await prompt();nativeButton(p.hostPid,'下次启动更新');await until(()=>client.evaluate('window.voxcpmDesktop.getUpdateState().then(s=>!s.promptOpen)'));checks.push('自动检查关闭时手动检查仍可打开原生窗口');
  await stop();failManifest=true;await launch(true);await until(()=>client.evaluate('window.voxcpmDesktop.getUpdateState().then(s=>s.status==="error")'));assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status,'ready');assert.equal((await client.evaluate('window.voxcpmDesktop.getUpdateState()')).promptOpen,undefined);checks.push('版本检查网络失败静默，工作台可用');
  await stop();failManifest=false;await launch(true);p=await prompt();assert.ok(folders('prompt-').length>count);checks.push('选择下次启动后，下次启动实际再次提醒');
  failPackage=true;nativeButton(p.hostPid,'现在更新');await until(()=>client.evaluate('window.voxcpmDesktop.getUpdateState().then(s=>s.status==="error")'));await wait(400);nativeShot(p.hostPid,'native-download-error');assert.equal(child.exitCode,null);assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).backendRunning,true);checks.push('下载失败保留主程序和服务，原生窗口可直接重试');
  failPackage=false;nativeButton(p.hostPid,'重试更新');
  const session=await until(()=>folders('session-').find(folder=>fs.existsSync(path.join(folder,'host-ready.json'))&&fs.existsSync(path.join(folder,'ready.json'))),45000);
  const host=read(path.join(session,'host-ready.json'));assert.notEqual(host.hostPid,p.hostPid);assert.equal(host.independent,true);
  if(client){client.close();client=null;}
  await until(()=>child.exitCode!==null,20000);
  const result=await until(()=>{const file=path.join(session,'status.json');if(!fs.existsSync(file))return false;const s=read(file);if(['error','rolled-back'].includes(s.status))throw Error(s.message);return s.status==='complete'&&s;},90000);
  assert.equal(result.releaseId,newRelease);assert.equal(digest(fs.readFileSync(sentinel)),sentinelHash);
  assert.equal(read(path.join(shell,'update-config.json')).releaseId,newRelease);
  const {UpdateService}=require('../frontend/voxcpm_studio_electron/update-service');
  const recheck=new UpdateService({root:run,dataRoot:data,appDir:shell,currentVersion:'2.0.2',config:read(path.join(shell,'update-config.json'))});assert.equal((await recheck.check()).status,'current');
  checks.push('原生重试一次自动完成真实下载、签名/哈希、独立安装、主程序退出、新版重启与API健康，再次检查current，用户作品保留');
  fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({ok:true,checks,requests,run,result,localSignedFixture:true,externalPublication:false},null,2));
  console.log(JSON.stringify({run,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await stop();if(server)server.close();});
