const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ComponentService, normalizeProfile } = require('../component-service');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const payload = Buffer.from('music');
const asset = name => ({ name, size: payload.length, sha256: hash(payload), urls: ['https://example.invalid/' + name] });
async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vox-components-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const states = [], calls = [];
  const runtimeService = { controller: new AbortController(), emit: s => states.push(s), run: async (...a) => calls.push(a) };
  const catalog = { protocol: 1, runtime: { version: 'test-v1', size: 5, installed_size: 10, sha256: hash(payload), parts: [asset('runtime.part00')], required: ['python/python.exe'] },
    models: ['ace-xl-turbo', 'yue2', 'minimax-music3', 'heartmula'].map(id => ({ id, label: id, files: [asset('models/music/' + id)] })) };
  const service = new ComponentService({ root, dataRoot: path.join(root, 'data'), appRoot: root, appDir: root, catalog, runtimeService,
    fetchImpl: async () => new Response(payload, { headers: { 'Content-Length': String(payload.length) } }) });
  return { root, service, runtimeService, states, calls, catalog };
}

test('选择迁移保留移除意图，默认模型必须属于所选音乐模型', () => {
  assert.deepEqual(normalizeProfile({ selected: ['ace-xl-turbo', 'heartmula'], removed: ['heartmula'] }).selected, ['ace-xl-turbo']);
  assert.equal(normalizeProfile({ selected: ['yue2'], defaultModel: 'heartmula' }).defaultModel, 'yue2');
  assert.throws(() => normalizeProfile({ selected: ['unknown'] }));
  assert.throws(() => normalizeProfile({ selected: [], removed: 'bad' }));
});
test('同大小损坏文件也会重新下载，后续启动使用校验缓存', async t => {
  const { service, root, runtimeService } = await setup(t);
  const target = path.join(root, 'model.bin');
  fs.writeFileSync(target, 'noise'); let downloads = 0;
  service.fetchImpl = async () => { downloads++; return new Response(payload, { headers: { 'Content-Length': '5' } }); };
  await service.ensureFile(asset('model.bin'), target, () => {}, runtimeService.controller.signal);
  assert.equal(fs.readFileSync(target, 'utf8'), 'music'); assert.equal(downloads, 1);
  await service.ensureFile(asset('model.bin'), target, () => {}, runtimeService.controller.signal);
  assert.equal(downloads, 1);
});
test('复用模型先校验，移除托管链接不删除原 ComfyUI 模型', async t => {
  const { service, root, runtimeService, catalog } = await setup(t);
  const source = path.join(root, 'external-comfy'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'source.bin'), payload); service.reuseRoots = [source];
  const model = catalog.models[0]; model.files[0].reusePath = 'source.bin';
  service.fetchImpl = () => { throw new Error('不应下载'); };
  service.select({ selected: [model.id] });
  await service.ensureFile(model.files[0], path.join(root, model.files[0].name), () => {}, runtimeService.controller.signal, true);
  const result = await service.remove(model.id);
  assert.equal(result.freed, 0); assert.equal(result.removedBytes, 5); assert.equal(result.sharedBytes, 5);
  assert.equal(fs.readFileSync(path.join(source, 'source.bin'), 'utf8'), 'music');
  assert.deepEqual(service.profile().removed, [model.id]);
  service.select({ ...service.profile(), selected: [model.id], removed: [] });
  assert.deepEqual(service.profile().selected, [model.id]);
});
test('移除保留其他已安装但未选中模型使用的共享文件', async t => {
  const { service, root, catalog } = await setup(t);
  catalog.models[1].files = catalog.models[0].files;
  const target = path.join(root, catalog.models[0].files[0].name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, payload);
  service.select({ selected: ['ace-xl-turbo'] });
  assert.equal((await service.remove('ace-xl-turbo')).freed, 0);
  assert.ok(fs.existsSync(target));
});
test('未完成下载也可移除并释放断点文件', async t => {
  const { service, root, catalog } = await setup(t);
  const target = path.join(root, catalog.models[0].files[0].name) + '.part';
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'part');
  assert.equal(service.state().options[1].present, true);
  assert.equal((await service.remove('ace-xl-turbo')).freed, 4);
  assert.equal(fs.existsSync(target), false);
});
test('旧用户按硬件默认 ACE，全部自检后才能写就绪凭证', async t => {
  const { service, runtimeService, calls } = await setup(t);
  service.api = async () => ({ ready: true, needsPreparation: false, hardware: { cuda: true, totalMB: 16384 } });
  service.prepareRuntime = async () => {};
  const receipt = await service.prepare({ url: 'http://localhost', runtime: {} });
  assert.deepEqual(receipt.selected, ['lipsync', 'ace-xl-turbo']); assert.equal(receipt.protocol, 2);
  assert.ok(calls[0][1].includes('ace-xl-turbo')); assert.ok(fs.existsSync(service.receipt));
  service.select({ selected: [], removed: ['ace-xl-turbo'] });
  assert.ok(!fs.existsSync(service.receipt));
  const second = await service.prepare({ url: 'http://localhost', runtime: {} });
  assert.deepEqual(second.selected, []); assert.ok(!runtimeService.controller.signal.aborted);
});
test('自检失败修复一次，仍失败不能伪装就绪', async t => {
  const { service, runtimeService } = await setup(t);
  service.select({ selected: ['heartmula'] });
  service.api = async () => ({ hardware: { cuda: true, totalMB: 16384 } });
  const attempts = []; service.prepareRuntime = async (_r, _e, _s, force) => attempts.push(!!force);
  runtimeService.run = async () => { throw new Error('依赖损坏'); };
  await assert.rejects(service.prepare({ url: '', runtime: {} }), /依赖损坏/);
  assert.deepEqual(attempts, [false, true]); assert.ok(!fs.existsSync(service.receipt));
});
test('视频任务失败或暂停不进入工作区；暂停会取消后台任务', async t => {
  const { service, runtimeService } = await setup(t);
  service.select({ selected: ['lipsync'] });
  const routes = [];
  service.api = async (_url, route) => {
    routes.push(route);
    if (route === '/api/lipsync/status') return { ready: false, needsPreparation: true, hardware: { cuda: true, totalMB: 16384 } };
    if (route === '/api/lipsync/prepare') return { taskId: 'test' };
    if (route.endsWith('/cancel')) return {};
    runtimeService.controller.abort(new Error('已暂停'));
    throw runtimeService.controller.signal.reason;
  };
  await assert.rejects(service.prepare({ url: '', runtime: {} }), /已暂停/);
  assert.ok(routes.includes('/api/tasks/test/cancel')); assert.ok(!fs.existsSync(service.receipt));
});
test('空间不足和并发进程在下载前拦截', async t => {
  const { service, catalog } = await setup(t);
  t.mock.method(fsp, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
  await assert.rejects(service.checkSpace(catalog.models), /空间不足/);
  const release = service.acquire();
  assert.throws(() => service.acquire(), /另一进程/); release();
});
test('视频补齐实际返回succeeded后立即复检，不无限轮询', async t => {
  const { service } = await setup(t);
  service.select({ selected: ['lipsync'] });
  let checks = 0, polls = 0;
  service.api = async (_url, route) => {
    if (route === '/api/lipsync/status') return { ready: ++checks > 1, needsPreparation: checks === 1, hardware: { cuda: true, totalMB: 16384 } };
    if (route === '/api/lipsync/prepare') return { taskId: 'prepared' };
    if (route === '/api/tasks/prepared') { if (++polls > 1) throw new Error('不应重复轮询成功任务'); return { status: 'succeeded' }; }
    return {};
  };
  const receipt = await service.prepare({ url: 'http://localhost', runtime: {} });
  assert.equal(receipt.protocol, 2); assert.equal(polls, 1); assert.equal(checks, 2);
});
test('续装空间预检扣除已下载的运行包分卷', async t => {
  const { service, root } = await setup(t);
  t.mock.method(fsp, 'statfs', async () => ({ bavail: 1024 ** 3 + 15, bsize: 1 }));
  await assert.rejects(service.checkSpace([], true), /空间不足/);
  const cache = path.join(root, 'data/cache/music-runtime/test-v1'); fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'runtime.part00'), payload);
  await service.checkSpace([], true);
});
