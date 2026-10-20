const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { selectProfile, downloadAsset, safePath, validateAsset, resolveManagedPython, offlinePipArgs, RuntimeService, PROBE, STARTUP_PROBE } = require("../runtime-service");
const config = require("../runtime-config.json");

test("50 系及 Blackwell 路由 CUDA 12.8，40 系路由 CUDA 12.6，集显使用 CPU", () => {
  for (const name of ["NVIDIA GeForce RTX 5090", "NVIDIA GeForce RTX 5060 Laptop GPU"]) {
    assert.equal(selectProfile([{ index: "0", name, driver: "580.97", capability: 0 }]).profile, "cu128");
  }
  assert.equal(selectProfile([{ name: "NVIDIA B200", driver: "580.97", capability: 10 }]).profile, "cu128");
  assert.equal(selectProfile([{ name: "RTX 4070 Ti SUPER", driver: "580.97", capability: 8.9 }]).profile, "cu126");
  assert.equal(selectProfile([]).profile, "cpu");
  const result = selectProfile([{ index: "0", name: "RTX 3060", driver: "580.97", capability: 8.6 }, { index: "1", name: "RTX 5090", driver: "580.97", capability: 12 }]);
  assert.equal(result.gpu.index, "1");
});

test("驱动不足和无法确认驱动时阻止启动并提供修复信息", () => {
  assert.throws(() => selectProfile([{ name: "RTX 5090", driver: "566.36", capability: 12 }]), /570.65/);
  assert.throws(() => selectProfile([{ name: "RTX 4090", driver: "551.61", capability: 8.9 }]), /560.76/);
  assert.throws(() => selectProfile([{ name: "RTX 5090", driver: "unknown", capability: 12 }]), /NVIDIA 驱动/);
});

test("清单与路径校验拒绝越界及无哈希资源", () => {
  for (const name of ["../model", "a/../../b", "C:/model", "a\\b", "/model", "a//b"]) assert.throws(() => safePath(os.tmpdir(), name));
  assert.throws(() => validateAsset({ name: "a.zip", size: 100, sha256: "", urls: ["https://example.com/a"] }));
  for (const asset of [config.python, config.pip, ...Object.values(config.profiles).flatMap((p) => p.wheels), ...config.models.flatMap((m) => m.files)]) validateAsset(asset);
});

