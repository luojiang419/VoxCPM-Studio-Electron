const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const { resolveManagedPython } = require("./runtime-service");
const { pipeline } = require("stream/promises");

function versionParts(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("更新版本格式无效");
  return value.split(".").map(Number);
}
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
function isNewer(manifest, currentVersion, currentReleaseId = "00000000000000") {
  const compared = compareVersions(manifest.version, currentVersion);
  return compared > 0 || (compared === 0 && (manifest.releaseId || "00000000000000") > currentReleaseId);
}
function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("更新地址必须使用 HTTPS");
  }
  return url;
}
function request(url, redirects = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = validateUrl(url);
    const req = (target.protocol === "https:" ? https : http).get(target, {
      headers: { "User-Agent": "VoxCPM-Studio-Updater/1.0", ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error("更新下载重定向异常"));
        request(new URL(res.headers.location, target).href, redirects + 1, headers).then(resolve, reject);
      } else if (![200, 206].includes(res.statusCode)) {
        res.resume(); reject(new Error(`更新服务器返回 HTTP ${res.statusCode}`));
      } else resolve(res);
    });
    req.setTimeout(30_000, () => req.destroy(new Error("更新服务器连接超时，请稍后重试")));
    req.on("error", reject);
  });
}
async function readJson(url) {
  const res = await request(url), chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) { res.destroy(); throw new Error("更新清单超出大小限制"); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function verifyEnvelope(envelope, publicKey, currentVersion) {
  if (!/^[0-9a-f]{64}$/i.test(publicKey) || !/^[0-9a-f]{128}$/i.test(envelope.signature || "")) {
    throw new Error("更新签名或发布公钥无效");
  }
  const key = crypto.createPublicKey({ key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "hex"),
  ]), format: "der", type: "spki" });
  if (typeof envelope.payload !== "string" || !crypto.verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, "hex"))) {
    throw new Error("更新签名校验失败，已拒绝此更新");
  }
  const manifest = JSON.parse(envelope.payload);
  if (manifest.protocol !== 1 || manifest.product !== "voxcpm-studio" || manifest.platform !== "win32-x64") {
    throw new Error("更新包与当前软件或平台不兼容");
  }
  versionParts(manifest.version);
  if (manifest.releaseId !== undefined && !/^\d{14}$/.test(manifest.releaseId)) throw new Error("发布序号无效");
  if (compareVersions(currentVersion, manifest.minVersion) < 0) throw new Error("当前版本需要先安装新的完整便携包");
  if (!/^[0-9a-f]{64}$/i.test(manifest.package?.sha256 || "") ||
      !Number.isSafeInteger(manifest.package.size) || manifest.package.size <= 0 || manifest.package.size > 1024 ** 3) {
    throw new Error("更新包大小或校验信息无效");
  }
  validateUrl(manifest.package.url);
  return manifest;
}
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
}

