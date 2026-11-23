"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
function verifyLicense(envelope, config, deviceId) {
  if (
    !/^[a-f0-9]{64}$/.test(config.publicKey || "") ||
    !/^[a-f0-9]{128}$/.test(envelope?.signature || "") ||
    typeof envelope.payload !== "string"
  )
    throw Error("授权签名格式无效");
  const key = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(config.publicKey, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !crypto.verify(
      null,
      Buffer.from(envelope.payload),
      key,
      Buffer.from(envelope.signature, "hex"),
    )
  )
    throw Error("授权签名验证失败");
  const p = JSON.parse(envelope.payload);
  if (
    p.schema !== 1 ||
    p.issuer !== config.serverUrl ||
    p.appId !== config.appId ||
    p.deviceId !== deviceId ||
    !["trial", "permanent"].includes(p.kind) ||
    !Number.isFinite(p.issuedAt) ||
    typeof p.active !== "boolean"
  )
    throw Error("授权不适用于此软件或设备");
  if (
    p.kind === "trial" &&
    (!Number.isFinite(p.trialExpiresAt) || !Number.isFinite(p.leaseUntil))
  )
    throw Error("试用期限无效");
  return p;
}
function machineId() {
  let source = os.hostname();
  if (process.platform === "win32")
    try {
      source = execFileSync(
        "reg.exe",
        [
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
          "/v",
          "MachineGuid",
        ],
        { encoding: "utf8", windowsHide: true },
      )
        .split("REG_SZ")
        .at(-1)
        .trim();
    } catch {
      /* 无注册表读取权限时使用主机标识。 */
    }
  return crypto
    .createHash("sha256")
    .update("ee2x-device-v1:" + source + ":" + os.platform())
    .digest("hex");
}
function hashMacs(addresses, appId) {
  return [...new Set(addresses.map((v) => String(v).replace(/[:-]/g, "").toLowerCase())
    .filter((v) => /^[a-f0-9]{12}$/.test(v) && v !== "000000000000" && !(parseInt(v.slice(0, 2), 16) & 1)))]
    .map((v) => crypto.createHash("sha256").update("ee2x-mac-v1:" + appId + ":" + v).digest("hex")).sort().slice(0, 16);
}
function macFingerprints(appId) {
  let addresses = [];
  if (process.platform === "win32") {
    try {
      // 读取物理网卡，包括断开的网卡；避免VPN/虚拟网卡或当前连接切换改变指纹集合。
      addresses = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter = True' | Where-Object MACAddress | Select-Object -ExpandProperty MACAddress)"],
        {encoding: "utf8", windowsHide: true, timeout: 10000}).trim());
    } catch { /* 系统查询失败时读取当前可见的非虚拟网卡。 */ }
  }
  if (!addresses.length) addresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/loopback|virtual|vmware|vethernet|vpn|tap|tun|docker|wsl/i.test(name))
    .flatMap(([, values]) => values.filter((v) => !v.internal).map((v) => v.mac));
  return hashMacs(addresses, appId);
}
class LicenseService {
  constructor({
    appDir,
    dataRoot,
    safeStorage,
    onState = () => {},
    bridgeSecret,
    fetchImpl = fetch,
    configPath,
  }) {
    this.configPath = configPath || path.join(appDir, "license-config.json");
    this.config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    this.config.enabled = true; // 授权不可通过编辑配置关闭。
    this.config.serverUrl = this.config.serverUrl.replace(/\/$/, "");
    const url = new URL(this.config.serverUrl);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )
    )
      throw Error("授权服务必须使用HTTPS");
    this.safeStorage = safeStorage;
    this.fetch = fetchImpl;
    this.onState = onState;
    this.bridgeSecret = bridgeSecret;
    this.directory = path.join(dataRoot, "account");
    this.file = path.join(this.directory, "credentials.json");
    this.bridgePath = path.join(this.directory, "license-session.json");
    this.deviceId = machineId();
    this.macHashes = macFingerprints(this.config.appId);
    this.record = {};
    this.lastError = "";
    this.busy = null;
    this.reminderFile = path.join(this.directory, "trial-reminders.json");
    this.reminders = [];
    if (fs.existsSync(this.reminderFile))
      try {
        this.reminders = JSON.parse(
          safeStorage.decryptString(
            Buffer.from(
              JSON.parse(fs.readFileSync(this.reminderFile, "utf8")).encrypted,
              "base64",
            ),
          ),
        );
      } catch {
        this.reminders = [];
      }
    if (this.config.enabled && fs.existsSync(this.file))
      try {
        this.record = JSON.parse(
          safeStorage.decryptString(
            Buffer.from(
              JSON.parse(fs.readFileSync(this.file, "utf8")).encrypted,
              "base64",
            ),
          ),
        );
        if (this.record.license)
          verifyLicense(this.record.license, this.config, this.deviceId);
      } catch {
        this.record = {};
        this.lastError = "本地登录信息无效，请重新登录";
      }
    this.anchor = performance.now();
    this.anchorServer = this.estimatedTime();
    this.writeBridge();
  }
  estimatedTime() {
    if (this.record.serverTime && this.record.savedWall) {
      if (Date.now() < this.record.savedWall - 300000)
        return Math.max(this.record.serverTime, Date.now() / 1000) + 315360000;
      return (
        this.record.serverTime +
        Math.max(0, (Date.now() - this.record.savedWall) / 1000)
      );
    }
    return Date.now() / 1000;
  }
  now() {
    return this.anchorServer + (performance.now() - this.anchor) / 1000;
  }
  save() {
    if (!this.safeStorage.isEncryptionAvailable())
      throw Error("Windows凭据保护不可用，无法保存登录信息");
    atomic(this.file, {
      encrypted: this.safeStorage
        .encryptString(JSON.stringify(this.record))
        .toString("base64"),
    });
    this.writeBridge();
    this.onState(this.state());
  }
  writeBridge() {
    const payload = JSON.stringify({
      license: this.record.license || null,
      deviceId: this.deviceId,
      serverTime: this.now?.() || Date.now() / 1000,
      wallTime: Date.now() / 1000,
    });
    atomic(this.bridgePath, {
      payload,
      mac: crypto
        .createHmac("sha256", this.bridgeSecret)
        .update(payload)
        .digest("hex"),
    });
  }
  state() {
    if (!this.config.enabled) return { enabled: false };
    let p;
    try {
      if (this.record.license)
        p = verifyLicense(this.record.license, this.config, this.deviceId);
    } catch (e) {
      this.lastError = e.message;
    }
    const now = this.now();
    let status = !p
      ? "logged-out"
      : !p.active
        ? "suspended"
        : p.kind === "permanent"
          ? "permanent"
          : now >= p.trialExpiresAt
            ? "expired"
            : now >= p.leaseUntil
              ? "verification-required"
              : "trial";
    if (this.record.savedWall && Date.now() < this.record.savedWall - 300000)
      status = "verification-required";
    return {
      enabled: true,
      status,
      edition: status === "permanent" ? "full" : "trial",
      displayName: status === "permanent" ? "JVOX Studio正式版" : "JVOX Studio试用版",
      loggedIn: !!p,
      allowed: ["permanent", "trial"].includes(status),
      user: p ? { id: p.userId, name: p.name, username: p.username } : null,
      appId: this.config.appId,
      serverTime: now,
      expiresAt: p?.trialExpiresAt || null,
      leaseUntil: p?.leaseUntil || null,
      contact: p?.contact || "",
      purchaseNote: p?.purchaseNote || "",
      error: this.lastError,
    };
  }
  async request(route, body, token) {
    const response = await this.fetch(
      this.config.serverUrl + "/api/v1" + route,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    const result = await response.json();
    if (!response.ok) {
      const error = Error(
        typeof result.detail === "string" ? result.detail : "认证服务请求失败",
      );
      error.status = response.status;
      throw error;
    }
    return result;
  }
  accept(result) {
    if (result.license)
      verifyLicense(result.license, this.config, this.deviceId);
    this.record = {
      ...this.record,
      ...(result.token ? { token: result.token } : {}),
      ...(result.license ? { license: result.license } : {}),
      serverTime: result.server_time,
      savedWall: Date.now(),
    };
    this.anchorServer = result.server_time;
    this.anchor = performance.now();
    this.lastError = "";
    this.save();
    return this.state();
  }
  async authenticate(mode, body) {
    if (!["login", "register"].includes(mode)) throw Error("认证操作无效");
    if (this.busy) throw Error("正在处理登录请求，请稍候");
    this.busy = (async () => {
      try {
        const result = await this.request("/auth/" + mode, {
          username: body.username,
          password: body.password,
          name: body.name || "",
          email: body.email || "",
          app_id: this.config.appId,
          device_id: this.deviceId,
          mac_hashes: this.macHashes,
        });
        return this.accept(result);
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }
  async refresh() {
    if (!this.config.enabled || !this.record.token) return this.state();
    if (this.busy) return this.busy;
    this.busy = (async () => {
      try {
        const rotated = await this.request(
          "/auth/refresh",
          {},
          this.record.token,
        );
        // 轮换立即落盘，随后请求失败不会继续使用已撤销的旧token。
        this.record.token = rotated.token;
        this.save();
        return this.accept(
          await this.request("/licenses/refresh", {}, this.record.token),
        );
      } catch (e) {
        this.lastError = e.message;
        if ([401, 403].includes(e.status)) {
          this.record = {};
          this.save();
        } else {
          this.writeBridge();
          this.onState(this.state());
        }
        return this.state();
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }
  async logout() {
    if (this.busy) await this.busy;
    const token = this.record.token;
    this.record = {};
    this.lastError = "";
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    this.writeBridge();
    this.onState(this.state());
    if (token)
      try {
        await this.request("/auth/logout", {}, token);
      } catch {
        /* 本机凭据和授权已清除，离线也可退出。 */
      }
    return this.state();
  }
  reminder() {
    const s = this.state();
    if (s.status !== "trial" || s.expiresAt - s.serverTime > 7 * 86400)
      return false;
    const day = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
    }).format(new Date(s.serverTime * 1000));
    const id = s.user.id + ":" + s.appId + ":" + day;
    if (this.record.reminder === id || this.reminders.includes(id))
      return false;
    this.reminders = [...this.reminders.slice(-59), id];
    atomic(this.reminderFile, {
      encrypted: this.safeStorage
        .encryptString(JSON.stringify(this.reminders))
        .toString("base64"),
    });
    return true;
  }
}
module.exports = { LicenseService, verifyLicense, machineId, hashMacs };
