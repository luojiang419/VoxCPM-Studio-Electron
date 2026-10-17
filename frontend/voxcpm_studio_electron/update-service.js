const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
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

class UpdateService {
  constructor({ root, dataRoot, appDir, currentVersion, onState = () => {}, config }) {
    this.root = root; this.dataRoot = dataRoot; this.appDir = appDir;
    this.currentVersion = currentVersion; this.onState = onState;
    this.config = config || JSON.parse(fs.readFileSync(path.join(appDir, "update-config.json"), "utf8"));
    this.cache = path.join(dataRoot, "cache", "updates");
    this.settingsPath = path.join(dataRoot, "config", "update-settings.json");
    this.state = { status: "idle", currentVersion, currentReleaseId: this.config.releaseId || "00000000000000", progress: 0, message: "尚未检查更新", autoCheck: this.getAutoCheck() };
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
  async check() {
    if (this.running) return this.state;
    this.running = true;
    this.setState({ status: "checking", message: "正在检查新版本…", progress: 0 });
    try {
      const envelope = await readJson(this.config.manifestUrl);
      const manifest = verifyEnvelope(envelope, this.config.publicKey, this.currentVersion);
      this.envelope = envelope; this.manifest = manifest;
      const available = isNewer(manifest, this.currentVersion, this.state.currentReleaseId);
      this.session = null;
      return this.setState({ status: available ? "available" : "current", latestVersion: manifest.version,
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
      fs.copyFileSync(path.join(this.appDir, "updater.py"), path.join(session, "updater.py"));
      atomicJson(path.join(session, "session.json"), { root: this.root, publicKey: this.config.publicKey,
        currentVersion: this.currentVersion, currentReleaseId: this.state.currentReleaseId,
        parentPid: process.pid, session, executable: path.join(this.root, "VoxCPM Studio.exe") });
      this.session = session;
      return this.setState({ status: "downloaded", progress: 100, message: "更新包已校验，准备重启安装" });
    } catch (error) {
      return this.setState({ status: "error", message: String(error.message || error) });
    } finally { this.running = false; }
  }
  async launch() {
    if (this.state.status !== "downloaded" || !this.session) throw new Error("尚无已校验的更新包");
    if (!fs.existsSync(path.join(this.root, "runtime_manifest.json"))) throw new Error("开发环境不支持安装，请使用便携版测试更新");
    const child = spawn(path.join(this.root, "VoxCPM Studio.exe"), ["--voxcpm-updater", this.session], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    this.setState({ status: "installing", message: "正在启动独立更新器…" });
  }
}
module.exports = { UpdateService, compareVersions, isNewer, verifyEnvelope, digest, request, atomicJson };
