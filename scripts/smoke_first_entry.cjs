// 隔离实际主程序，延迟后端启动，验证用户可见的第一帧及资源错误交接。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const baseline = path.join(root, 'builds/JVOX-Desktop-Unified-20261019101811');
const run = path.join(root, 'builds/first-entry-validation', String(Date.now())), installed = path.join(run, 'Studio');
const signal = path.join(run, 'start.signal'), fault = path.join(run, 'preparation-error.signal'), frame = path.join(run, 'first-frame.json');
let child, client;
(async () => {
  fs.mkdirSync(installed, { recursive: true });
  for (const entry of fs.readdirSync(baseline)) fs.cpSync(path.join(baseline, entry), path.join(installed, entry), { recursive: true });
  fs.symlinkSync(path.join(root, 'builds/unified-validation/1792405129143560500/Studio/runtime'), path.join(installed, 'runtime'), 'junction');
  fs.symlinkSync(path.resolve(root, '../models'), path.join(installed, 'models'), 'junction');
  fs.mkdirSync(path.join(installed, 'data'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'data/component-selection.json'), JSON.stringify({ selected: [], removed: [], defaultModel: 'ace-xl-turbo' }));
  const appDir = path.join(installed, 'resources/app');
  for (const name of ['preload.js', 'window-behavior.js']) fs.copyFileSync(path.join(frontend, name), path.join(appDir, name));
  fs.cpSync(path.join(frontend, 'dist'), path.join(appDir, 'dist'), { recursive: true });
  let source = fs.readFileSync(path.join(frontend, 'main.js'), 'utf8').replaceAll('\r\n', '\n');
  const point = '  try {\n    await startBackend();'; assert.ok(source.includes(point));
  source = source.replace(point, `  try {
    await new Promise(resolve => { let sent=false; const timer=setInterval(()=>{
      if(!sent && fs.existsSync(${JSON.stringify(fault)})) { sent=true; sendRuntimeEvent("runtime-preparation", {preparation:{status:"error",phase:"python",activity:"prepare",message:"隔离验收：等待后台资源"}}); }
      if(fs.existsSync(${JSON.stringify(signal)})) {clearInterval(timer);resolve();}
    },50); });
    await startBackend();`);
  source = source.replace('mainWindow.once("ready-to-show", () => {', `mainWindow.once("ready-to-show", () => {
    if(!fs.existsSync(${JSON.stringify(frame)})) mainWindow.webContents.executeJavaScript('({welcome:!!document.querySelector(".jvox-announcement[open]"), workspaceHidden:getComputedStyle(document.querySelector(".studio-shell")).display==="none", entry:!!document.querySelector(".jvox-entry-screen")})').then(value=>fs.writeFileSync(${JSON.stringify(frame)},JSON.stringify(value)));`);
  fs.writeFileSync(path.join(appDir, 'main.js'), source);
  const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(installed, 'data') };
  for (const key of ['ELECTRON_RUN_AS_NODE','VOXCPM_APP_ROOT','VOXCPM_PYTHON_EXE','VOXCPM_UPDATE_HEALTH_FILE','VOXCPM_UPDATE_SESSION']) delete env[key];
  function launch() { return spawn(path.join(installed, 'JVOX Studio配音系统.exe'), ['--voxcpm-run','--remote-debugging-port=19443'], { cwd: installed, env, windowsHide: true, stdio: 'ignore' }); }
  async function shot(name) { const s=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(run,name+'.png'),Buffer.from(s.data,'base64')); }
  async function click(selector) { await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function close() { await client.evaluate('window.voxcpmDesktop.setWindowBehavior("quit").then(()=>setTimeout(()=>window.close(),100))');client.close();client=null;await until(()=>child.exitCode!==null); }
  child = launch(); client = await connect(19443);
  await until(()=>fs.existsSync(frame));
  const firstFrame=JSON.parse(fs.readFileSync(frame));assert.deepEqual(firstFrame,{welcome:true,workspaceHidden:true,entry:true});
  assert.equal((await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).backendRunning,false);
  fs.writeFileSync(fault,'1');await wait(350);
  assert.equal(await client.evaluate('document.querySelector(".runtime-startup-dialog").open'),false);
  assert.equal(await client.evaluate('document.activeElement.closest(".jvox-announcement")!==null'),true);
  await shot('first-visible-screen');
  await click('[aria-label="切换弹窗深浅主题"]');await wait(300);await shot('first-visible-screen-light');
  await click('.jvox-update');
  await until(()=>client.evaluate('document.querySelector(".runtime-startup-dialog").open'));
  assert.equal(await client.evaluate('!!document.querySelector(".jvox-entry-screen")'),false);
  assert.equal(await client.evaluate('document.querySelector(".runtime-message").textContent.includes("等待后台资源")'),true);
  fs.writeFileSync(signal,'1');
  await until(()=>client.evaluate('window.voxcpmDesktop.getBootstrapState().then(s=>s.status==="ready" && s.backendRunning)'),180000);
  await until(()=>client.evaluate('!document.querySelector(".runtime-startup-dialog").open'));
  await close(); child=launch();client=await connect(19443);
  await until(()=>client.evaluate('!!document.querySelector(".brand-copy") && !!document.body.dataset.theme'));
  assert.equal(await client.evaluate('!!document.querySelector(".jvox-entry-screen")'),false);
  assert.equal(await client.evaluate('localStorage.getItem("jvox-brand-welcome-2026")'),'seen');
  await close();
  fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({passed:true,firstFrame,backendHeldUntilContinue:true,preparationDoesNotCoverWelcome:true,pendingErrorVisibleAfterContinue:true,realApiReady:true,acknowledgedDoesNotRepeatAfterProcessRestart:true,isolated:true},null,2));
  console.log('PASS 实际首帧庆祝页、后台延迟/错误交接与跨进程持久化：'+run);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  client?.close();if(child && child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
});
