const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { UpdateService, compareVersions, isNewer, verifyEnvelope } = require("../update-service");

const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const bytes = Buffer.from("VoxCPM real HTTP download test content".repeat(100));
const hash = crypto.createHash("sha256").update(bytes).digest("hex");
function sign(manifest) {
  const payload = JSON.stringify(manifest);
  return { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("hex") };
}
function manifest(url) {
  return { protocol: 1, product: "voxcpm-studio", platform: "win32-x64", version: "2.0.2", minVersion: "0.2.0",
    notes: "中文更新说明", package: { url, sha256: hash, size: bytes.length } };
}
test("版本按数字比较，拒绝非法版本", () => {
  assert.equal(compareVersions("2.0.10", "2.0.2"), 1);
  assert.equal(compareVersions("2.0.2", "2.0.2"), 0);
  assert.throws(() => compareVersions("2.0.bad", "2.0.2"));
});
test("同一正式版本通过发布序号升级，拒绝旧检查点", () => {
  assert.equal(isNewer({version:"2.0.2",releaseId:"20261017000002"}, "2.0.2", "20261017000001"), true);
  assert.equal(isNewer({version:"2.0.2",releaseId:"20261017000001"}, "2.0.2", "20261017000002"), false);
  assert.equal(isNewer({version:"2.0.1",releaseId:"20261017000009"}, "2.0.2", "20261017000002"), false);
});
test("签名、产品、最低基线、下载协议校验", () => {
  const m = manifest("https://example.com/update.zip");
  assert.equal(verifyEnvelope(sign(m), publicKey, "2.0.1").version, "2.0.2");
  const forged = sign(m); forged.payload += " ";
  assert.throws(() => verifyEnvelope(forged, publicKey, "2.0.1"), /签名/);
  assert.throws(() => verifyEnvelope(sign({ ...m, product: "other" }), publicKey, "2.0.1"), /不兼容/);
  assert.throws(() => verifyEnvelope(sign({ ...m, minVersion: "3.0.0" }), publicKey, "2.0.1"), /完整便携包/);
  assert.throws(() => verifyEnvelope(sign(manifest("http://example.com/a")), publicKey, "2.0.1"), /HTTPS/);
});
test("真实 HTTP 检查、断点续传、哈希失败与并发保护", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "voxcpm-update-test-"));
  let responseMode = "range", rangeSeen = false, latest;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers["user-agent"], "VoxCPM-Studio-Updater/1.0");
    if (req.url === "/latest") return res.end(JSON.stringify(latest));
    let offset = 0;
    if (req.headers.range && responseMode === "range") {
      offset = Number(req.headers.range.match(/\d+/)[0]); rangeSeen = true;
      res.writeHead(206, { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` });
    }
    res.end(responseMode === "corrupt" ? Buffer.alloc(bytes.length) : bytes.subarray(offset));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  latest = sign(manifest(base + "/package"));
  fs.writeFileSync(path.join(temp, "updater.py"), "# test helper");
  const service = new UpdateService({ root: temp, dataRoot: temp, appDir: temp, currentVersion: "2.0.1",
    config: { manifestUrl: base + "/latest", publicKey, autoCheck: true } });
  assert.equal((await service.check()).status, "available");
  fs.mkdirSync(service.cache, { recursive: true });
  const part = path.join(service.cache, hash + ".part");
  fs.writeFileSync(part, bytes.subarray(0, 100));
  assert.equal((await service.download()).status, "downloaded");
  assert.equal(rangeSeen, true);
  assert.deepEqual(fs.readFileSync(path.join(service.session, "package.zip")), bytes);
  assert.equal(service.setAutoCheck(false).autoCheck, false);
  assert.equal(service.getAutoCheck(), false);
  fs.unlinkSync(part);
  responseMode = "ignore-range"; fs.writeFileSync(part, bytes.subarray(0, 200));
  assert.equal((await service.download()).status, "downloaded");
  fs.unlinkSync(part); responseMode = "corrupt";
  assert.equal((await service.download()).status, "error");
  assert.equal(fs.existsSync(part), false);
  assert.match(service.state.message, /SHA-256/);
  service.running = true;
  assert.equal((await service.check()).status, "error");
  service.running = false;
  latest = sign({ ...manifest(base + "/package"), version: "2.0.1" });
  assert.equal((await service.check()).status, "current");
  await assert.rejects(service.download(), /先检查/);
  latest.signature = "00".repeat(64);
  assert.equal((await service.check()).status, "error");
});
