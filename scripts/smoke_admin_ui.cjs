/* 用隔离的Electron网页运行环境验收真实管理端，不使用用户浏览器会话。 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "..");
const out = path.join(ROOT, "builds/admin-auth-validation");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile"));
const report = { checks: [], console: [] };
let win;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(200);
  }
  throw Error("界面等待超时");
}
async function run(js) {
  return win.webContents.executeJavaScript(js, true);
}
async function shot(name) {
  fs.writeFileSync(
    path.join(out, name + ".png"),
    (await win.webContents.capturePage()).toPNG(),
  );
}
app.whenReady().then(async () => {
  try {
    assert.ok(process.env.EE2X_ADMIN_PASSWORD, "缺少验收凭据");
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1060,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) report.console.push(message);
    });
    await win.webContents.session.clearStorageData({storages: ["cookies", "localstorage"]});
    await win.loadURL("https://admin.ee2x.cn/admin/login");
    await until(() => run('Boolean(document.querySelector("#login"))'));
    await shot("admin-login");
    await run(
      `document.querySelector('[name=username]').value='luo';document.querySelector('[name=password]').value=${JSON.stringify(process.env.EE2X_ADMIN_PASSWORD)};document.querySelector('#login').requestSubmit();`,
    );
    await until(() => run('Boolean(document.querySelector(".layout"))'));
    await shot("admin-users");
    report.checks.push("真实HTTPS管理员登录成功、用户授权页渲染");
    if (await run('Boolean(document.querySelector("#adjust"))')) {
      await run("document.querySelector('#adjust').click()");
      await until(() => run('Boolean(document.querySelector("dialog[open]"))'));
      const previous = await run(
        "document.querySelector('dialog [name=expiry]').value",
      );
      const future = new Date(Date.now() + 9 * 86400000 + 8 * 3600000)
        .toISOString()
        .slice(0, 16);
      await run(
        `document.querySelector('dialog [name=expiry]').value=${JSON.stringify(future)};document.querySelector('dialog [name=reason]').value='管理界面验收：调整期限';`,
      );
      await shot("admin-adjust-trial");
      await run("document.querySelector('dialog button[type=submit]').click()");
      await until(() => run('!document.querySelector("dialog[open]")'));
      assert.ok(
        await run(
          "document.querySelector('.time-left').innerText.includes('9 天')",
        ),
      );
      await run("document.querySelector('#adjust').click()");
      await run(
        `document.querySelector('dialog [name=expiry]').value=${JSON.stringify(previous)};document.querySelector('dialog [name=reason]').value='管理界面验收：恢复原期限';document.querySelector('dialog button[type=submit]').click();`,
      );
      await until(() => run('!document.querySelector("dialog[open]")'));
      report.checks.push("通过真实管理界面修改试用期限并恢复，保留审计");
    }
    const csrf = await run(
      "fetch('/api/v1/me').then(r=>r.json()).then(j=>Boolean(j.csrf && j.user.role==='admin'))",
    );
    assert.ok(csrf);
    report.checks.push("管理员会话通过HttpOnly Cookie维持");
    const blocked = await run(
      "fetch('/api/v1/admin/apps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'test-app',name:'Test'})}).then(r=>r.status)",
    );
    assert.equal(blocked, 403);
    report.checks.push("缺少CSRF令牌的管理写操作被403拒绝");
    await run(
      "Array.from(document.querySelectorAll('[data-page]')).find(b=>b.dataset.page==='软件接入').click()",
    );
    await until(() => run('Boolean(document.querySelector(".product"))'));
    await run("document.querySelector('[data-edit-app]').click()");
    await until(() => run('Boolean(document.querySelector("dialog[open]"))'));
    await shot("admin-software-settings");
    assert.ok(await run("Boolean(document.querySelector('[name=contact]'))"));
    await run("document.querySelector('[data-close]').click()");
    report.checks.push("软件配置、作者联系方式与设备上限表单可操作");
    await run("Array.from(document.querySelectorAll('[data-page]')).find(b=>b.dataset.page==='防滥用').click()");
    await until(() => run('Boolean(document.querySelector("#abuse-policy"))'));
    const quota = await run("document.querySelector('[name=max_ip_trials]').value");
    await run("document.querySelector('#abuse-policy').requestSubmit()");
    await until(() => run("document.querySelector('#notice').textContent.includes('已保存')"));
    assert.equal(await run("document.querySelector('[name=max_ip_trials]').value"), quota);
    await shot("admin-abuse-control");
    report.checks.push("真实防滥用页面显示IP/MAC记录，IP名额设置保存成功");
    const qa = JSON.parse(fs.readFileSync(path.join(ROOT, '.auth-private/smoke-account.json'), 'utf8'));
    const claimId = await run(`fetch('/api/v1/admin/state').then(r=>r.json()).then(s=>s.trial_claims.find(c=>c.user_id===${JSON.stringify(qa.userId)} && c.app_id==='jvox-studio' && !c.released)?.id)`);
    if (claimId) {
      await run(`document.querySelector('[data-release-claim="${claimId}"]').click()`);
      await until(() => run('Boolean(document.querySelector("dialog[open]"))'));
      await run("document.querySelector('dialog [name=reason]').value='自动化验收结束，释放作者电脑领取名额';document.querySelector('dialog form').requestSubmit()");
      await until(() => run('!document.querySelector("dialog[open]")'));
      report.checks.push("通过真实管理界面释放本次QA记录的IP/设备/MAC名额，保留审计");
    }
    await run(
      "Array.from(document.querySelectorAll('[data-page]')).find(b=>b.dataset.page==='操作记录').click()",
    );
    await until(() => run('Boolean(document.querySelector("table"))'));
    await shot("admin-audit");
    report.checks.push("授权操作记录实际显示");
    await run("document.querySelector('#logout').click()");
    await until(() => run('Boolean(document.querySelector("#login"))'));
    assert.equal(
      await run("fetch('/api/v1/admin/state').then(r=>r.status)"),
      401,
    );
    report.checks.push("管理员退出后会话撤销、管理接口返回401");
    report.passed = true;
  } catch (e) {
    report.passed = false;
    report.error = e.stack;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    win?.destroy();
    app.exit(report.passed ? 0 : 1);
  }
});
