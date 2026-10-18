const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { selectProfile, downloadAsset, safePath, validateAsset, resolveManagedPython, RuntimeService } = require("../runtime-service");
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
