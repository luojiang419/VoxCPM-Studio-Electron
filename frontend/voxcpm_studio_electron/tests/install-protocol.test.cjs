const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { installationSession } = require("../install-protocol");

test("安装握手只允许当前目录、当前会话，拒绝向任意文件写报告", () => {
  const root = path.join(os.tmpdir(), "voxcpm-test"), session = crypto.randomBytes(16).toString("hex");
  assert.equal(installationSession({ root, dataRoot: root }), null);
  assert.throws(() => installationSession({ root, dataRoot: path.join(root, "data"), session: "../../x", report: path.join(root, "x") }));
  assert.throws(() => installationSession({ root, dataRoot: path.join(root, "data"), session, report: path.join(root, "private.json") }));
  assert.throws(() => installationSession({ root, dataRoot: path.join(root, "other"), session, report: path.join(root, "data/cache/install", session + ".json") }));
});

test("进度报告过滤运行日志和环境变量，只有显式 ready 才产生成功报告", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-install-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const session = crypto.randomBytes(16).toString("hex"), report = path.join(root, "data/cache/install", session + ".json");
  const protocol = installationSession({ root, dataRoot: path.join(root, "data"), session, report });
  await protocol.progress({ status: "ready", phase: "ready", message: "依赖已补齐", log: "sensitive", token: "secret", downloaded: 10, size: 10 });
  await assert.rejects(fs.stat(report), { code: "ENOENT" });
  const progress = JSON.parse(await fs.readFile(report + ".progress", "utf8"));
  assert.equal(progress.session, session); assert.equal(progress.log, undefined); assert.equal(progress.token, undefined);
  assert.throws(() => protocol.ready(), /所选组件/);
  await protocol.ready({ protocol: 2, selected: ['ace-xl-turbo'], signature: 'a'.repeat(64) });
  const ready = JSON.parse(await fs.readFile(report, "utf8"));
  assert.equal(ready.ok, true); assert.equal(ready.status, "ready"); assert.equal(ready.root, root);
});

test("服务启动失败会明确报告失败", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-install-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const session = crypto.randomBytes(16).toString("hex"), report = path.join(root, "data/cache/install", session + ".json");
  await installationSession({ root, dataRoot: path.join(root, "data"), session, report }).fail(new Error("CUDA 不兼容"));
  const failure = JSON.parse(await fs.readFile(report, "utf8"));
  assert.equal(failure.ok, false); assert.equal(failure.error, "CUDA 不兼容");
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-progress-"));
  const session = crypto.randomBytes(16).toString("hex"), report = path.join(root, "data/cache/install", session + ".json");
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return { root, report, protocol: installationSession({ root, dataRoot: path.join(root, "data"), session, report }) };
}
const components = { protocol: 2, selected: [], signature: 'b'.repeat(64) };

test("进度被短暂占用时异步重试，突发更新合并到最新值且始终只有一个写入", async t => {
  const { report, protocol } = await fixture(t);
  const rename = fs.rename.bind(fs);
  let failures = 2, active = 0, maximum = 0, writes = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    active++; maximum = Math.max(active, maximum);
    try {
      if (failures-- > 0) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      await rename(source, target); writes++;
    } finally { active--; }
  });
  const first = protocol.progress({ downloaded: 0, size: 100 });
  for (let i = 1; i <= 100; i++) protocol.progress({ downloaded: i, size: 100 });
  await first;
  assert.equal(JSON.parse(await fs.readFile(report + '.progress', 'utf8')).downloaded, 100);
  assert.equal(maximum, 1); assert.equal(writes, 2);
  assert.deepEqual((await fs.readdir(path.dirname(report))).filter(name => name.endsWith('.tmp')), []);
});

test("永久进度写入失败不会向下载回调抛错；失败报告仍能落盘", async t => {
  const { report, protocol } = await fixture(t), rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target.endsWith('.progress')) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return rename(source, target);
  });
  await assert.doesNotReject(protocol.progress({ downloaded: 1, size: 10 }));
  await assert.rejects(fs.stat(report), { code: 'ENOENT' });
  await protocol.fail(new Error('真实安装错误'));
  assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).error, '真实安装错误');
});

test("最终报告等待正在写的进度结束，完成后忽略迟到的进度", async t => {
  const { report, protocol } = await fixture(t), rename = fs.rename.bind(fs);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target.endsWith('.progress')) { entered(); await new Promise(resolve => { release = resolve; }); }
    return rename(source, target);
  });
  protocol.progress({ message: '准备中' }); await waiting;
  const completion = protocol.ready(components);
  await assert.rejects(fs.stat(report), { code: 'ENOENT' });
  release(); await completion;
  await protocol.progress({ message: '迟到的进度' });
  assert.equal(JSON.parse(await fs.readFile(report + '.progress', 'utf8')).message, '准备中');
  assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).ok, true);
});

test("最终就绪报告的占用会重试，永久失败必须拒绝且不留下假成功报告", async t => {
  const { report, protocol } = await fixture(t), rename = fs.rename.bind(fs);
  let fail = true;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(source, target);
  });
  await assert.rejects(protocol.ready(components), { code: 'ENOSPC' });
  await assert.rejects(fs.stat(report), { code: 'ENOENT' });
  fail = false; await protocol.fail(new Error('最终报告无法写入'));
  assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).ok, false);
});

test("Windows 真实禁止删除共享的读句柄释放后，进度和最终报告均恢复写入", { skip: process.platform !== 'win32' }, async t => {
  const { report, protocol } = await fixture(t);
  await protocol.progress({ downloaded: 1, size: 10 });
  const code = `import ctypes,sys,time
from ctypes import wintypes
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
k.CreateFileW.restype=wintypes.HANDLE
k.CloseHandle.argtypes=[wintypes.HANDLE]
h=k.CreateFileW(sys.argv[1],0x80000000,1,None,3,0,None)
assert h!=wintypes.HANDLE(-1).value,ctypes.get_last_error()
print('locked',flush=True)
time.sleep(.15)
k.CloseHandle(h)
`;
  async function lockedWrite(file, write) {
    const child = spawn('python', ['-u', '-c', code, file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', b => { output += b; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', status => status === 0 ? resolve() : reject(new Error(output || `锁定进程退出 ${status}`)));
    });
    await Promise.race([
      new Promise(resolve => child.stdout.once('data', resolve)),
      closed.then(() => { throw new Error('未获得文件锁'); })
    ]);
    await write(); await closed;
  }
  await lockedWrite(report + '.progress', () => protocol.progress({ downloaded: 9, size: 10 }));
  assert.equal(JSON.parse(await fs.readFile(report + '.progress', 'utf8')).downloaded, 9);
  await fs.writeFile(report, '{}');
  await lockedWrite(report, () => protocol.ready(components));
  assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).ok, true);
});
