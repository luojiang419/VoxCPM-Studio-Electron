/* 隔离目录实际启动：音频 Python 不可用时用专用环境恢复中断事务并重新启动。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const repository = path.resolve(__dirname, '..'), root = path.resolve(process.argv[2] || '');
assert.ok(fs.realpathSync(root).startsWith(path.join(repository, 'builds/legacy-repairer-validation') + path.sep));
const app = path.join(root, 'resources/app'), run = path.dirname(root), main = path.join(app, 'main.js');
const originalMain = fs.readFileSync(main), session = path.join(root, 'data/cache/updates/session-runtime-recovery-' + Date.now());
const trace = path.join(run, 'runtime-recovery-trace.json'), relative = 'resources/app/recovery-test-marker.txt';
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
let client;
function stop() {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(output || '[]');
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) if (item.ExecutablePath?.toLowerCase() === path.join(root, 'VoxCPM Studio.exe').toLowerCase()) spawnSync('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
(async () => {
  stop();
  const source = fs.readFileSync(path.join(repository, 'frontend/voxcpm_studio_electron/main.js'), 'utf8');
  const injected = `var __recoveryCP=require('node:child_process'),__recoverySpawn=__recoveryCP.spawnSync;__recoveryCP.spawnSync=function(exe,args,options){const result=__recoverySpawn.apply(this,arguments);if(args?.includes('--recover')){require('node:fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify({exe,args,status:result.status,firstPid:process.pid}));delete process.env.VOXCPM_PYTHON_EXE;}return result;};\n`;
  fs.writeFileSync(main, injected + source);
  fs.mkdirSync(path.join(session, 'backup/resources/app'), { recursive: true });
  fs.writeFileSync(path.join(session, 'backup', relative), 'old'); fs.writeFileSync(path.join(root, relative), 'new');
  json(path.join(session, 'session.json'), { root, session, currentVersion: '2.0.2' });
  json(path.join(session, 'journal.json'), { status: 'installing', changes: [{ path: relative, existed: true }] });
  json(path.join(root, 'data/cache/updates/pending.json'), { session, pid: 2147483647 });
  const env = { ...process.env, VOXCPM_PYTHON_EXE: '__missing_audio_python_for_recovery__' };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VOXCPM_APP_ROOT', 'VOXCPM_DATA_ROOT', 'VOXCPM_MODEL_DIR', 'VOXCPM_UPDATE_SESSION', 'VOXCPM_UPDATE_HEALTH_FILE']) delete env[name];
  spawn(path.join(root, 'VoxCPM Studio.exe'), ['--voxcpm-run', '--remote-debugging-port=19263'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  await until(() => fs.existsSync(trace), 60000);
  const recovered = JSON.parse(fs.readFileSync(trace));
  assert.equal(recovered.status, 0); assert.ok(recovered.exe.startsWith(path.join(root, 'data/tools/updater-runtime') + path.sep));
  assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(root, 'data/cache/updates/pending.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(session, 'journal.json'))).status, 'rolled-back');
  client = await connect(19263);
  await until(async () => (await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status === 'ready', 180000);
  const backend = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/electron_backend_state.json')));
  assert.equal((await fetch(backend.serviceUrl + '/api/health')).status, 200);
  const { targets } = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `@{ targets=@(Get-CimInstance Win32_Process -Filter "Name='VoxCPM Studio.exe'" | Select-Object ProcessId,ExecutablePath) } | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
  assert.ok(!targets.some(item => item.ProcessId === recovered.firstPid), '恢复进程必须退出并重新加载应用');
  const report = { passed: true, root, dedicatedRuntimeUsed: recovered.exe, audioRuntimeNotNeededForRecovery: true, restoredFiles: true, pendingCleared: true, mainProcessRelaunched: true, backendHealthy: true, session };
  fs.writeFileSync(path.join(run, 'runtime-recovery-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { client?.close(); stop(); fs.writeFileSync(main, originalMain); fs.rmSync(path.join(root, relative), { force: true }); });
