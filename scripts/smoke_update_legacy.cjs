/* 不替换客户端实现，验证历史迁移或新版启动自动更新到本地签名快照。 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
if (!process.argv[2] || !process.argv[3]) { console.error('用法：node scripts/smoke_update_legacy.cjs <签名快照目录> <已准备环境的旧版目录>'); process.exit(2); }
const root = path.resolve(__dirname, '..'), snapshot = path.resolve(process.argv[2]), baseline = path.resolve(process.argv[3]);
const run = path.join(root, 'builds/legacy-update-validation', String(Date.now()));
const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json')));
const promptFlow = process.argv.includes('--prompt-flow');
let server;
(async () => {
  fs.mkdirSync(run, { recursive: true });
  let envelope;
  server = http.createServer((req, res) => {
    if (req.url === '/latest') res.end(envelope);
    else if (req.url === '/package') fs.createReadStream(path.join(snapshot, manifest.package.name)).pipe(res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const local = { ...manifest, package: { ...manifest.package, url: base + '/package' } };
  envelope = execFileSync('python', ['-c', "import sys,json; from pathlib import Path; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; p=sys.stdin.buffer.read().decode('utf-8'); k=Ed25519PrivateKey.from_private_bytes(Path(sys.argv[1]).read_bytes()); print(json.dumps({'payload':p,'signature':k.sign(p.encode()).hex()}))", path.join(root, '.update-private/signing-key')], { input: JSON.stringify(local) });
  const logfile = path.join(run, 'upgrade.log'), log = fs.openSync(logfile, 'a');
  const child = spawn(process.execPath, ['scripts/smoke_update.cjs', baseline, '--same-version', '--empty-components',
    ...(promptFlow ? ['--prompt-flow','--main-install'] : ['--legacy-client']),
    ...(process.argv.includes('--lightweight') ? ['--lightweight'] : []),
    ...(process.argv.includes('--preserve-installed-identity') ? ['--preserve-installed-identity'] : []),
    ...(process.argv.includes('--assert-native') ? ['--assert-native'] : []),
    ...process.argv.filter(arg => arg.startsWith('--close-behavior=')), '--manifest-url', base + '/latest'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  console.log((promptFlow ? '正在验证新版启动自动更新：' : '正在验证未修补旧版：') + baseline);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`升级失败，退出 ${code}：${logfile}`))); });
  const testRoot = fs.readFileSync(logfile, 'utf8').match(/测试副本：([^\r\n]+)/)[1];
  const report = JSON.parse(fs.readFileSync(path.join(testRoot, 'smoke-result.json')));
  assert.equal(report.legacyClient, !promptFlow); assert.equal(report.startupPromptFlow, promptFlow); assert.equal(report.recheckStatus, 'current');
  const copiesOldScript = !fs.readFileSync(path.join(baseline, 'resources/app/update-service.js'), 'utf8').includes('prepareUpdater');
  if (copiesOldScript) assert.deepEqual(fs.readFileSync(path.join(report.session, 'updater.py')), fs.readFileSync(path.join(baseline, 'resources/app/updater.py')), '必须真实执行旧版更新脚本');
  else {
    const expected = manifest.files.find(f => f.path === 'resources/app/updater.py');
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(report.session, 'updater.py'))).digest('hex'), expected.sha256);
  }
  const baselineReleaseId = JSON.parse(fs.readFileSync(path.join(baseline, 'resources/app/update-config.json'))).releaseId;
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify({ ...report, baseline, baselineReleaseId, legacyUpdaterPreserved: copiesOldScript, signedHelperMigration: !copiesOldScript, packageUnchanged: true }, null, 2));
  console.log((promptFlow ? '新版自动更新通过：' : '旧版直接升级通过：') + path.join(run, 'report.json'));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server?.close());