async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-runtime-"));
  const bytes = Buffer.from("可信模型资源".repeat(2000));
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.headers.range || "full"); handler(req, res, bytes, requests.length); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/model`;
  const asset = { name: "模型.bin", size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), urls: [url] };
  return { directory, bytes, requests, asset, options: { allowHttp: true } };
}

test("跨目录资源通过哈希复用，缺失或同大小损坏在离线模式下禁止下载", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-local-reuse-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), target = path.join(directory, 'target');
  await fs.mkdir(source);
  const bytes = Buffer.from('可信共享依赖');
  const asset = { name: 'dependency.whl', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), urls: ['https://example.invalid/dependency.whl'] };
  await fs.writeFile(path.join(source, asset.name), bytes);
  const previous = process.env.VOXCPM_OFFLINE;
  process.env.VOXCPM_OFFLINE = '1';
  t.after(() => { if (previous === undefined) delete process.env.VOXCPM_OFFLINE; else process.env.VOXCPM_OFFLINE = previous; });
  let requests = 0;
  const options = { localDirectories: [source], fetchImpl: () => { requests++; throw new Error('禁止外网'); } };
  const file = await downloadAsset(asset, target, options);
  assert.deepEqual(await fs.readFile(file), bytes);
  // 修改副本不会影响共享来源。
  await fs.writeFile(file, Buffer.alloc(bytes.length));
  assert.deepEqual(await fs.readFile(path.join(source, asset.name)), bytes);
  await fs.writeFile(path.join(source, asset.name), Buffer.alloc(bytes.length));
  await assert.rejects(downloadAsset(asset, target, options), /离线验收缺少资源/);
  assert.equal(requests, 0);
});

test("续传请求准确接续，完成文件零下载复用，同大小损坏重新下载", async (t) => {
  const f = await fixture(t, (req, res, bytes) => {
    const offset = req.headers.range ? Number(req.headers.range.match(/\d+/)[0]) : 0;
    res.writeHead(offset ? 206 : 200, { "Content-Length": bytes.length - offset, ...(offset ? { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    res.end(bytes.subarray(offset));
  });
  const target = path.join(f.directory, f.asset.name);
  await fs.writeFile(target + ".part", f.bytes.subarray(0, 701));
  await downloadAsset(f.asset, f.directory, f.options);
  assert.deepEqual(f.requests, ["bytes=701-"]);
  await downloadAsset(f.asset, f.directory, { ...f.options, fetchImpl: () => { throw new Error("完整资源不应联网"); } });
  await fs.writeFile(target, Buffer.alloc(f.bytes.length));
  await downloadAsset(f.asset, f.directory, f.options);
  assert.deepEqual(await fs.readFile(target), f.bytes);
  assert.equal(f.requests.length, 2);
});

test("服务器忽略 Range 时从零下载，不追加重复字节", async (t) => {
  const f = await fixture(t, (_req, res, bytes) => { res.writeHead(200, { "Content-Length": bytes.length }); res.end(bytes); });
  await fs.writeFile(path.join(f.directory, f.asset.name) + ".part", f.bytes.subarray(0, 111));
  await downloadAsset(f.asset, f.directory, f.options);
  assert.deepEqual(await fs.readFile(path.join(f.directory, f.asset.name)), f.bytes);
});

test("错误续传范围与下载哈希不符都不能产生完成文件", async (t) => {
  const f = await fixture(t, (_req, res, bytes) => { res.writeHead(206, { "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` }); res.end(bytes); });
  const target = path.join(f.directory, f.asset.name);
  await fs.writeFile(target + ".part", f.bytes.subarray(0, 99));
  await assert.rejects(downloadAsset(f.asset, f.directory, f.options), /续传范围/);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  const bad = { ...f.asset, sha256: "0".repeat(64) };
  await fs.rm(target + ".part");
  await assert.rejects(downloadAsset(bad, f.directory, f.options), /SHA-256/);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("截断后重试使用保留分片，取消不标记成功", async (t) => {
  const f = await fixture(t, (req, res, bytes, n) => {
    const offset = req.headers.range ? Number(req.headers.range.match(/\d+/)[0]) : 0;
    res.writeHead(offset ? 206 : 200, { "Content-Length": bytes.length - offset, ...(offset ? { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    if (n === 1) { res.write(bytes.subarray(0, 1024)); setTimeout(() => res.destroy(), 30); }
    else res.end(bytes.subarray(offset));
  });
  await downloadAsset(f.asset, f.directory, f.options);
  assert.deepEqual(f.requests, ["full", "bytes=1024-"]);
  const controller = new AbortController(); controller.abort(new Error("用户暂停"));
  await assert.rejects(downloadAsset(f.asset, f.directory, { ...f.options, signal: controller.signal }), /用户暂停/);
});

test("重复运行去重，失败可重新准备", async () => {
  const service = new RuntimeService({ config });
  let calls = 0, release;
  service.prepareInternal = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const first = service.prepare(), second = service.prepare();
  assert.equal(first, second); assert.equal(calls, 1);
  release({ python: "test" }); await first;
  service.prepareInternal = async () => { throw new Error("网络中断"); };
  await assert.rejects(service.prepare(), /网络中断/);
  assert.equal(service.state.status, "error");
  service.prepareInternal = async () => ({ python: "recovered" });
  assert.equal((await service.prepare()).python, "recovered");
});

test("旧驱动查询降级及损坏驱动与无卡的区分", async () => {
  const service = new RuntimeService({ config });
  service.controller = new AbortController();
  service.run = async (_command, args) => {
    if (args[0].includes("compute_cap")) throw Error("unsupported field");
    return "0, NVIDIA GeForce RTX 5090, 580.97\n";
  };
  assert.equal((await service.detect()).profile, "cu128");
  service.run = async (command) => { if (command === "nvidia-smi") throw Error("driver broken"); return "NVIDIA GeForce RTX 5090"; };
  await assert.rejects(service.detect(), /安装或修复 NVIDIA 驱动/);
  service.run = async (command) => { if (command === "nvidia-smi") throw Error("no nvidia"); return "Intel UHD Graphics"; };
  assert.equal((await service.detect()).profile, "cpu");
});

test("启动和独立更新器仅选择已完成验证的托管 Python", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-python-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "runtime/managed/py312-cu128");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "python.exe"), "test");
  assert.equal(resolveManagedPython(root), "");
  await fs.writeFile(path.join(directory, "ready.json"), "{}");
  assert.equal(resolveManagedPython(root), path.join(directory, "python.exe"));
});

