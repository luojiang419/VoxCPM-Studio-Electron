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
test('只读复用安装资源时拒绝安装与移除，不更改选择或资源', async t => {
  const { service, runtimeService, root } = await setup(t);
  runtimeService.readOnlyResources = true;
  await assert.rejects(service.prepare({}), /只读复用/);
  await assert.rejects(service.remove('ace-xl-turbo'), /不能从此入口移除/);
  assert.equal(fs.existsSync(path.join(root, 'data/component-selection.json')), false);
});
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

test('真实下载保持准备状态，已安装组件自检仅标记启动', async t => {
  const { service, root, runtimeService, states } = await setup(t);
  const transfers = [];
  await service.ensureFile(asset('model.bin'), path.join(root, 'model.bin'), value => transfers.push(value), runtimeService.controller.signal);
  const begin = transfers.findIndex(value => value.downloading);
  assert.ok(begin >= 0);
  assert.ok(transfers.slice(begin).every(value => value.activity === 'prepare'));
  service.select({ selected: [], removed: ['ace-xl-turbo'] });
  service.api = async () => ({ hardware: { cuda: true, totalMB: 16384 } });
  await service.prepare({ url: '', runtime: {} });
  assert.ok(states.length > 0 && states.every(value => value.activity === 'startup'));
  assert.ok(states.every(value => value.status !== 'working'));
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

test('音乐模型先下载，随后准备视频和音乐环境，全部自检完成才能就绪', async t => {
  const { service, runtimeService } = await setup(t);
  service.select({ selected: ['lipsync', 'ace-xl-turbo'] });
  const order = []; let checks = 0;
  service.fetchImpl = async () => {
    order.push('model-download');
    return new Response(payload, { headers: { 'Content-Length': String(payload.length) } });
  };
  service.api = async (_url, route) => {
    if (route === '/api/lipsync/status') return { hardware: { cuda: true, totalMB: 16384 }, ready: ++checks > 1, needsPreparation: checks === 1 };
    if (route === '/api/lipsync/prepare') { order.push('video-prepare'); return { taskId: 'video' }; }
    if (route === '/api/tasks/video') return { status: 'succeeded' };
    throw new Error('不应访问 ' + route);
  };
  service.prepareRuntime = async () => {
    order.push('music-runtime');
    assert.ok(!fs.existsSync(service.receipt), '模型下载完成不能冒充全部环境就绪');
  };
  runtimeService.run = async () => { order.push('music-probe'); };
  await service.prepare({ url: '', runtime: {} });
  assert.deepEqual(order, ['model-download', 'video-prepare', 'music-runtime', 'music-probe']);
  assert.ok(fs.existsSync(service.receipt));
});

test('模型下载暂停保留断点，不启动视频/音乐环境；重试续传后才进入准备', async t => {
  const { service, runtimeService, root } = await setup(t);
  service.select({ selected: ['ace-xl-turbo'] });
  service.api = async () => ({ hardware: { cuda: true, totalMB: 16384 } });
  let requests = 0, preparations = 0;
  const target = path.join(root, 'models/music/ace-xl-turbo');
  service.fetchImpl = async (_url, options) => {
    if (++requests === 1) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(payload.subarray(0, 2)); },
        async pull() {
          for (let i = 0; i < 200; i++) {
            if (fs.existsSync(target + '.part') && fs.statSync(target + '.part').size === 2) break;
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          runtimeService.controller.abort(new Error('暂停模型下载'));
        }
      }), { headers: { 'Content-Length': String(payload.length) } });
    }
    assert.equal(options.headers.Range, 'bytes=2-');
    return new Response(payload.subarray(2), { status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 2-4/5' } });
  };
  service.prepareRuntime = async () => { preparations++; };
  await assert.rejects(service.prepare({ url: '', runtime: {} }), /暂停模型下载/);
  assert.equal(preparations, 0);
  assert.ok(!fs.existsSync(service.receipt));
  assert.equal(fs.readFileSync(target + '.part', 'utf8'), 'mu');
  runtimeService.controller = new AbortController();
  await service.prepare({ url: '', runtime: {} });
  assert.equal(preparations, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'music');
});

test('音乐自检超时不重新安装完整运行包，不标记就绪', async t => {
  const { service, runtimeService } = await setup(t);
  service.select({ selected: ['ace-xl-turbo'] });
  service.api = async () => ({ hardware: { cuda: true, totalMB: 16384 } });
  const attempts = [];
  service.prepareRuntime = async (_runtime, _emit, _signal, force) => attempts.push(!!force);
  runtimeService.run = async () => { throw Object.assign(new Error('自检超时'), { code: 'RUNTIME_PROCESS_TIMEOUT' }); };
  await assert.rejects(service.prepare({ url: '', runtime: {} }), { code: 'RUNTIME_PROCESS_TIMEOUT' });
  assert.deepEqual(attempts, [false]);
  assert.ok(!fs.existsSync(service.receipt));
});