async function prepareUpdater(session, manifest, python) {
  for (const [relative, name] of [["resources/app/updater.py", "updater.py"], ["resources/app/standalone-updater.exe", "VoxCPM Updater.exe"]]) {
    const record = manifest.files?.find((file) => file.path === relative);
    if (!record || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > 2 * 1024 * 1024 ||
        !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error("签名清单缺少有效更新器，请联系发布者");
    // 仅用本机 Python 标准库读取 ZIP 字节；通过签名清单哈希后才允许执行。
    const { stdout } = await promisify(execFile)(python, ["-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); e=z.getinfo(sys.argv[3]); assert e.file_size==int(sys.argv[2]); sys.stdout.buffer.write(z.read(e))",
      path.join(session, "package.zip"), String(record.size), relative],
      { encoding: "buffer", maxBuffer: 2 * 1024 * 1024, timeout: 30000, windowsHide: true });
    if (stdout.length !== record.size || crypto.createHash("sha256").update(stdout).digest("hex") !== record.sha256) {
      throw new Error("新版更新器哈希校验失败");
    }
    fs.writeFileSync(path.join(session, name), stdout);
  }
}

class UpdateService {
  constructor({ root, dataRoot, appDir, currentVersion, pythonExecutable, getTheme = () => "light", onState = () => {}, config }) {
    this.root = root; this.dataRoot = dataRoot; this.appDir = appDir;
    this.currentVersion = currentVersion; this.onState = onState;
    this.getTheme = getTheme;
    this.python = pythonExecutable || resolveManagedPython(root) || path.join(root, "runtime", "python", "python.exe");
    this.config = config || JSON.parse(fs.readFileSync(path.join(appDir, "update-config.json"), "utf8"));
    this.cache = path.join(dataRoot, "cache", "updates");
    this.settingsPath = path.join(dataRoot, "config", "update-settings.json");
    let lastResult;
    try { lastResult = JSON.parse(fs.readFileSync(path.join(this.cache, "last-result.json"), "utf8")); } catch { /* 首次使用没有记录。 */ }
    this.state = { status: "idle", currentVersion, currentReleaseId: this.config.releaseId || "00000000000000", progress: 0, message: "尚未检查更新", autoCheck: this.getAutoCheck(), lastResult };
    this.running = false;
  }
  getAutoCheck() {
    try { return JSON.parse(fs.readFileSync(this.settingsPath, "utf8")).autoCheck !== false; }
    catch { return this.config.autoCheck !== false; }
  }
  setAutoCheck(enabled) {
    atomicJson(this.settingsPath, { autoCheck: Boolean(enabled) });
    return this.setState({ autoCheck: Boolean(enabled) });
  }
  setState(patch) { Object.assign(this.state, patch); this.onState({ ...this.state }); return { ...this.state }; }
  getState() {
    try { this.state.lastResult = JSON.parse(fs.readFileSync(path.join(this.cache, "last-result.json"), "utf8")); } catch { /* 无更新记录。 */ }
    return { ...this.state };
  }
  async check({ source = "manual" } = {}) {
    if (this.running || ["downloaded", "installing"].includes(this.state.status)) return this.state;
    this.running = true;
    this.setState({ status: "checking", checkSource: source, message: "正在检查新版本…", progress: 0 });
    try {
      const envelope = await readJson(this.config.manifestUrl);
      const manifest = verifyEnvelope(envelope, this.config.publicKey, this.currentVersion);
      this.envelope = envelope; this.manifest = manifest;
      const available = isNewer(manifest, this.currentVersion, this.state.currentReleaseId);
      this.session = null;
      return this.setState({ status: available ? "available" : "current", latestVersion: manifest.version, latestReleaseId: manifest.releaseId,
        canDownload: available,
        notes: manifest.notes, publishedAt: manifest.publishedAt, size: manifest.package.size,
        message: available ? `发现新版本 ${manifest.version}` : "当前已是最新版本" });
    } catch (error) {
      this.envelope = null; this.manifest = null;
      return this.setState({ status: "error", canDownload: false, latestVersion: undefined, notes: undefined, message: String(error.message || error) });
    } finally { this.running = false; }
  }
  async download() {
    if (this.running) return this.state;
    if (!this.manifest || !isNewer(this.manifest, this.currentVersion, this.state.currentReleaseId)) throw new Error("请先检查更新");
    this.running = true;
    this.setState({ status: "downloading", progress: 0, message: "正在下载更新包…" });
    const meta = this.manifest.package;
    try {
      fs.mkdirSync(this.cache, { recursive: true });
      const part = path.join(this.cache, meta.sha256 + ".part");
      let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (offset > meta.size) { fs.unlinkSync(part); offset = 0; }
      if (offset < meta.size) {
        const res = await request(meta.url, 0, offset ? { Range: `bytes=${offset}-` } : {});
        if (res.statusCode === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers["content-range"] || "");
          if (!range || Number(range[1]) !== offset || Number(range[3]) !== meta.size) {
            res.destroy(); throw new Error("更新服务器断点续传响应无效");
          }
        } else offset = 0;
        let received = offset, lastProgress = -1;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > meta.size) res.destroy(new Error("更新包超过清单声明大小"));
          const progress = Math.floor(received * 100 / meta.size);
          if (progress !== lastProgress) { lastProgress = progress; this.setState({ progress, message: `正在下载更新包 ${progress}%` }); }
        });
        await pipeline(res, fs.createWriteStream(part, { flags: offset ? "a" : "w" }));
      }
      if (fs.statSync(part).size !== meta.size || (await digest(part)) !== meta.sha256) {
        fs.unlinkSync(part); throw new Error("更新包 SHA-256 或大小校验失败，请重新下载");
      }
      const session = path.join(this.cache, "session-" + crypto.randomUUID());
      fs.mkdirSync(session);
      fs.copyFileSync(part, path.join(session, "package.zip"));
      atomicJson(path.join(session, "envelope.json"), this.envelope);
      await prepareUpdater(session, this.manifest, this.python);
      atomicJson(path.join(session, "session.json"), { root: this.root, publicKey: this.config.publicKey,
        currentVersion: this.currentVersion, currentReleaseId: this.state.currentReleaseId,
        parentPid: process.pid, session, pythonExecutable: this.python, theme: this.getTheme(), resultPath: path.join(this.cache, "last-result.json"),
        executable: path.join(this.root, "VoxCPM Studio.exe") });
      this.session = session;
      return this.setState({ status: "downloaded", progress: 100, message: "更新包已校验，准备重启安装" });
    } catch (error) {
      return this.setState({ status: "error", message: String(error.message || error) });
    } finally { this.running = false; }
  }
  async launch() {
    if (this.state.status !== "downloaded" || !this.session) throw new Error("尚无已校验的更新包");
    if (!fs.existsSync(path.join(this.root, "runtime_manifest.json"))) throw new Error("开发环境不支持安装，请使用便携版测试更新");
    this.setState({ status: "installing", message: "正在校验更新器，完成后自动重启…" });
    const session = this.session;
    try {
    const settings = JSON.parse(fs.readFileSync(path.join(session, "session.json"), "utf8"));
    const target = JSON.parse(JSON.parse(fs.readFileSync(path.join(session, "envelope.json"), "utf8")).payload);
    for (const name of ["ready.json", "host-ready.json", "cancel.json", "status.json"]) fs.rmSync(path.join(session, name), { force: true });
    const child = spawn(path.join(session, "VoxCPM Updater.exe"), ["--session", session], {
      detached: true, stdio: "ignore", windowsHide: false, cwd: session,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    let exited = false;
    child.once("exit", () => { exited = true; });
    child.unref();
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const statusFile = path.join(session, "status.json");
      if (fs.existsSync(statusFile)) {
        const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (status.status === "error") throw new Error(status.message);
      }
      if (exited) throw new Error("独立更新器提前退出，请查看更新日志");
      const readyFile = path.join(session, "ready.json");
      const hostFile = path.join(session, "host-ready.json");
      if (fs.existsSync(readyFile) && fs.existsSync(hostFile)) {
        const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
        const host = JSON.parse(fs.readFileSync(hostFile, "utf8"));
        if (ready.session === session && ready.parentPid === settings.parentPid && ready.releaseId === target.releaseId &&
            host.session === session && host.hostPid === child.pid && host.workerPid === ready.pid && host.independent === true) {
          this.setState({ status: "installing", message: "更新器校验通过，正在退出并安装…" });
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("更新器准备超时，已取消安装，当前软件保持运行");
    } catch (error) {
      atomicJson(path.join(session, "cancel.json"), { cancelledAt: Date.now() });
      this.setState({ status: "error", canDownload: true, message: `更新尚未安装：${error.message}。可重新下载后重试。` });
      throw error;
    }
  }
}
module.exports = { UpdateService, compareVersions, isNewer, verifyEnvelope, digest, request, atomicJson, prepareUpdater };
