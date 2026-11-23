// 实际 Electron + 生产退出控制器/React，验证持久化、窗口隐藏、托盘回调与真正退出。
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { connect, until, wait } = require("./lib/electron_cdp.cjs");
const root = path.resolve(__dirname, ".."), frontend = path.join(root, "frontend/voxcpm_studio_electron");
const out = path.join(root, "builds/close-behavior-validation", String(Date.now()));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
let child, client;
const state = () => JSON.parse(fs.readFileSync(path.join(out, "state.json")));
const saved = () => JSON.parse(fs.readFileSync(path.join(out, "config/window-behavior.json"))).behavior;
function command(action, extra = {}) { fs.writeFileSync(path.join(out, "command.json"), JSON.stringify({ action, ...extra })); }
async function click(selector) { await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function launch() {
  child = spawn(path.join(frontend, "node_modules/electron/dist/electron.exe"), [path.join(__dirname, "preview_close_behavior.cjs"), `--demo-root=${out}`, "--validation", "--remote-debugging-port=19461"], { env, stdio: "ignore" });
  client = await connect(19461);
  await until(() => client.evaluate('!!document.querySelector(".wc-preview") && !!document.body.dataset.theme'));
  await until(() => state().visible);
}
async function open() { command("close"); await until(() => client.evaluate('!!document.querySelector(".window-close-dialog[open]")')); }
async function cancel() { await click(".wc-cancel"); await until(() => client.evaluate('!document.querySelector(".window-close-dialog")')); }
async function exited() { client?.close(); client = null; await until(() => child.exitCode !== null); assert.equal(child.exitCode, 0); }
async function shot(name) { await wait(220); const data = await client.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data.data, "base64")); }
async function check(label, fn) { await fn(); checks.push(label); console.log("PASS " + label); }
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await launch();
  await check("首次关闭默认询问，取消与 Escape 不保存", async () => {
    assert.equal(await client.evaluate('window.voxcpmDesktop.getWindowBehavior().then(s=>s.behavior)'), "ask");
    await open(); assert.equal(await client.evaluate('document.activeElement.className'), "wc-cancel");
    await click('input[value="quit"]');
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until(() => client.evaluate('!document.querySelector(".window-close-dialog")'));
    assert.equal(fs.existsSync(path.join(out, "config/window-behavior.json")), false);
    await open(); await click('[aria-label="取消退出，返回软件"]');
    await until(() => client.evaluate('!document.querySelector(".window-close-dialog")'));
    assert.equal(state().visible, true);
  });
  await check("浅色、深色和每次询问的真实渲染", async () => {
    await open(); await shot("light");
    assert.equal(await client.evaluate('getComputedStyle(document.querySelector(".window-close-dialog")).colorScheme'), "light");
    command("close"); await wait(150); assert.equal(await client.evaluate('document.querySelectorAll(".window-close-dialog").length'), 1);
    for (let i = 0; i < 8; i++) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      assert.equal(await client.evaluate('!!document.activeElement.closest(".window-close-dialog")'), true);
    }
    await cancel(); await click('[aria-label="切换界面主题"]'); await open(); await shot("dark");
    assert.equal(await client.evaluate('getComputedStyle(document.querySelector(".window-close-dialog")).colorScheme'), "dark");
    await click('input[value="ask"]'); await shot("ask-every-time");
    assert.equal(await client.evaluate('document.querySelector(".window-close-dialog .wc-secondary").textContent'), "本次后台运行");
  });
  await check("每次询问：本次后台运行，窗口隐藏、托盘恢复后再次询问", async () => {
    await click(".window-close-dialog .wc-secondary");
    await until(() => !state().visible && state().tray);
    assert.equal(saved(), "ask"); assert.equal(child.exitCode, null);
    command("restore"); await until(() => state().visible);
    await open(); await cancel();
  });
  await check("后台运行记住选择，重复关闭与真正重启不再询问", async () => {
    await open(); await click('input[value="background"]'); await click(".window-close-dialog .wc-primary");
    await until(() => !state().visible); assert.equal(saved(), "background");
    command("restore"); await until(() => state().visible); command("close");
    await until(() => !state().visible); assert.equal(state().promptOpen, false);
    command("tray-quit"); await exited();
    await launch(); assert.equal(await client.evaluate('window.voxcpmDesktop.getWindowBehavior().then(s=>s.behavior)'), "background");
    command("close"); await until(() => !state().visible && !state().promptOpen && state().tray);
    command("restore"); await until(() => state().visible);
  });
  await check("设置即时修改，关闭软件选项持久化且真实退出", async () => {
    await click('.wc-setting-option:last-child');
    await until(() => saved() === "ask"); await open(); await click('input[value="quit"]'); await shot("quit-selected");
    await click(".window-close-dialog .wc-primary"); await exited(); assert.equal(saved(), "quit");
    await launch(); command("close"); await exited(); assert.equal(saved(), "quit");
  });
  await check("每次询问跨进程持久化，本次关闭不会变成固定退出", async () => {
    await launch(); await click('.wc-setting-option:last-child'); await until(() => saved() === "ask");
    await open(); await click('input[value="ask"]'); await click(".window-close-dialog .wc-primary"); await exited(); assert.equal(saved(), "ask");
    await launch(); await open();
  });
  await check("小窗口无横向溢出，减弱动效生效", async () => {
    command("resize", { width: 480, height: 520 }); await wait(180); await shot("compact");
    const layout = await client.evaluate('(()=>{const e=document.querySelector(".window-close-dialog"),r=e.getBoundingClientRect();return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight, noHorizontalOverflow:e.scrollWidth<=e.clientWidth};})()');
    assert.deepEqual(layout, { inside: true, noHorizontalOverflow: true });
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await client.evaluate('getComputedStyle(document.querySelector(".window-close-dialog")).animationName'), "none");
  });
  await check("外部 app.quit（更新退出路径）绕过偏好及已打开弹窗", async () => {
    command("app-quit"); await exited();
  });
  await launch();
  await check("偏好写入失败保留窗口与弹窗，取消不落盘", async () => {
    // 临时以同名目录阻止原子文件写入，模拟磁盘异常，随后还原本次独立数据。
    const file = path.join(out, "config/window-behavior.json"), original = fs.readFileSync(file);
    fs.unlinkSync(file); fs.mkdirSync(file);
    try {
      await open(); await click('input[value="quit"]'); await click(".window-close-dialog .wc-primary");
      await until(() => client.evaluate('!!document.querySelector(".wc-error")'));
      assert.equal(state().visible, true); assert.equal(child.exitCode, null);
      await cancel();
    } finally { fs.rmdirSync(file); fs.writeFileSync(file, original); }
  });
  const runtimeErrors = client.events.filter(e => e.method === "Runtime.exceptionThrown"); assert.deepEqual(runtimeErrors, []);
  command("app-quit"); await exited();
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ passed: true, checks, realElectron: true, productionComponents: true, realTrayAndWindow: true, isolatedData: true,
    screenshots: ["light.png", "dark.png", "ask-every-time.png", "quit-selected.png", "compact.png"], scope: "真实退出控制器/React/IPC/磁盘持久化与托盘菜单回调；未启动模型与更新服务，未自动点击 Windows 托盘区域。" }, null, 2));
  console.log("验证完成：" + out);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close(); if (child && child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
});
