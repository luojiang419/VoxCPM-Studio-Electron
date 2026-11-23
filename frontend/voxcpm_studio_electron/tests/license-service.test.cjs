const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { LicenseService, verifyLicense, hashMacs } = require("../license-service");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jvox-license-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const config = {
    enabled: true,
    serverUrl: "http://127.0.0.1:4102",
    appId: "jvox-studio",
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex"),
  };
  fs.writeFileSync(
    path.join(dir, "license-config.json"),
    JSON.stringify(config),
  );
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  let response;
  const service = new LicenseService({
    appDir: dir,
    dataRoot: dir,
    safeStorage,
    bridgeSecret: "secret",
    fetchImpl: async () => ({ ok: true, json: async () => response }),
  });
  const sign = (overrides = {}) => {
    const payload = JSON.stringify({
      schema: 1,
      issuer: config.serverUrl,
      appId: config.appId,
      deviceId: service.deviceId,
      userId: "user",
      username: "test",
      name: "测试",
      kind: "trial",
      issuedAt: Date.now() / 1000,
      trialExpiresAt: Date.now() / 1000 + 30 * 86400,
      leaseUntil: Date.now() / 1000 + 72 * 3600,
      active: true,
      ...overrides,
    });
    return {
      payload,
      signature: crypto
        .sign(null, Buffer.from(payload), privateKey)
        .toString("hex"),
    };
  };
  return { service, sign, config, dir, respond: (v) => (response = v) };
}

test("配置中的enabled=false不能关闭生产授权", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.dir, "license-config.json"),
    JSON.stringify({ ...f.config, enabled: false }),
  );
  const s = new LicenseService({
    appDir: f.dir,
    dataRoot: f.dir,
    bridgeSecret: "secret",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    },
  });
  assert.equal(s.state().enabled, true);
  assert.equal(s.state().allowed, false);
});
test("签名验真、软件及设备隔离，伪造授权被拒绝", (t) => {
  const f = fixture(t);
  assert.equal(
    verifyLicense(f.sign(), f.config, f.service.deviceId).kind,
    "trial",
  );
  assert.throws(
    () =>
      verifyLicense(f.sign({ appId: "other" }), f.config, f.service.deviceId),
    /不适用/,
  );
  assert.throws(
    () =>
      verifyLicense(
        f.sign({ deviceId: "other" }),
        f.config,
        f.service.deviceId,
      ),
    /不适用/,
  );
  const tampered = f.sign();
  tampered.payload = tampered.payload.replace("trial", "permanent");
  assert.throws(
    () => verifyLicense(tampered, f.config, f.service.deviceId),
    /签名/,
  );
});
test("有效试用、离线租约过期、试用到期、停用、永久状态准确", (t) => {
  const { service: s, sign } = fixture(t);
  for (const [overrides, expected] of [
    [{}, "trial"],
    [{ leaseUntil: Date.now() / 1000 - 1 }, "verification-required"],
    [{ trialExpiresAt: Date.now() / 1000 - 1 }, "expired"],
    [{ active: false }, "suspended"],
    [
      { kind: "permanent", trialExpiresAt: null, leaseUntil: null },
      "permanent",
    ],
  ]) {
    s.accept({
      license: sign(overrides),
      token: "test-token",
      server_time: Date.now() / 1000,
    });
    assert.equal(s.state().status, expected);
    assert.equal(s.state().edition, expected === "permanent" ? "full" : "trial");
    assert.equal(s.state().displayName, expected === "permanent" ? "JVOX Studio正式版" : "JVOX Studio试用版");
  }
});

test("网卡指纹统一格式、过滤无效地址、去重并按软件隔离", () => {
  const values = ["10:AB:CD:EF:12:34", "10-ab-cd-ef-12-34", "00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "invalid"];
  const hashes = hashMacs(values, "jvox-studio");
  assert.equal(hashes.length, 1);
  assert.match(hashes[0], /^[a-f0-9]{64}$/);
  assert.notDeepEqual(hashes, hashMacs(values, "second-app"));
});
test("退出登录立即清除本机会话及后端授权，即使服务器离线", async (t) => {
  const { service: s, sign, dir } = fixture(t);
  s.accept({
    license: sign(),
    token: "secret-token",
    server_time: Date.now() / 1000,
  });
  s.fetch = async () => {
    throw Error("offline");
  };
  await s.logout();
  assert.equal(s.state().loggedIn, false);
  const bridge = JSON.parse(
    JSON.parse(fs.readFileSync(s.bridgePath, "utf8")).payload,
  );
  assert.equal(bridge.license, null);
  assert.equal(
    fs.existsSync(path.join(dir, "account/credentials.json")),
    false,
  );
});
test("普通试用无提醒，最后7天每日提醒仅一次", (t) => {
  const { service: s, sign } = fixture(t);
  s.accept({ license: sign(), token: "t", server_time: Date.now() / 1000 });
  assert.equal(s.reminder(), false);
  s.accept({
    license: sign({ trialExpiresAt: Date.now() / 1000 + 6 * 86400 }),
    token: "t",
    server_time: Date.now() / 1000,
  });
  assert.equal(s.reminder(), true);
  assert.equal(s.reminder(), false);
});
test("服务端401清除缓存，网络故障保留有效离线授权", async (t) => {
  const { service: s, sign } = fixture(t);
  s.accept({ license: sign(), token: "t", server_time: Date.now() / 1000 });
  s.fetch = async () => {
    throw Error("offline");
  };
  await s.refresh();
  assert.equal(s.state().allowed, true);
  s.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ detail: "失效" }),
  });
  await s.refresh();
  assert.equal(s.state().loggedIn, false);
});

test("退出再登录不会重复弹出同日试用提醒", async (t) => {
  const { service: s, sign } = fixture(t);
  const certificate = sign({ trialExpiresAt: Date.now() / 1000 + 6 * 86400 });
  s.accept({
    license: certificate,
    token: "test-token",
    server_time: Date.now() / 1000,
  });
  assert.equal(s.reminder(), true);
  s.fetch = async () => {
    throw Error("offline");
  };
  await s.logout();
  s.accept({
    license: certificate,
    token: "new-token",
    server_time: Date.now() / 1000,
  });
  assert.equal(s.reminder(), false);
});