test("默认资源均优先使用魔搭，固定依赖清单完整", () => {
  const assets = [config.python, config.pip, config.wheelhouse.requirements, ...config.wheelhouse.files,
    ...Object.values(config.profiles).flatMap((p) => p.wheels), ...config.models.flatMap((m) => m.files)];
  for (const asset of assets) {
    validateAsset(asset);
    assert.equal(new URL(asset.urls[0]).hostname, "modelscope.cn", asset.name);
  }
  assert.ok(config.wheelhouse.files.length > 100);
  assert.equal(new Set(config.wheelhouse.files.map((a) => a.name)).size, config.wheelhouse.files.length);
});

test("三种依赖配置强制本地 wheel 安装，禁止 PyPI 与源码构建", () => {
  for (const profile of ["cpu", "cu126", "cu128"]) {
    const args = offlinePipArgs(config, profile, os.tmpdir(), "requirements.txt");
    assert.ok(args.includes("--no-index"));
    assert.ok(args.includes("--only-binary=:all:"));
    assert.ok(!args.includes("--index-url"));
    assert.ok(args.includes(`torch==${config.profiles[profile].torch}+${profile}`));
    assert.ok(args.includes(`torchaudio==${config.profiles[profile].torch}+${profile}`));
    assert.ok(args.includes(path.join(os.tmpdir(), config.wheelhouse.requirements.name)));
  }
});

async function startupFixture(t, managed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-startup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, "shell"), appRoot = path.join(root, "app"), dataRoot = path.join(root, "data");
  await fs.mkdir(appDir, { recursive: true }); await fs.mkdir(appRoot);
  await fs.writeFile(path.join(appDir, "runtime-requirements.txt"), "gradio==6.13.0\n");
  const asset = (name, bytes) => ({ name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), urls: ["https://example.invalid/should-not-download"] });
  const bytes = Buffer.from("完整模型"), modelConfig = Buffer.from('{"architecture":"voxcpm2"}');
  const localConfig = { protocol: 1, python: { ...asset("python.zip", bytes), version: "3.12.10" }, pip: asset("pip.whl", bytes),
    profiles: { cu126: { torch: "2.6.0", wheels: [] } }, models: [] };
  for (let i = 0; i < 3; i++) {
    const folder = `model-${i}`, location = path.join(root, "models", folder);
    await fs.mkdir(location, { recursive: true });
    const files = [asset("config.json", modelConfig), asset("weights.bin", bytes)];
    await fs.writeFile(path.join(location, "config.json"), modelConfig); await fs.writeFile(path.join(location, "weights.bin"), bytes);
    localConfig.models.push({ folder, files });
  }
  const directory = path.join(root, managed ? "runtime/managed/py312-cu126" : "existing-python");
  const python = path.join(directory, "python.exe"), moduleFile = path.join(directory, "Lib/site-packages/torch/__init__.py");
  await fs.mkdir(path.dirname(moduleFile), { recursive: true });
  await fs.writeFile(python, "python fixture"); await fs.writeFile(moduleFile, "# package entry");
  if (managed) await fs.writeFile(path.join(directory, "ready.json"), '{"signature":"legacy-ready-marker"}');
  const selected = selectProfile([{ index: "0", name: "RTX 3060", driver: "580.97", capability: 8.6 }]);
  const calls = [], states = [];
  const create = () => {
    const service = new RuntimeService({ root, appDir, appRoot, dataRoot, config: localConfig, onState: state => states.push({ ...state }),
      runProcess: async (_command, args) => {
        calls.push(args);
        if (args[1] === STARTUP_PROBE) return JSON.stringify({ files: [moduleFile, path.dirname(moduleFile)] });
        if (args[1]?.startsWith("import imageio_ffmpeg,shutil")) await fs.writeFile(args[2], "ffmpeg fixture");
        return "";
      } });
    service.detect = async () => selected;
    return service;
  };
  return { root, appDir, appRoot, dataRoot, localConfig, python, moduleFile, selected, calls, states, create,
    options: { managed, existingPython: python, existingModel: path.join(root, "models/model-0") } };
}

test("正常启动不探测设备、不检查其他模型、不启动推理自检，缺失模型也可进入服务", async t => {
  const f = await startupFixture(t);
  await fs.rm(path.join(f.options.existingModel, "weights.bin"));
  const service = f.create();
  service.detect = async () => { throw Error("不应执行设备探测"); };
  service.prepare = async () => { throw Error("不应执行完整准备"); };
  const result = await service.launch(f.options);
  assert.equal(result.python, f.python);
  assert.equal(result.modelDir, f.options.existingModel);
  assert.equal(result.env.VOXCPM_LAZY_STARTUP, "1");
  assert.equal(result.env.VOXCPM_RUNTIME_CONFIG, path.join(f.appDir, "runtime-config.json"));
  assert.deepEqual(f.calls, []);
});

