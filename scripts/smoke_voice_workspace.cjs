// 在真实 Electron 中检查板块边界、独立滚动和模式切换，不运行模型推理。
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawn, spawnSync } = require("child_process");
const { connect, until, wait } = require("./lib/electron_cdp.cjs");
const root = path.resolve(__dirname, "..");
const project = path.join(root, "frontend/voxcpm_studio_electron");
const output = path.join(root, "builds/voice-layout-validation");
const portable = process.argv.includes("--portable");
const bundle = path.join(root, "builds/VoxCPM-Studio-Electron-Portable-2.0.1");
const exe = portable ? path.join(bundle, "VoxCPM Studio.exe") : path.join(project, "node_modules/electron/dist/electron.exe");
const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(output, "data"),
  VOXCPM_PYTHON_EXE: path.join(bundle, "runtime/python/python.exe") };
delete env.ELECTRON_RUN_AS_NODE;
let child, client;
const checks = [];
async function change(selector, value) {
  await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  await wait(80);
}
async function screenshot(name) {
  const result = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(result.data, "base64"));
}
async function layout() {
  return client.evaluate(`(()=>{
    const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
    const selectors=['.studio-page-heading','.workspace-grid','.panel-card-workspace','.workspace-generation-footer','.panel-card-preview','.panel-card-control-presets'];
    return {width:innerWidth,height:innerHeight,outerScroll:document.querySelector('.panel-shell').scrollTop,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
      rects:Object.fromEntries(selectors.map(s=>[s,rect(s)])),
      toggles:[...document.querySelectorAll('.panel-card-workspace .toggle-row')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom}}),
      form:rect('.workspace-form-scroll'), footer:rect('.workspace-generation-footer')};
  })()`);
}
async function wheel(selector, deltaY) {
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollBy(0,${deltaY})`);
  await wait(120);
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  child = spawn(exe, [...(portable ? [] : [project]), "--remote-debugging-port=19234", `--user-data-dir=${path.join(output, 'profile')}`],
    { cwd: path.dirname(exe), env, windowsHide: true, stdio: "ignore" });
  client = await connect(19234);
  await until(() => client.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"), 180000);
  await client.evaluate("[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.trim()==='声音设计与克隆').click()");
  await until(() => client.evaluate("Boolean(document.querySelector('.voice-workspace-shell'))"));
  for (const [width, height] of [[1560,980],[1544,941],[1366,768],[1180,760]]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await client.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`);
      for (const mode of ["声音设计", "可控克隆", "极致克隆"]) {
        await change('.panel-card-workspace select', mode);
        await client.evaluate("document.querySelector('.workspace-form-scroll').scrollTop=0");
        const before = await layout();
        assert.equal(before.horizontalOverflow, false);
        assert.equal(before.outerScroll, 0);
        for (const [name, r] of Object.entries(before.rects)) if (r) {
          assert.ok(r.top >= 0 && r.bottom <= height + 1 && r.left >= 0 && r.right <= width + 1 && r.height > 0, `${name} 超出视口 ${JSON.stringify(before)}`);
        }
        assert.ok(before.form.bottom <= before.footer.top, "底栏不应覆盖表单");
        if (mode !== '极致克隆') for (const toggle of before.toggles) {
          assert.ok(toggle.top >= before.form.top && toggle.bottom <= before.form.bottom + 1, "默认表单的参数开关应直接可见");
        }
        await wheel('.workspace-form-scroll', 2000);
        const after = await layout();
        assert.deepEqual(after.footer, before.footer, "滚动时底栏应保持固定");
        for (const toggle of after.toggles) assert.ok(toggle.top >= after.form.top && toggle.bottom <= after.form.bottom + 1, "开关应能完整显示");
        if (mode !== "极致克隆") {
          await wheel('.preset-chip-grid', 3000);
          assert.ok(await client.evaluate("(()=>{const list=document.querySelector('.preset-chip-grid');const last=list.lastElementChild.getBoundingClientRect();const r=list.getBoundingClientRect();return last.top>=r.top&&last.bottom<=r.bottom+1})()"), "最后一个预设应可访问");
          const selected = await client.evaluate("(()=>{const e=document.querySelector('.preset-chip-grid').lastElementChild;const text=e.textContent;e.click();return text})()");
          await wait(60);
          assert.equal(await client.evaluate("document.querySelector('.panel-card-control-presets textarea').value"), selected);
        } else assert.equal(before.rects['.panel-card-control-presets'], null);
        checks.push({ width, height, theme, mode, passed: true });
        console.log(`通过 ${width}×${height} ${theme} ${mode}`);
      }
      await change('.panel-card-workspace select', '声音设计');
      await client.evaluate("document.querySelector('.workspace-form-scroll').scrollTop=0;document.querySelector('.preset-chip-grid').scrollTop=0");
      await screenshot(`${portable ? 'portable' : 'source'}-${width}-${theme}`);
    }
  }
  // 长文与主动拉高输入框后，表单仍可独立滚动到最后，操作区不移动。
  await change('.panel-card-workspace .field:not(.field-hidden) textarea', '这是一段用于布局验收的长文本。'.repeat(300));
  await client.evaluate("document.querySelector('.panel-card-workspace .field:not(.field-hidden) textarea').style.height='700px'");
  const before = await layout();
  await wheel('.workspace-form-scroll', 5000);
  const after = await layout();
  assert.deepEqual(after.footer, before.footer);
  assert.ok(await client.evaluate("(()=>{const e=document.querySelector('.workspace-form-scroll');return e.scrollTop>0&&Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop)<=1})()"));
  for (const toggle of after.toggles) assert.ok(toggle.bottom <= after.form.bottom + 1 && toggle.top >= after.form.top);
  // 窄窗口与低窗口回退为单列，底部板块可通过外层滚动完整访问。
  for (const [width,height] of [[900,760],[1180,600]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false });
    await client.evaluate("document.querySelector('.panel-card-workspace .field:not(.field-hidden) textarea').style.height='';document.querySelector('.panel-shell').scrollTop=10000");
    await wait(80);
    assert.ok(await client.evaluate("(()=>{const e=document.querySelector('.panel-card-control-presets').getBoundingClientRect();return e.bottom<=innerHeight+1&&e.bottom>0&&document.documentElement.scrollWidth<=innerWidth})()"));
    checks.push({width,height,fallback:true,passed:true});
  }
  await client.send('Emulation.setDeviceMetricsOverride', {width:1180,height:760,deviceScaleFactor:1,mobile:false});
  for (const page of ['配音工作台','音色库','作品记录','批量生成','LoRA 训练','运行控制','资源概览','设置']) {
    await client.evaluate(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.trim()===${JSON.stringify(page)}).click()`);
    await wait(100);
    assert.equal(await client.evaluate("Boolean(document.querySelector('.voice-workspace-shell'))"), false);
    assert.equal(await client.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
  }
  assert.equal(client.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  const report = { result: 'passed', mode: portable ? 'portable' : 'source', checks, longText: 'passed', javascriptErrors: 0 };
  fs.writeFileSync(path.join(output, `${portable ? 'portable' : 'source'}-result.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  client?.close();
  if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
