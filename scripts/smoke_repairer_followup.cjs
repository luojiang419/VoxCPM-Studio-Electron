/* 修复后的同一安装目录，移走专用环境后只用软件内置更新完成下一次升级。 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const repository = path.resolve(__dirname, '..');
if (!process.argv[2] || !process.argv[3]) { console.error('用法：node scripts/smoke_repairer_followup.cjs <修复完成的测试安装目录> <下一签名快照>'); process.exit(2); }
const root = path.resolve(process.argv[2]), snapshot = path.resolve(process.argv[3]);
const allowed = path.join(repository, 'builds/legacy-repairer-validation') + path.sep;
assert.ok(fs.realpathSync(root).startsWith(allowed), '仅允许操作本任务隔离修复验收目录');
const app = path.join(root, 'resources/app'), data = path.join(root, 'data'), run = path.dirname(root);
const old = JSON.parse(fs.readFileSync(path.join(app, 'update-config.json')));
const target = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json')));
assert.ok(target.releaseId > old.releaseId && target.version === JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).version);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let server, child, client;
function stop() {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(output || '[]');
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) if (item.ExecutablePath?.toLowerCase() === path.join(root, 'VoxCPM Studio.exe').toLowerCase()) spawnSync('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
(async () => {
  stop();
  const profile = JSON.parse(fs.readFileSync(path.join(app, 'updater-runtime-config.json')));
  const runtime = path.join(data, 'tools/updater-runtime', profile.id);
  assert.ok(fs.realpathSync(runtime).startsWith(path.join(root, 'data/tools/updater-runtime') + path.sep));
  fs.renameSync(runtime, path.join(run, 'runtime-moved-before-normal-update'));
  const files = [path.join(data, 'outputs/原用户作品-保留验证.txt'), path.join(data, 'component-selection.json'), path.join(root, fs.existsSync(path.join(root, 'models/config.json')) ? 'models/config.json' : 'models/openbmb__VoxCPM2/config.json')];
  const before = files.map(hash);
  let envelope;
  server = http.createServer((req, res) => {
    if (req.url === '/latest') res.end(envelope);
    else if (req.url === '/package') fs.createReadStream(path.join(snapshot, target.package.name)).pipe(res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const local = { ...target, package: { ...target.package, url: base + '/package' } };
  envelope = execFileSync('python', ['-c', "import sys,json; from pathlib import Path; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; p=sys.stdin.buffer.read().decode('utf-8'); k=Ed25519PrivateKey.from_private_bytes(Path(sys.argv[1]).read_bytes()); print(json.dumps({'payload':p,'signature':k.sign(p.encode()).hex()}))", path.join(repository, '.update-private/signing-key')], { input: JSON.stringify(local) });
  fs.writeFileSync(path.join(app, 'update-config.json'), JSON.stringify({ ...old, manifestUrl: base + '/latest' }));
  const main = path.join(app, 'main.js');
  fs.writeFileSync(path.join(run, 'main-before-followup.js'), fs.readFileSync(main));
  fs.writeFileSync(main, "var __repairTestDialog=require('electron').dialog,__repairTestAsk=__repairTestDialog.showMessageBox.bind(__repairTestDialog);__repairTestDialog.showMessageBox=(...args)=>args.at(-1)?.title==='启动独立更新器'?Promise.resolve({response:1}):__repairTestAsk(...args);\n" + fs.readFileSync(main, 'utf8'));
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE','VOXCPM_APP_ROOT','VOXCPM_DATA_ROOT','VOXCPM_PYTHON_EXE','VOXCPM_MODEL_DIR','VOXCPM_UPDATE_SESSION','VOXCPM_UPDATE_HEALTH_FILE']) delete env[name];
  child = spawn(path.join(root, 'VoxCPM Studio.exe'), ['--voxcpm-run','--remote-debugging-port=19262'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  client = await connect(19262);
  await until(async () => (await client.evaluate('window.voxcpmDesktop.getBootstrapState()')).status === 'ready', 180000);
  const checked = await client.evaluate('window.voxcpmDesktop.checkUpdate()');
  assert.equal(checked.status, 'available'); assert.equal(checked.currentReleaseId, old.releaseId); assert.equal(checked.latestReleaseId, target.releaseId);
  const downloaded = await client.evaluate('window.voxcpmDesktop.downloadUpdate()');
  assert.equal(downloaded.status, 'downloaded', downloaded.message);
  assert.equal(downloaded.updaterRuntime, 'dedicated');
  assert.ok(fs.existsSync(path.join(runtime, 'python.exe')), '正常更新必须自动恢复缺失的专用环境');
  const cache = path.join(data, 'cache/updates');
  const sessionName = fs.readdirSync(cache).find(name => {
    try { return name.startsWith('session-') && JSON.parse(fs.readFileSync(path.join(cache, name, 'session.json'))).parentPid === child.pid; } catch { return false; }
  });
  assert.ok(sessionName);
  const session = path.join(cache, sessionName), settings = JSON.parse(fs.readFileSync(path.join(session, 'session.json')));
  assert.equal(settings.pythonExecutable, path.join(runtime, 'python.exe'));
  await client.send('Runtime.evaluate', { expression: 'void window.voxcpmDesktop.installUpdate()', awaitPromise: false });
  client.close(); client = null;
  await until(() => {
    const file = path.join(session, 'status.json'); if (!fs.existsSync(file)) return false;
    const status = JSON.parse(fs.readFileSync(file)); if (['error','rolled-back'].includes(status.status)) throw new Error(status.message); return status.status === 'complete';
  }, 240000);
  const installed = JSON.parse(fs.readFileSync(path.join(app, 'update-config.json')));
  assert.equal(installed.releaseId, target.releaseId);
  const { UpdateService } = require(path.join(app, 'update-service.js'));
  const service = new UpdateService({ root, dataRoot: data, appDir: app, currentVersion: target.version, pythonExecutable: '__audio_runtime_must_not_be_used__', config: { ...installed, manifestUrl: base + '/latest' } });
  await service.ensureUpdaterPython(); assert.equal(service.state.updaterRuntime, 'dedicated');
  assert.equal((await service.check()).status, 'current');
  assert.deepEqual(files.map(hash), before);
  const report = { passed: true, root, previousReleaseId: old.releaseId, installedReleaseId: installed.releaseId,
    repairerUsedForFollowup: false, dedicatedRuntimeAutomaticallyRestored: true, audioRuntimeNotNeededForUpdate: true,
    userDataPreserved: true, modelPreserved: true, componentSelectionPreserved: true, recheck: service.state.status, session };
  fs.writeFileSync(path.join(run, 'followup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { client?.close(); stop(); server?.close(); });
