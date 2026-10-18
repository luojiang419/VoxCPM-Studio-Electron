/* 本机真实签名包：新版下载握手 + 异机离线修复 + 重启后再次检查和界面。 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { UpdateService, digest } = require('../frontend/voxcpm_studio_electron/update-service');
const { connect, until } = require('./lib/electron_cdp.cjs');
if (!process.argv[2]) { console.error('用法：node scripts/smoke_update_reliability.cjs <签名快照目录> [已准备运行环境的旧版目录]'); process.exit(2); }
const root = path.resolve(__dirname, '..'), snapshot = path.resolve(process.argv[2]);
const original = path.resolve(process.argv[3] || path.join(root, 'builds/update-smoke-1792329141603'));
const run = path.join(root, 'builds/update-reliability-validation', String(Date.now()));
const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json')));
const repair = path.join(root, 'builds/正式分发', 'VoxCPM-更新修复-' + manifest.releaseId);
let server, client, uiChild;
function stop(target) {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(output || '[]');
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) if (item.ExecutablePath?.toLowerCase() === path.join(target, 'VoxCPM Studio.exe').toLowerCase()) spawnSync('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
async function command(executable, args, log) {
  const output = fs.openSync(log, 'a');
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', output, output] }); fs.closeSync(output);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${executable} 退出 ${code}，日志 ${log}`))); });
}
(async () => {
  fs.mkdirSync(run, { recursive: true });
  let envelope;
  server = http.createServer((req, res) => {
    if (req.url === '/latest') { res.setHeader('Content-Type', 'application/json'); res.end(envelope); }
    else if (req.url === '/package') fs.createReadStream(path.join(snapshot, manifest.package.name)).pipe(res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const local = { ...manifest, package: { ...manifest.package, url: base + '/package' } };
  envelope = execFileSync('python', ['-c', "import sys,json; from pathlib import Path; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; p=sys.stdin.buffer.read().decode('utf-8'); k=Ed25519PrivateKey.from_private_bytes(Path(sys.argv[1]).read_bytes()); print(json.dumps({'payload':p,'signature':k.sign(p.encode()).hex()}))", path.join(root, '.update-private/signing-key')], { input: JSON.stringify(local) });
  console.log('正在运行真实下载、签名新版更新器和重启握手…');
  const onlineLog = path.join(run, 'online.log');
  await command(process.execPath, ['scripts/smoke_update.cjs', original, '--same-version', '--empty-components', '--fixed-client', '--manifest-url', base + '/latest'], onlineLog);
  const onlinePath = fs.readFileSync(onlineLog, 'utf8').match(/测试副本：([^\r\n]+)/)[1];
  const online = JSON.parse(fs.readFileSync(path.join(onlinePath, 'smoke-result.json')));
  assert.equal(online.recheckStatus, 'current');
  console.log('下载、就绪握手、重启与再次检查通过。正在测试离线修复旧客户端…');
  const offline = path.join(run, '旧版 异机修复'); fs.mkdirSync(offline);
  for (const entry of fs.readdirSync(original, { withFileTypes: true })) if (entry.isFile() || ['locales','resources','app'].includes(entry.name)) fs.cpSync(path.join(original, entry.name), path.join(offline, entry.name), { recursive: true });
  for (const name of ['runtime','models','ffmpeg']) if (fs.existsSync(path.join(original, name))) fs.symlinkSync(path.join(original, name), path.join(offline, name), 'junction');
  const configFile = path.join(offline, 'resources/app/update-config.json');
  const oldConfig = JSON.parse(fs.readFileSync(configFile)); oldConfig.releaseId = '20261018131046'; fs.writeFileSync(configFile, JSON.stringify(oldConfig));
  const configDir = path.join(offline, 'data/config'); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '用户配置.txt'), '音色、作品、配置需要保留');
  fs.writeFileSync(path.join(offline, 'data/component-selection.json'), JSON.stringify({ selected: [], removed: ['heartmula'], defaultModel: 'ace-xl-turbo' }));
  const sentinel = path.join(configDir, '用户配置.txt'), hash = await digest(sentinel);
  await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repair, 'repair_update.ps1'), '-InstallRoot', offline], path.join(run, 'offline.log'));
  assert.equal(await digest(sentinel), hash);
  const installed = JSON.parse(fs.readFileSync(configFile)); assert.equal(installed.releaseId, manifest.releaseId);
  const receipt = JSON.parse(fs.readFileSync(path.join(offline, 'data/cache/updates/last-result.json'))); assert.equal(receipt.status, 'complete');
  const check = new UpdateService({ root: offline, dataRoot: path.join(offline, 'data'), appDir: path.dirname(configFile), currentVersion: manifest.version, config: { ...installed, manifestUrl: base + '/latest' } });
  assert.equal((await check.check()).status, 'current');
  // 当前仍在运行时必须拒绝修复，不结束用户任务。
  const blocked = spawnSync(path.join(offline, 'runtime/python/python.exe'), [path.join(repair, 'repair_update.py'), offline], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(blocked.status, 0); assert.ok(blocked.stderr.includes('请先关闭'));
  stop(offline);
  const repeated = spawnSync(path.join(offline, 'runtime/python/python.exe'), [path.join(repair, 'repair_update.py'), offline], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(repeated.status, 0); assert.ok(repeated.stderr.includes('相同或更旧'));
  assert.equal(JSON.parse(fs.readFileSync(configFile)).releaseId, manifest.releaseId);
  // 重开已升级副本，检查真实设置面板和更新回执。
  fs.writeFileSync(configFile, JSON.stringify({ ...installed, manifestUrl: base + '/latest' }));
  uiChild = spawn(path.join(offline, 'VoxCPM Studio.exe'), ['--voxcpm-run', '--remote-debugging-port=19257'], { cwd: offline, windowsHide: true, stdio: 'ignore' });
  client = await connect(19257);
  await until(async () => (await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status === 'ready', 180000);
  await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='设置').click()");
  await until(() => client.evaluate("document.querySelector('#software-update-panel')?.innerText.includes('更新安装成功')"));
  const recheck = await client.evaluate('window.voxcpmDesktop.checkUpdate()'); assert.equal(recheck.status, 'current');
  const text = await client.evaluate("document.querySelector('#software-update-panel').innerText");
  assert.ok(text.includes(manifest.releaseId)); assert.ok(text.includes('查看更新日志'));
  await client.evaluate("document.querySelector('#software-update-panel').scrollIntoView({block:'center'})");
  fs.writeFileSync(path.join(run, 'settings-updated-dark.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await client.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='浅色模式').click()");
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.writeFileSync(path.join(run, 'settings-updated-light.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const report = { passed: true, releaseId: manifest.releaseId, online, offline: { root: offline, receipt, userDataPreserved: true, recheck: recheck.status, runningRefused: true, repeatedRefused: true }, settingsText: text };
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log('全部通过：' + path.join(run, 'report.json'));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close(); if (uiChild?.pid) spawnSync('taskkill.exe', ['/PID', String(uiChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  stop(path.join(run, '旧版 异机修复')); server?.close();
});