test("缺少解释器的首次安装仍走完整准备", async t => {
  const f = await startupFixture(t);
  const service = f.create();
  let options;
  service.prepare = async value => { options = value; return { python: "prepared" }; };
  assert.equal((await service.launch({ existingPython: path.join(f.root, "missing.exe") })).python, "prepared");
  assert.equal(options.existingPython, path.join(f.root, "missing.exe"));
});

test("连续启动复用落盘缓存，不重复完整导入、pip 检查或模型哈希，也不进入补齐状态", async t => {
  const f = await startupFixture(t);
  await f.create().prepare(f.options);
  assert.equal(f.calls.filter(args => args.includes(PROBE)).length, 1);
  assert.ok(!f.states.some(state => state.status === "working"));
  f.calls.length = 0; f.states.length = 0;
  const restarted = f.create();
  restarted.prepareModels = async () => { throw new Error("正常重启不应重算模型哈希"); };
  assert.equal((await restarted.prepare(f.options)).python, f.python);
  assert.deepEqual(f.calls.map(args => args[1]), [STARTUP_PROBE]);
  assert.equal(restarted.state.cached, true);
  assert.ok(!f.states.some(state => state.status === "working"));
});

test("旧版托管环境迁移一次后快速复用，Python 自动识别路径变化不会使缓存失效", async t => {
  const f = await startupFixture(t, true);
  await f.create().prepare({ ...f.options, existingPython: "python" });
  assert.ok(f.calls.some(args => args[0] === "-m" && args[1] === "pip" && args[2] === "check"));
  assert.ok(!f.calls.some(args => args.includes("install")));
  f.calls.length = 0;
  const restarted = f.create(), result = await restarted.prepare({ ...f.options, managed: false });
  assert.equal(restarted.state.cached, true);
  assert.ok(result.env.PATH.startsWith(path.join(path.dirname(f.python), "ffmpeg")));
  assert.deepEqual(f.calls.map(args => args[1]), [STARTUP_PROBE]);
});

for (const change of ["模型同大小改写", "模型缺失", "包入口改写", "依赖要求变化", "显卡驱动变化", "缓存损坏"]) {
  test(`${change}时失效并重新检查，不盲目信任旧就绪记录`, async t => {
    const f = await startupFixture(t);
    await f.create().prepare(f.options); f.calls.length = 0;
    if (change === "模型同大小改写") await fs.writeFile(path.join(f.options.existingModel, "weights.bin"), Buffer.alloc(Buffer.byteLength("完整模型")));
    if (change === "模型缺失") await fs.rm(path.join(f.options.existingModel, "weights.bin"));
    if (change === "包入口改写") await fs.appendFile(f.moduleFile, "\n# changed");
    if (change === "依赖要求变化") await fs.appendFile(path.join(f.appDir, "runtime-requirements.txt"), "# new requirements\n");
    if (change === "显卡驱动变化") f.selected.gpu.driver = "581.00";
    if (change === "缓存损坏") await fs.writeFile(path.join(f.dataRoot, "cache/runtime-ready.json"), "{broken");
    const restarted = f.create(); let rechecked = false;
    restarted.prepareModels = async () => { rechecked = true; throw new Error("已进入完整复检"); };
    await assert.rejects(restarted.prepare(f.options), /已进入完整复检/);
    assert.equal(rechecked, true);
    assert.ok(!f.calls.some(args => args.includes(PROBE)), "模型检查不能被完整音频导入阻塞");
  });
}

test("快速检查异常会回到真实复检，通过时复用依赖而不强制安装", async t => {
  const f = await startupFixture(t);
  await f.create().prepare(f.options); f.calls.length = 0;
  const restarted = f.create(), nativeProbe = restarted.startupProbe.bind(restarted);
  let failed = false;
  restarted.startupProbe = async (...args) => {
    if (!failed) { failed = true; throw new Error("快速检查失败"); }
    return nativeProbe(...args);
  };
  await restarted.prepare(f.options);
  assert.ok(f.calls.some(args => args.includes(PROBE)));
  assert.ok(!f.calls.some(args => args.includes("install")));
});

