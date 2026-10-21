// 真实 Electron 主进程、preload、React 设置与 Python 后端，不替换网络或生成响应。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const {connect, until, wait} = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), project = path.join(root, 'frontend/voxcpm_studio_electron');
const output = path.join(root, 'builds/public-api-acceptance');
const port = Number(process.env.JVOX_ACCEPTANCE_PORT || 8848), debugPort = 19246;
const keep = process.argv.includes('--keep-running');
let child, c, backendBaseUrl;
const checks = [];
async function requireFreePort(port) {
  const net = require('node:net');
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`验收端口 ${port} 已占用，请先核对来源，不自动结束现有服务`)));
    probe.listen(port, '0.0.0.0', () => probe.close(resolve));
  });
}
async function launch() {
  const env = {...process.env, VOXCPM_APP_ROOT: path.join(root, 'scripts/dev_backend'), VOXCPM_DATA_ROOT: path.join(output, 'data')};
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(project, 'node_modules/electron/dist/electron.exe'), [project, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(output, 'profile')}`], {cwd: project, env, windowsHide: true, stdio: 'ignore'});
  c = await connect(debugPort);
  await until(() => c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"), 180000);
  backendBaseUrl = await c.evaluate('window.voxcpmDesktop.getBootstrapState().then(s=>s.backendBaseUrl)');
  await c.evaluate("document.querySelector('.jvox-update')?.click()");
  await c.evaluate("[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()==='设置').click()");
  await until(() => c.evaluate("[...document.querySelectorAll('.settings-navigation button')].some(e=>e.textContent.includes('开发者 API'))"));
  await c.evaluate("[...document.querySelectorAll('.settings-navigation button')].find(e=>e.textContent.includes('开发者 API')).click()");
  await until(() => c.evaluate("Boolean(document.querySelector('.api-service-fields'))")).catch(async error => {
    console.error(await c.evaluate("window.voxcpmDesktop.getBootstrapState().then(async s=>({hasToken:!!s.apiManagementToken,withToken:await fetch(s.backendBaseUrl+'/api/access',{headers:{'X-JVOX-Management':s.apiManagementToken}}).then(async r=>({status:r.status,body:await r.text()}))}))"));
    throw error;
  });
}
async function click(text, scope = 'document') {
  await c.evaluate(`(()=>{const e=[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('按钮不存在');e.click()})()`);
  await wait(100);
}
async function change(selector, value) {
  await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);
  await wait(100);
}
async function idle() { await until(() => c.evaluate("!document.querySelector('.api-service-fields button').disabled")); }
async function secret() { return c.evaluate("document.querySelector('.api-secret code')?.textContent"); }
async function checkAuth(token, status) {
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`, {headers: {Authorization: `Bearer ${token}`}})).status, status);
}
async function close() {
  if (c) { try { await c.evaluate('window.voxcpmDesktop.stopBackend()'); } catch {} c.close(); c = null; }
  if (child) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}); child = null; }
  await wait(500);
}
async function create(name) {
  await change('[aria-label="密钥名称"]', name); await click('创建密钥'); await idle();
  await until(secret);
  const token = await secret(); assert.ok(token?.startsWith('sk-jvox-')); return token;
}
async function shot(name) {
  const result = await c.send('Page.captureScreenshot', {format: 'png'});
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
(async () => {
  fs.mkdirSync(output, {recursive: true});
  await Promise.all([port, port+1, debugPort].map(requireFreePort));
  await launch();
  // 验收专用数据可重复运行，保留联调密钥，另建临时密钥测试破坏性生命周期。
  const token = await create('生命周期验收-' + Date.now());
  await click('隐藏'); assert.equal(await secret(), undefined);
  await click('查看 / 复制', "document.querySelector('.api-key-card')"); await idle(); assert.equal(await secret(), token);
  await click('复制密钥'); assert.equal(await c.evaluate('navigator.clipboard.readText()'), token);
  await click('隐藏');
  await change('.api-service-fields input[type=number]', port);
  if (!await c.evaluate("document.querySelector('.api-enable input').checked")) await c.evaluate("document.querySelector('.api-enable input').click()");
  await click('保存并应用'); await idle(); await checkAuth(token, 200);
  assert.match(await c.evaluate("document.querySelector('.api-intro span').textContent"), /服务运行中/);
  checks.push('真实 Electron 启动、创建/查看/复制/隐藏及启用监听');
  // 轮换与删除的原生确认框通过 CDP 接受，不替换 confirm 实现。
  async function confirmed(label) {
    const previousDialogs = c.events.filter(e => e.method === 'Page.javascriptDialogOpening').length;
    const action = click(label, "document.querySelector('.api-key-card')");
    await until(() => Promise.resolve(c.events.filter(e => e.method === 'Page.javascriptDialogOpening').length > previousDialogs));
    await c.send('Page.handleJavaScriptDialog', {accept: true}); await action; await idle();
  }
  await c.send('Page.enable');
  await confirmed('轮换'); const rotated = await secret(); assert.notEqual(rotated, token);
  await checkAuth(token, 401); await checkAuth(rotated, 200); await click('隐藏');
  await click('停用', "document.querySelector('.api-key-card')"); await idle(); await checkAuth(rotated, 401);
  await confirmed('删除'); assert.ok(!await c.evaluate(`document.body.textContent.includes(${JSON.stringify(token)})`));
  checks.push('轮换立即撤销旧值、停用及删除');
  let card = await c.evaluate("[...document.querySelectorAll('.api-key-card strong')].some(e=>e.textContent==='H3实际源码联调')");
  if (!card) await create('H3实际源码联调');
  if (await secret()) await click('隐藏');
  // 改监听范围/端口，再停用、恢复，均走设置页真实请求。
  await change('.api-service-fields select', '0.0.0.0'); await change('.api-service-fields input[type=number]', port + 1);
  await click('保存并应用'); await idle(); assert.equal((await fetch(`http://127.0.0.1:${port+1}/health`)).status, 200);
  await c.evaluate("document.querySelector('.api-enable input').click()"); await click('保存并应用'); await idle();
  assert.match(await c.evaluate("document.querySelector('.api-intro span').textContent"), /服务未启动/);
  await change('.api-service-fields select', '127.0.0.1'); await change('.api-service-fields input[type=number]', port);
  await c.evaluate("document.querySelector('.api-enable input').click()"); await click('保存并应用'); await idle();
  checks.push('监听范围、端口更改、停止与重新启用');
  await close(); await launch();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  assert.equal(await c.evaluate("document.querySelector('.api-service-fields input[type=number]').value"), String(port));
  assert.ok(await c.evaluate("document.body.textContent.includes('H3实际源码联调')"));
  assert.equal(await secret(), undefined); await shot('electron-api-settings');
  checks.push('完全退出及重启 Electron 后配置、密钥、监听自动恢复，明文隐藏');
  const report = {result: 'passed', checks, backendBaseUrl, publicBaseUrl: `http://127.0.0.1:${port}/v1`, electronPid: child.pid, debugPort, dataRoot: path.join(output, 'data'), javascriptErrors: c.events.filter(e => e.method === 'Runtime.exceptionThrown').length};
  assert.equal(report.javascriptErrors, 0);
  fs.writeFileSync(path.join(output, 'electron-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {console.error(error); try {if(c) await shot('failure');} catch {} process.exitCode=1;}).finally(async () => {
  if (!keep || process.exitCode) await close(); else {c?.close(); c=null; await new Promise(resolve => child.once('exit', resolve));}
});
