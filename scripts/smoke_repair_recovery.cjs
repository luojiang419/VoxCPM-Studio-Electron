/* 实际修复旧版中断事务，再升级并确认服务与数据。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { UpdateService, digest } = require('../frontend/voxcpm_studio_electron/update-service');
const root = path.resolve(__dirname, '..');
if (!process.argv[2] || !process.argv[3]) { console.error('用法：node scripts/smoke_repair_recovery.cjs <旧版目录> <解压后的修复包目录>'); process.exit(2); }
const baseline = path.resolve(process.argv[2]), repair = path.resolve(process.argv[3]);
const run = path.join(root, 'builds/repair-recovery-validation', String(Date.now()));
const json = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
(async () => {
  fs.mkdirSync(run, { recursive: true });
  for (const entry of fs.readdirSync(baseline, { withFileTypes: true })) if (entry.isFile() || ['locales','resources','app'].includes(entry.name)) fs.cpSync(path.join(baseline, entry.name), path.join(run, entry.name), { recursive: true });
  for (const name of ['runtime','models','ffmpeg']) if (fs.existsSync(path.join(baseline, name))) fs.symlinkSync(path.join(baseline, name), path.join(run, name), 'junction');
  json(path.join(run, 'data/component-selection.json'), { selected: [], removed: ['heartmula'], defaultModel: 'ace-xl-turbo' });
  const sentinel = path.join(run, 'data/config/用户原配置.txt'); fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, '原有配置与作品不可丢失');
  const dataHash = await digest(sentinel);
  const session = path.join(run, 'data/cache/updates/session-interrupted'), main = 'resources/app/main.js';
  const backup = path.join(session, 'backup', main); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(path.join(run, main), backup);
  json(path.join(session, 'session.json'), { root: run, session, currentVersion: '2.0.2' });
  json(path.join(session, 'journal.json'), { status: 'installing', changes: [{ path: main, existed: true }] });
  json(path.join(run, 'data/cache/updates/pending.json'), { session, pid: 0 });
  fs.writeFileSync(path.join(run, main), "throw new Error('中断更新留下的损坏入口');");
  const logfile = path.join(run, 'repair-console.log'), log = fs.openSync(logfile, 'a');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repair, 'repair_update.ps1'), '-InstallRoot', run], { cwd: root, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log);
  console.log('中断事务实际恢复测试：' + run);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('修复失败，日志：' + logfile))); });
  assert.ok(fs.readFileSync(logfile, 'utf8').includes('已使用原事务备份恢复'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(session, 'journal.json'))).status, 'rolled-back');
  assert.equal(fs.existsSync(path.join(run, 'data/cache/updates/pending.json')), false);
  assert.equal(await digest(sentinel), dataHash);
  const appDir = path.join(run, 'resources/app'), config = JSON.parse(fs.readFileSync(path.join(appDir, 'update-config.json')));
  const expected = JSON.parse(JSON.parse(fs.readFileSync(path.join(repair, 'envelope.json'))).payload);
  assert.equal(config.releaseId, expected.releaseId);
  const service = new UpdateService({ root: run, dataRoot: path.join(run, 'data'), appDir, currentVersion: expected.version });
  assert.equal(service.getState().lastResult.status, 'complete');
  const backend = JSON.parse(fs.readFileSync(path.join(run, 'data/cache/electron_backend_state.json')));
  assert.equal((await (await fetch(backend.serviceUrl + '/api/health')).json()).status || 'ok', 'ok');
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify({ passed: true, run, recoveredInterruptedUpdate: true, releaseId: config.releaseId, userDataPreserved: true, health: backend.serviceUrl, receipt: service.getState().lastResult }, null, 2));
  console.log('中断恢复、修复安装、重启健康、用户数据验证通过');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(output || '[]');
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) if (item.ExecutablePath?.toLowerCase() === path.join(run, 'VoxCPM Studio.exe').toLowerCase()) spawnSync('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
