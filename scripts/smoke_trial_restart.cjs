/* 验证永久授权重启后仍为正式版，原生窗口标题及个人配置/作品保持。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const out = path.join(ROOT, 'builds/trial-auth-validation');
const account = JSON.parse(fs.readFileSync(path.join(ROOT, '.auth-private/smoke-account.json')));
const origin = 'https://admin.ee2x.cn';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 120000; while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(250); } throw Error('等待正式版重启超时'); }
let adminToken, child, socket, evaluate;
async function api(route, body) {
  const r = await fetch(origin + '/api/v1' + route, {method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json', ...(adminToken ? {Authorization:'Bearer ' + adminToken} : {})}, ...(body ? {body:JSON.stringify(body)} : {})});
  const json = await r.json(); if (!r.ok) throw Error('HTTP ' + r.status); return json;
}
async function entitlement() {
  const state = await api('/admin/state');
  assert.ok(account.username.startsWith('qa_'));
  assert.ok(state.users.some(u => u.id === account.userId && u.username === account.username && u.name === '授权验收账户'));
  return state.licenses.find(l => l.user_id === account.userId && l.app_id === 'jvox-studio');
}
async function stop() {
  if (socket) {
    try { await evaluate('window.voxcpmDesktop.stopBackend()'); } catch {}
    socket.close(); socket = null;
  }
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited;
  }
  child = null;
}
async function connect() {
  const page = await until(async () => {
    try { return (await (await fetch('http://127.0.0.1:19342/json/list')).json()).find(p => p.type === 'page'); } catch { return null; }
  });
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,j) => {socket.addEventListener('open', r, {once:true}); socket.addEventListener('error', j, {once:true});});
  let seq=0; const pending=new Map();
  socket.addEventListener('message', ({data}) => {const v=JSON.parse(data); if(pending.has(v.id)) {const {r,j}=pending.get(v.id); pending.delete(v.id); v.error ? j(Error(v.error.message)) : r(v.result);}});
  const send=(method,params) => new Promise((r,j)=>{const id=++seq;pending.set(id,{r,j});socket.send(JSON.stringify({id,method,params}));});
  evaluate=async expression=>{const v=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true}); if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value;};
  return send;
}
const report = {passed:false,checks:[]};
(async()=>{
  assert.ok(process.env.EE2X_ADMIN_PASSWORD && process.env.VOXCPM_TRIAL_PACKAGE);
  adminToken=(await api('/admin/auth/login',{username:'luo',password:process.env.EE2X_ADMIN_PASSWORD})).token;
  let row=await entitlement();
  await api('/admin/entitlements/'+row.id+'/restore',{revision:row.revision,request_id:crypto.randomUUID(),reason:'自动化验收：仅恢复本次QA永久授权以验证重启'});
  for(let round=0;round<2;round++) {
    const env={...process.env,VOXCPM_DATA_ROOT:path.join(out,'data'),VOXCPM_APP_ROOT:path.join(process.env.VOXCPM_TRIAL_PACKAGE,'app')};
    delete env.ELECTRON_RUN_AS_NODE; delete env.EE2X_ADMIN_PASSWORD;
    child=spawn(path.join(process.env.VOXCPM_TRIAL_PACKAGE,'JVOX Studio配音系统.exe'),['--remote-debugging-port=19342'],{cwd:process.env.VOXCPM_TRIAL_PACKAGE,env,stdio:'ignore',windowsHide:false});
    const send=await connect();
    await until(()=>evaluate('Boolean(window.voxcpmDesktop && document.querySelector(".jvox-account-entry"))'));
    if(round===0) {
      const result=await evaluate(`window.voxcpmDesktop.authenticate('login',${JSON.stringify(account)})`);
      assert.equal(result.state.status,'permanent');
    }
    await until(()=>evaluate('document.title === "JVOX Studio正式版"'));
    assert.equal((await evaluate('window.voxcpmDesktop.getLicenseState()')).status,'permanent');
    assert.equal(await evaluate('localStorage.getItem("qa.edition.preserve")'),'保留我的设置');
    assert.equal(fs.readFileSync(path.join(out,'data/outputs/正式版转换验收.txt'),'utf8'),'保留我的作品');
    await until(async()=>{
      const title=execFileSync('powershell.exe',['-NoProfile','-Command',`[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process -Id ${child.pid}).MainWindowTitle`],{encoding:'utf8',windowsHide:true}).trim();
      return title==='JVOX Studio正式版';
    });
    if(round===1) {
      await evaluate('document.querySelector(".jvox-account-entry").click()');
      const image=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(out,'desktop-permanent-restarted.png'),Buffer.from(image.data,'base64'));
    }
    report.checks.push(round===0 ? '永久账号重新登录为正式版，原生窗口标题同步' : '彻底退出并重启后自动保持正式版，配置和作品保留');
    await stop(); await delay(500);
  }
  report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(async()=>{
  await stop();
  if(adminToken) {const row=await entitlement();await api('/admin/entitlements/'+row.id+'/suspend',{revision:row.revision,request_id:crypto.randomUUID(),reason:'自动化验收结束：停用QA授权'});}
  fs.writeFileSync(path.join(out,'restart-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
});
