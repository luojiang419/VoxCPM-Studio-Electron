const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawn, spawnSync } = require("child_process");
const { connect, until, wait } = require("./lib/electron_cdp.cjs");
const root = path.resolve(__dirname, "..");
const project = path.join(root, "frontend/voxcpm_studio_electron");
const output = path.join(root, "builds/production-validation");
const portable = process.argv.includes("--portable");
const exe = portable ? path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1/VoxCPM Studio.exe") : path.join(project, "node_modules/electron/dist/electron.exe");
const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(output, "data"),
  VOXCPM_MODEL_DIR: path.resolve(root, "../models/openbmb__VoxCPM2"),
  VOXCPM_PYTHON_EXE: path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1/runtime/python/python.exe") };
delete env.ELECTRON_RUN_AS_NODE;
let child, client;
const pages = ["配音工作台", "声音设计与克隆", "音色库", "作品记录", "批量生成", "LoRA 训练", "运行控制", "资源概览", "设置"];
async function click(name) {
  await client.evaluate(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()`);
  await wait(150);
}
async function shot(name) {
  const result = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(result.data, "base64"));
}
async function rects() {
  return client.evaluate(`Object.fromEntries(['.studio-page-tools','.ps-header','.ps-project-bar','.ps-pane-heading','.ps-inspector-heading','.ps-production-footer','.studio-page-heading'].map(selector=>{const e=document.querySelector(selector);return [selector,e?{top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}:null]}))`);
}
function unchanged(before, after) {
  for (const name of Object.keys(before)) if (before[name]) {
    assert.ok(Math.abs(before[name].top - after[name].top) < 1, `${name} 标题随滚动移动`);
    assert.ok(Math.abs(before[name].bottom - after[name].bottom) < 1, `${name} 框架高度变化`);
  }
}
async function noBlue() {
  const bad = await client.evaluate(`(()=>{
    function blue(value){const m=value.match(/^rgba?\\(([^)]+)\\)/);if(!m)return false;const [r,g,b,a=1]=m[1].split(/[, ]+/).map(Number);if(!a)return false;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;if(d<14||d/(max||1)<.12)return false;let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;h=(h*60+360)%360;return h>=160&&h<=290;}
    return [...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return !e.closest('.works-tone-video,.works-tone-music')&&r.width&&r.height&&r.bottom>0&&r.top<innerHeight}).flatMap(e=>{const s=getComputedStyle(e);return ['color','backgroundColor','borderTopColor','borderRightColor','accentColor'].filter(p=>blue(s[p]||'')).map(p=>({tag:e.tagName,class:e.className,property:p,value:s[p]}))}).slice(0,12);
  })()`);
  assert.deepEqual(bad, [], JSON.stringify(bad));
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  child = spawn(exe, [...(portable ? [] : [project]), "--remote-debugging-port=19232"], { cwd: path.dirname(exe), env, windowsHide: true, stdio: "ignore" });
  client = await connect(19232);
  const boot = await until(async () => { const s = await client.evaluate("window.voxcpmDesktop?.getBootstrapState()"); return s?.status === "ready" && s; }, 180000);
  const api = async (route, body, method) => {
    const r = await fetch(boot.backendBaseUrl + route, { method: method || (body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(r.ok); return r.json();
  };
  await until(() => client.evaluate("Boolean(document.querySelector('[aria-label=\"切换项目\"]'))"));
  let sample = await api("/api/workspace/projects", { name: "布局滚动验收 · 多角色长文案" });
  sample.roles[0].color = "#9e8cff"; // 历史项目蓝紫色同样必须被温暖色盘替换显示。
  sample.segments = Array.from({ length: 24 }, (_, i) => ({ id: `layout_${i}`, roleId: sample.roles[0].id,
    text: `第 ${i + 1} 句：让文案留在创作区，让标题、角色工具和试听操作始终在眼前。`, pauseAfterMs: 300 }));
  sample = await api(`/api/workspace/projects/${sample.id}`, sample, "PUT");
  await client.send("Page.reload");
  await until(() => client.evaluate("Boolean(document.querySelector('[aria-label=\"切换项目\"]'))"));
  await client.evaluate(`(()=>{const e=document.querySelector('[aria-label="切换项目"]');e.value=${JSON.stringify(sample.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => client.evaluate("document.querySelectorAll('.ps-segment').length===24"));
  for (const [width, height] of [[1560,980],[1366,768],[1180,760]]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await wait(120);
    await client.evaluate("document.querySelectorAll('.ps-inspector-body details').forEach(e=>e.open=true)");
    const before = await rects();
    await client.evaluate("document.querySelector('.ps-segment-list').scrollTop=0;document.querySelector('.ps-inspector-body').scrollTop=0");
    const point = await client.evaluate("(()=>{const r=document.querySelector('.ps-segment-list').getBoundingClientRect();return {x:r.left+100,y:r.top+70}})()");
    await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: 650 });
    await wait(120);
    assert.ok(await client.evaluate("document.querySelector('.ps-segment-list').scrollTop>100"), "台词内容应独立滚动");
    unchanged(before, await rects());
    const inspector = await client.evaluate("(()=>{const r=document.querySelector('.ps-inspector-body').getBoundingClientRect();return {x:r.left+50,y:r.top+60}})()");
    await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...inspector, deltaX: 0, deltaY: 700 });
    await wait(120);
    assert.ok(await client.evaluate("document.querySelector('.ps-inspector-body').scrollTop>100"));
    unchanged(before, await rects());
    assert.equal(await client.evaluate("document.scrollingElement.scrollTop"), 0);
    assert.ok(await client.evaluate("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.ps-production-footer').getBoundingClientRect().bottom<=innerHeight"));
    await noBlue();
    await shot(`fixed-layout-${width}`);
  }
  const results = [];
  for (const theme of ["dark", "light"]) {
    await client.evaluate(`document.body.setAttribute('data-theme',${JSON.stringify(theme)})`);
    for (const page of pages) {
      await click(page);
      const before = await rects();
      await client.evaluate("document.querySelector('.panel-shell').scrollTop=1000;document.querySelectorAll('.works-content,.ps-library > .ps-voice-grid').forEach(e=>e.scrollTop=1000)");
      await wait(100);
      unchanged(before, await rects());
      assert.equal(await client.evaluate("document.scrollingElement.scrollTop"), 0);
      await noBlue(); results.push({ page, theme, fixed: true, blueElements: 0 });
      if (page === "设置") await shot(`fixed-settings-${theme}`);
    }
  }
  await click("配音工作台");
  await client.evaluate("document.body.setAttribute('data-theme','dark');document.querySelector('.ps-segment-list').scrollTop=0;document.querySelector('.ps-inspector-body').scrollTop=0");
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1560, height: 980, deviceScaleFactor: 1, mobile: false });
  await shot("fixed-layout-final");
  const errors = client.events.filter(e => e.method === "Runtime.exceptionThrown");
  assert.equal(errors.length, 0);
  const report = { result: "passed", mode: portable ? "portable" : "source", sizes: [1560,1366,1180], checks: results, javascriptErrors: 0 };
  fs.writeFileSync(path.join(output, "fixed-layout-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  client?.close(); if (child) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
});
