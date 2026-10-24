// 用构建包中的真实 JS 与原生窗口验证进度写入，不下载更新或运行模型。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const appDir = path.resolve(process.argv[2]);
const { UpdateService } = require(path.join(appDir, 'update-service.js'));
const root = path.resolve(__dirname, '../builds/updater-prompt-validation', String(Date.now()));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  fs.mkdirSync(root, { recursive: true });
  const service = new UpdateService({ root, dataRoot: root, appDir, currentVersion: '2.0.4' });
  service.ensureUpdaterPython = async () => process.execPath; // 提示窗口不会执行 Python。
  service.manifest = { version: '2.0.4', releaseId: service.config.releaseId, notes: '真实原生窗口并发进度验收', package: { size: 1 } };
  service.state.status = 'available';
  let prompt;
  try {
    await service.showPrompt(); prompt = service.prompt;
    for (let step = 0; step < 250; step++) {
      service.setState({ status: 'downloading', progress: step % 100, message: `并发进度 ${step}` });
      await wait(8);
    }
    await prompt.writePending;
    service.setState({ status: 'downloaded', progress: 100, message: '进度文件验收完成' });
    await prompt.writePending;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'capture_update_window.ps1'), '-UpdaterProcessId', String(prompt.child.pid),
      '-OutputPath', path.join(root, 'prompt.png')], { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    await service.closePrompt();
    const until = Date.now() + 10000;
    while (prompt.child.exitCode === null && Date.now() < until) await wait(100);
    assert.notEqual(prompt.child.exitCode, null, '关闭状态必须结束原生窗口');
    assert.equal(JSON.parse(fs.readFileSync(path.join(prompt.folder, 'prompt-state.json'))).status, 'closed');
    assert.ok(!prompt.writeWarned, '真实原生窗口不应阻止进度替换');
    const report = { passed: true, appDir, releaseId: service.config.releaseId, updates: 250,
      nativeWindow: true, progressWritesSucceeded: true, finalState: 'closed', downloads: 0 };
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, report: path.join(root, 'report.json') }));
  } finally {
    await service.closePrompt();
    if (prompt?.child.exitCode === null) prompt.child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
