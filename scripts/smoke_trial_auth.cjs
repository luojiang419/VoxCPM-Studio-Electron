/* 真实公网认证 -> 实际Electron IPC -> 本地Python门禁。只读复用安装模型。 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const target = path.join(ROOT, "builds", "trial-auth-validation");
fs.mkdirSync(target, { recursive: true });
const privateFile = path.join(ROOT, ".auth-private", "smoke-account.json");
// 每轮仅重置本验收隔离目录的提醒收据，不触碰正式软件账户或作品。
fs.rmSync(path.join(target, "data/account/trial-reminders.json"), { force: true });
const origin = "https://admin.ee2x.cn";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const x = await fn();
      if (x) return x;
    } catch (e) {
      last = e;
    }
    await delay(250);
  }
  throw Error("等待失败：" + (last?.message || "超时"));
}
async function api(route, body, token) {
  const res = await fetch(origin + "/api/v1" + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw Error("HTTP " + res.status + ": " + JSON.stringify(data));
  return data;
}
async function cdp(port) {
  const page = await until(async () => {
    const p = await (
      await fetch("http://127.0.0.1:" + port + "/json/list")
    ).json();
    return p.find((x) => x.type === "page");
  });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const v = JSON.parse(data);
    if (v.id && pending.has(v.id)) {
      const { r, j } = pending.get(v.id);
      pending.delete(v.id);
      v.error ? j(Error(JSON.stringify(v.error))) : r(v.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const id = ++seq;
      pending.set(id, { r, j });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async eval(expression) {
      const v = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (v.exceptionDetails) throw Error(JSON.stringify(v.exceptionDetails));
      return v.result.value;
    },
    close: () => ws.close(),
  };
}
async function shot(client, name) {
  const v = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(target, name + ".png"),
    Buffer.from(v.data, "base64"),
  );
}
let child, client, adminToken, cloudState, account;
const report = {
  checks: [],
  started: new Date().toISOString(),
  production: origin,
};
function check(message) {
  report.checks.push(message);
  console.log(message);
}
(async () => {
  assert.ok(
    process.env.EE2X_ADMIN_PASSWORD,
    "须通过环境变量提供管理员验收凭据",
  );
  const admin = await api("/admin/auth/login", {
    username: "luo",
    password: process.env.EE2X_ADMIN_PASSWORD,
  });
  adminToken = admin.token;
  assert.equal((await fetch(origin + "/api/v1/admin/state")).status, 401);
  check("公网HTTPS有效，未登录管理接口返回401");
  const cloudKey = await api("/public-key");
  assert.equal(
    cloudKey.public_key,
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "frontend/voxcpm_studio_electron/license-config.json"),
      ),
    ).publicKey,
  );
  check("公网授权公钥与桌面信任公钥一致");
  if (fs.existsSync(privateFile))
    account = JSON.parse(fs.readFileSync(privateFile, "utf8"));
  else {
    account = {
      username: "qa_" + crypto.randomBytes(4).toString("hex"),
      password: crypto.randomBytes(18).toString("base64url"),
    };
    fs.writeFileSync(privateFile, JSON.stringify(account), { mode: 0o600 });
  }
  if (account.userId) {
    const s = await api("/admin/state", null, adminToken);
    const l = s.licenses.find(
      (x) => x.user_id === account.userId && x.app_id === "jvox-studio",
    );
    if (l?.kind === "trial")
      await api(
        "/admin/entitlements/" + l.id + "/trial-expiry",
        {
          revision: l.revision,
          request_id: crypto.randomUUID(),
          reason: "自动化验收：还原正常试用期限",
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        },
        adminToken,
      );
  }
  const appRoot =
    process.env.VOXCPM_TRIAL_PACKAGE ||
    path.join(ROOT, "frontend/voxcpm_studio_electron");
  const executable = process.env.VOXCPM_TRIAL_PACKAGE
    ? path.join(appRoot, "JVOX Studio配音系统.exe")
    : path.join(appRoot, "node_modules/electron/dist/electron.exe");
  const env = {
    ...process.env,
    VOXCPM_DATA_ROOT: path.join(target, "data"),
    VOXCPM_APP_ROOT: process.env.VOXCPM_TRIAL_PACKAGE
      ? path.join(appRoot, "app")
      : path.join(ROOT, "scripts/dev_backend"),
    ELECTRON_RUN_AS_NODE: "",
  };
  delete env.EE2X_ADMIN_PASSWORD;
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    executable,
    [
      ...(process.env.VOXCPM_TRIAL_PACKAGE ? [] : ["."]),
      "--remote-debugging-port=19341",
    ],
    { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = fs.createWriteStream(path.join(target, "electron.log"), {
    flags: "a",
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  client = await cdp(19341);
  await until(() =>
    client.eval(
      "Boolean(window.voxcpmDesktop?.getLicenseState && document.querySelector('.jvox-account-dialog'))",
    ),
  );
  const boot = await until(async () => {
    const b = await client.eval("window.voxcpmDesktop.getBootstrapState()");
    if (b.status === "error") throw Error(b.detail);
    return b.backendRunning && b.status === "ready" && b;
  }, 180000);
  report.backend = boot.backendBaseUrl;
  check("实际Electron与本地Python启动成功，模型复用正式安装且不下载");
  const initial = await client.eval("window.voxcpmDesktop.getLicenseState()");
  if (initial.loggedIn) await client.eval("window.voxcpmDesktop.logout()");
  assert.equal(
    (
      await fetch(boot.backendBaseUrl + "/api/asr/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioPath: "missing.wav" }),
      })
    ).status,
    403,
  );
  check("未登录直接调用Python推理接口被拒绝");
  await client.eval("document.querySelector('.jvox-account-entry').click()");
  await until(() => client.eval("Boolean(document.querySelector('.jvox-auth-tabs'))"));
  await shot(client, "desktop-login");
  await client.eval(
    "Array.from(document.querySelectorAll('.jvox-auth-tabs button')).find(x=>x.textContent==='注册').click()",
  );
  await shot(client, "desktop-register");
  let result = await client.eval(
    `window.voxcpmDesktop.authenticate('login',${JSON.stringify(account)})`,
  );
  if (result.error) {
    result = await client.eval(
      `window.voxcpmDesktop.authenticate('register',${JSON.stringify({ ...account, name: "授权验收账户" })})`,
    );
    assert.ok(!result.error, result.error);
    check("桌面通过真实公网服务注册，自动创建自然月试用");
  }
  assert.equal(result.state.status, "trial");
  account.userId = result.state.user.id;
  fs.writeFileSync(privateFile, JSON.stringify(account), { mode: 0o600 });
  assert.ok(result.state.expiresAt - result.state.serverTime >= 27 * 86400);
  check("真实签名试用通过主进程验证，账号状态不依赖localStorage");
  await client.eval("document.querySelector('.jvox-account-entry').click()");
  await shot(client, "desktop-account");
  const authed = await fetch(
    boot.backendBaseUrl + "/api/tasks/generate-single",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(authed.status, 422);
  check("授权后Python门禁放行至业务校验");
  async function current() {
    cloudState = await api("/admin/state", null, adminToken);
    return cloudState.licenses.find(
      (l) => l.user_id === account.userId && l.app_id === "jvox-studio",
    );
  }
  async function change(action, extras) {
    const l = await current();
    await api(
      "/admin/entitlements/" + l.id + "/" + action,
      {
        revision: l.revision,
        request_id: crypto.randomUUID(),
        reason: "自动化验收：" + action,
        ...extras,
      },
      adminToken,
    );
  }
  await change("trial-expiry", {
    expires_at: new Date(Date.now() + 5 * 86400000).toISOString(),
  });
  let refreshed = await client.eval("window.voxcpmDesktop.refreshLicense()");
  assert.equal(refreshed.status, "trial");
  assert.ok(refreshed.expiresAt - refreshed.serverTime < 6 * 86400);
  await until(() =>
    client.eval(
      "document.querySelector('.jvox-account-dialog')?.innerText.includes('你的试用将在')",
    ),
  );
  assert.equal(
    await client.eval("window.voxcpmDesktop.shouldRemindTrial()"),
    false,
  );
  await shot(client, "desktop-reminder");
  await client.eval(
    "Array.from(document.querySelectorAll('.jvox-account-dialog button')).find(x=>x.textContent==='知道了，继续创作').click()",
  );
  check("云端缩短期限同步倒计时，最后一周自动提醒且每日去重");
  await current();
  await change("trial-expiry", {
    expires_at: new Date(cloudState.server_time * 1000).toISOString(),
  });
  refreshed = await client.eval("window.voxcpmDesktop.refreshLicense()");
  assert.equal(refreshed.status, "expired");
  assert.equal(
    (
      await fetch(boot.backendBaseUrl + "/api/music/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  check("云端结束试用后，本地任务接口被拒绝");
  await shot(client, "desktop-expired");
  await change("trial-expiry", {
    expires_at: new Date(Date.now() + 10 * 86400000).toISOString(),
  });
  assert.equal(
    (await client.eval("window.voxcpmDesktop.refreshLicense()")).status,
    "trial",
  );
  check("已到期用户可恢复试用");
  await change("grant-permanent", { received: true });
  await client.eval("localStorage.setItem('qa.edition.preserve','保留我的设置')");
  const sentinel = path.join(target, "data/outputs/正式版转换验收.txt");
  fs.mkdirSync(path.dirname(sentinel), {recursive: true});
  fs.writeFileSync(sentinel, "保留我的作品");
  await until(async () => (await client.eval("window.voxcpmDesktop.getLicenseState()")).status === "permanent", 80000);
  await until(() => client.eval("document.title === 'JVOX Studio正式版' && document.body.innerText.includes('正式版 · 永久授权')"));
  assert.equal(await client.eval("localStorage.getItem('qa.edition.preserve')"), "保留我的设置");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "保留我的作品");
  await shot(client, "desktop-permanent");
  check("作者开通永久权限后，无需点击刷新，80秒内自动转正式版；窗口页面标题、账户标识同步且配置作品保留");
  const state = await api('/admin/state', null, adminToken);
  const claim = state.trial_claims.find(c => c.user_id === account.userId && c.app_id === 'jvox-studio' && !c.released);
  assert.ok(claim, "云端应记录此次试用IP与MAC指纹");
  for (const [proof, keyword] of [[JSON.parse(claim.mac_hashes), '网卡'], [[crypto.randomBytes(32).toString('hex')], 'IP']]) {
    const r = await fetch(origin + '/api/v1/auth/register', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.200'},
      body: JSON.stringify({username: 'qa_denied_' + crypto.randomBytes(3).toString('hex'), password: crypto.randomBytes(18).toString('hex'), app_id:'jvox-studio', device_id:crypto.randomBytes(32).toString('hex'), mac_hashes:proof})});
    assert.equal(r.status, 409);
    assert.ok((await r.json()).detail.includes(keyword));
  }
  check("公网真实IP名额和同MAC重复注册均被409拒绝，伪造转发头无效");
  await client.eval(
    "Array.from(document.querySelectorAll('.jvox-account-dialog button')).find(x=>x.textContent==='退出登录').click()",
  );
  await until(
    async () =>
      !(await client.eval("window.voxcpmDesktop.getLicenseState()")).loggedIn,
  );
  assert.equal(
    (
      await fetch(boot.backendBaseUrl + "/api/music/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  await shot(client, "desktop-logged-out");
  assert.equal(await client.eval("document.title"), "JVOX Studio试用版");
  check("点击退出登录清除本机凭据，Python接口再次拒绝新增任务");
  assert.equal(
    (await fetch(boot.backendBaseUrl + "/api/workspace/works")).status,
    200,
  );
  check("退出后已有作品列表仍可读取");
  const update = await client.eval("window.voxcpmDesktop.checkUpdate()");
  assert.equal(update.status, "current");
  check("试用版拒绝进入旧无授权正式更新通道");
  // 验收账号保留审计但停用，不向用户分发其凭据。
  await change("suspend", {});
  report.passed = true;
})()
  .catch((e) => {
    report.passed = false;
    report.error = e.stack;
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.writeFileSync(
      path.join(target, "report.json"),
      JSON.stringify(report, null, 2),
    );
    if (client) {
      try {
        await client.eval("window.voxcpmDesktop.stopBackend()");
      } catch {}
      client.close();
    }
    if (child && !child.killed) child.kill();
    if (adminToken)
      try {
        await api("/auth/logout", {}, adminToken);
      } catch {}
  });
