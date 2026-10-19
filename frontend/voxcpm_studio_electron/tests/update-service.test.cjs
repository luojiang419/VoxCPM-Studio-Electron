const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { UpdateService, compareVersions, isNewer, verifyEnvelope } = require("../update-service");

const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const python = process.env.VOXCPM_TEST_PYTHON || "python";
const updater = Buffer.from("# signed new updater\n".repeat(100));
const native = Buffer.from("MZ signed native updater fixture");
const bytes = execFileSync(python, ["-c", "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('resources/app/updater.py',sys.stdin.buffer.read()); z.writestr('resources/app/standalone-updater.exe',b'MZ signed native updater fixture'); z.close(); sys.stdout.buffer.write(b.getvalue())"], { input: updater });
const hash = crypto.createHash("sha256").update(bytes).digest("hex");
function sign(manifest) {
  const payload = JSON.stringify(manifest);
  return { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("hex") };
}
function manifest(url) {
  return { protocol: 1, product: "voxcpm-studio", platform: "win32-x64", version: "2.0.2", minVersion: "0.2.0",
    notes: "中文更新说明", package: { url, sha256: hash, size: bytes.length },
    files: [{ path: "resources/app/updater.py", size: updater.length, sha256: crypto.createHash("sha256").update(updater).digest("hex") },
      { path: "resources/app/standalone-updater.exe", size: native.length, sha256: crypto.createHash("sha256").update(native).digest("hex") }] };
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
  const service = new UpdateService({ root: temp, dataRoot: temp, appDir: temp, currentVersion: "2.0.1", pythonExecutable: python, getTheme: () => "dark",
    config: { manifestUrl: base + "/latest", publicKey, autoCheck: true } });
  const automatic = await service.check({ source: "startup" });
  assert.equal(automatic.status, "available");
  assert.equal(automatic.checkSource, "startup");
  assert.equal((await service.check()).checkSource, "manual");
  fs.mkdirSync(service.cache, { recursive: true });
  const part = path.join(service.cache, hash + ".part");
  fs.writeFileSync(part, bytes.subarray(0, 100));
  assert.equal((await service.download()).status, "downloaded");
  assert.equal(rangeSeen, true);
  assert.deepEqual(fs.readFileSync(path.join(service.session, "package.zip")), bytes);
  assert.deepEqual(fs.readFileSync(path.join(service.session, "updater.py")), updater, "首次升级必须使用签名新版更新器，不能沿用旧脚本");
  assert.deepEqual(fs.readFileSync(path.join(service.session, "VoxCPM Updater.exe")), native, "独立EXE必须从签名包校验后放到会话目录");
  assert.equal(JSON.parse(fs.readFileSync(path.join(service.session, "session.json"))).theme, "dark");
  assert.equal((await service.check()).status, "downloaded", "检查不能丢弃已准备更新");
  service.state.status = "installing";
  assert.equal((await service.check()).status, "installing");
  service.state.status = "downloaded";
  assert.equal(service.setAutoCheck(false).autoCheck, false);
  assert.equal(service.getAutoCheck(), false);
  fs.unlinkSync(part);
  responseMode = "ignore-range"; fs.writeFileSync(part, bytes.subarray(0, 200));
  assert.equal((await service.download()).status, "downloaded");
  fs.unlinkSync(part); responseMode = "corrupt";
  assert.equal((await service.download()).status, "error");
  assert.equal(fs.existsSync(part), false);
  assert.match(service.state.message, /SHA-256/);
  responseMode = "range";
  latest = sign({ ...manifest(base + "/package"), files: [{ ...manifest(base + "/package").files[0], sha256: "0".repeat(64) }] });
  await service.check();
  assert.equal((await service.download()).status, "error");
  assert.match(service.state.message, /更新器哈希/);
  service.running = true;
  assert.equal((await service.check()).status, "error");
  service.running = false;
  service.state.status = "idle";
  latest = sign({ ...manifest(base + "/package"), version: "2.0.1" });
  assert.equal((await service.check()).status, "current");
  await assert.rejects(service.download(), /先检查/);
  latest.signature = "00".repeat(64);
  assert.equal((await service.check()).status, "error");
});