test("丢失单个模型只补齐该文件，保留已可用的 Python 和依赖", async t => {
  const offline = process.env.VOXCPM_OFFLINE;
  delete process.env.VOXCPM_OFFLINE; // 本例使用内存 fetch 夹具，不访问外网。
  t.after(() => { if (offline !== undefined) process.env.VOXCPM_OFFLINE = offline; });
  const f = await startupFixture(t, true);
  await f.create().prepare(f.options); f.calls.length = 0; f.states.length = 0;
  const target = path.join(f.options.existingModel, "weights.bin"), bytes = await fs.readFile(target);
  await fs.rm(target);
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.length) } });
  });
  const repaired = f.create();
  await repaired.prepare(f.options);
  assert.equal(downloads, 1);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.ok(f.states.some(state => state.status === "working" && state.phase === "models"));
  assert.ok(!f.calls.some(args => args.includes("install")));
  assert.ok(!f.calls.some(args => args.includes(PROBE) || args.includes("pip")), "模型缺失不能连带重复检查 Python/CUDA 环境");
  assert.equal(repaired.state.environmentCached, true);
});

for (const change of ["模型清单变化", "包入口损坏", "依赖版本要求变化", "显卡驱动变化"]) {
  test(`${change}时环境缓存只对环境自身变化失效`, async t => {
    const f = await startupFixture(t, true);
    await f.create().prepare(f.options); f.calls.length = 0;
    if (change === "模型清单变化") f.localConfig.models[0].label = "新版模型说明";
    if (change === "包入口损坏") await fs.appendFile(f.moduleFile, "\n# changed");
    if (change === "依赖版本要求变化") await fs.appendFile(path.join(f.appDir, "runtime-requirements.txt"), "# updated\n");
    if (change === "显卡驱动变化") f.selected.gpu.driver = "581.01";
    const restarted = f.create();
    await restarted.prepare(f.options);
    assert.equal(restarted.state.environmentCached, change === "模型清单变化");
    assert.equal(f.calls.some(args => args.includes(PROBE)), change !== "模型清单变化");
  });
}

test("缺失模型先下载，再加载音频框架与验证显卡", async t => {
  const offline = process.env.VOXCPM_OFFLINE;
  delete process.env.VOXCPM_OFFLINE;
  t.after(() => { if (offline !== undefined) process.env.VOXCPM_OFFLINE = offline; });
  const f = await startupFixture(t, true);
  const target = path.join(f.options.existingModel, "weights.bin"), bytes = await fs.readFile(target);
  await fs.rm(target);
  t.mock.method(globalThis, "fetch", async () => {
    assert.ok(!f.calls.some(args => args.includes(PROBE)), "下载前不应执行完整导入");
    return new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
  });
  await f.create().prepare(f.options);
  assert.ok(f.calls.some(args => args.includes(PROBE)));
  assert.deepEqual(await fs.readFile(target), bytes);
});

for (const managed of [false, true]) {
  test(`${managed ? "托管" : "已有"}音频自检超时保留环境，不强制重装依赖或标记就绪`, async t => {
    const f = await startupFixture(t, managed), service = f.create();
    const runner = service.processRunner;
    service.processRunner = async (command, args, options) => {
      if (!args.includes(PROBE)) return runner(command, args, options);
      options.onLine('VOXCPM_PROBE "加载文本处理规则（首次加载较慢）"');
      throw Object.assign(new Error("运行环境检查超时"), { code: "RUNTIME_PROCESS_TIMEOUT" });
    };
    await assert.rejects(service.prepare(f.options), /文本处理规则.*不会因超时重新安装依赖/);
    assert.ok(!f.calls.some(args => args.includes("install")));
    assert.equal(service.state.status, "error");
    assert.ok(f.states.some(s => /音频自检：加载文本处理规则.*已用时/.test(s.message)));
    await assert.rejects(fs.stat(path.join(f.dataRoot, "cache/runtime-ready.json")), { code: "ENOENT" });
  });
}

test("真实子进程分片与多字节输出能逐行报告自检阶段，超时返回独立错误码", async t => {
  const f = await startupFixture(t), service = f.create();
  service.processRunner = null;
  service.controller = new AbortController();
  service.env = process.env;
  service.logPath = path.join(f.root, "probe.log");
  const lines = [];
  const code = "const b=Buffer.from('VOXCPM_PROBE '+JSON.stringify('加载音频组件')+'\\n末行');process.stdout.write(b.subarray(0,18));setTimeout(()=>process.stdout.write(b.subarray(18)),20)";
  await service.run(process.execPath, ["-e", code], { quiet: true, timeout: 5000, onLine: line => lines.push(line) });
  assert.deepEqual(lines, ['VOXCPM_PROBE "加载音频组件"', '末行']);
  await assert.rejects(service.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { quiet: true, timeout: 100 }), { code: "RUNTIME_PROCESS_TIMEOUT" });
});