test("更新器未能启动时保留主程序，并记录取消避免延迟安装", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "voxcpm-update-launch-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const service = new UpdateService({ root: temp, dataRoot: temp, appDir: temp, currentVersion: "2.0.1", config: {} });
  service.session = path.join(temp, "session"); fs.mkdirSync(service.session);
  fs.writeFileSync(path.join(temp, "runtime_manifest.json"), "{}");
  fs.writeFileSync(path.join(service.session, "session.json"), JSON.stringify({ parentPid: process.pid }));
  fs.writeFileSync(path.join(service.session, "envelope.json"), JSON.stringify(sign(manifest("https://example.com/a.zip"))));
  service.state.status = "downloaded";
  await assert.rejects(service.launch(), /ENOENT/);
  assert.equal(service.state.status, "error");
  assert.equal(service.state.canDownload, true);
  assert.equal(fs.existsSync(path.join(service.session, "cancel.json")), true);
  fs.mkdirSync(service.cache, { recursive: true });
  fs.writeFileSync(path.join(service.cache, "last-result.json"), JSON.stringify({ status: "rolled-back", message: "服务启动失败", session: service.session }));
  assert.equal(service.getState().lastResult.status, "rolled-back");
});

test("启动提醒按发布去重，手动检查可重新打开，失败后允许重试", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "voxcpm-prompt-dedup-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const service = new UpdateService({ root: temp, dataRoot: temp, appDir: temp, currentVersion: "2.0.2", config: {} });
  let opens = 0, failed = false;
  service.check = async () => ({ status: "available", latestVersion: "2.0.2", latestReleaseId: "20261019000002" });
  service.showPrompt = async () => { opens++; if (failed) throw Error("native unavailable"); };
  await service.checkAndPrompt({ source: "startup" });
  await service.checkAndPrompt({ source: "startup" });
  assert.equal(opens, 1);
  await service.checkAndPrompt(); assert.equal(opens, 2);
  service.check = async () => ({ status: "available", latestVersion: "2.0.2", latestReleaseId: "20261019000003" });
  failed = true; await service.checkAndPrompt({ source: "startup" });
  assert.match(service.state.message, /native unavailable/);
  failed = false; await service.checkAndPrompt({ source: "startup" }); assert.equal(opens, 4);
});

test("延期不下载或退出；立即更新自动衔接，失败不退出且可重试", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "voxcpm-prompt-choice-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let quits = 0;
  const service = new UpdateService({ root: temp, dataRoot: temp, appDir: temp, currentVersion: "2.0.2", config: {}, onInstallReady: () => quits++ });
  const folder = path.join(temp, "prompt"); fs.mkdirSync(folder);
  const createPrompt = () => (service.prompt = { folder, child: { pid: 123 }, busy: false });
  const choose = (action, hostPid = 123) => fs.writeFileSync(path.join(folder, "choice.json"), JSON.stringify({ session: folder, hostPid, action }));
  const order = []; let failedDownload = false, failedLaunch = false;
  service.download = async () => { order.push("download"); return service.setState({ status: failedDownload ? "error" : "downloaded" }); };
  service.launch = async () => { order.push("ready"); if (failedLaunch) throw Error("handshake failed"); };
  let prompt = createPrompt(); service.state.status = "available";
  choose("now", 999); await service.handlePromptChoice(prompt); assert.deepEqual(order, []);
  choose("later"); await service.handlePromptChoice(prompt);
  assert.deepEqual(order, []); assert.equal(quits, 0); assert.equal(service.getAutoCheck(), true);
  assert.equal(service.prompt, null); assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "prompt-state.json"))).status, "closed");
  prompt = createPrompt(); failedDownload = true; choose("now"); await service.handlePromptChoice(prompt);
  assert.equal(quits, 0); assert.equal(service.prompt, prompt); assert.equal(prompt.busy, false);
  failedDownload = false; failedLaunch = true; choose("now"); await assert.rejects(service.handlePromptChoice(prompt), /handshake failed/);
  assert.equal(quits, 0); assert.equal(prompt.busy, false);
  failedLaunch = false; service.state.status = "available"; choose("now"); await service.handlePromptChoice(prompt);
  assert.deepEqual(order, ["download", "download", "ready", "download", "ready"]);
  assert.equal(quits, 1); assert.equal(service.prompt, null);
});
