// Electron 实际窗口布局验收；模型预热使用响应夹具，不运行推理。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), project = path.join(root, 'frontend/voxcpm_studio_electron');
const bundle = path.join(root, 'builds/VoxCPM-Studio-Electron-Portable-2.0.1');
const portable = process.argv.includes('--portable'), mode = portable ? 'portable' : 'source';
const output = path.join(root, 'builds/overview-layout-validation'), run = path.join(output, `${mode}-${Date.now()}`);
const exe = portable ? path.join(bundle, 'VoxCPM Studio.exe') : path.join(project, 'node_modules/electron/dist/electron.exe');
const env = { ...process.env, VOXCPM_DATA_ROOT: path.join(run, 'data'), VOXCPM_PYTHON_EXE: path.join(bundle, 'runtime/python/python.exe') };
delete env.ELECTRON_RUN_AS_NODE;
let child, c; const checks = [];
async function nav(label) {
  await c.evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);
  await wait(100);
}
async function shot(name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, `${mode}-${name}.png`), Buffer.from(r.data, 'base64'));
}
(async () => {
  fs.mkdirSync(run, { recursive: true });
  child = spawn(exe, [...(portable ? [] : [project]), '--remote-debugging-port=19242', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--user-data-dir=${path.join(run, 'profile')}`], { cwd: path.dirname(exe), env, windowsHide: true, stdio: 'ignore' });
  c = await connect(19242);
  await until(() => c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"), 180000);
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await nav('资源概览');
  await until(() => c.evaluate("document.querySelector('.overview-hardware')&&!document.querySelector('.overview-hardware').textContent.includes('待检测')"));
  await until(() => c.evaluate("!document.querySelector('.overview-metrics').textContent.includes('待检测')"));
  for (const [width, height] of [[1544,941], [1366,768], [1180,760], [900,760]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark']) {
      await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)};document.querySelectorAll('.overview-path').forEach(e=>e.open=false);document.querySelector('.panel-shell').scrollTop=0`);
      await wait(100);
      const state = await c.evaluate(`(()=>{const p=document.querySelector('.panel-shell');return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelWidth:p.clientWidth,panelScrollWidth:p.scrollWidth,overflow:p.scrollHeight-p.clientHeight,bottom:document.querySelector('.overview-details-grid').getBoundingClientRect().bottom,heading:document.querySelector('.studio-page-heading').getBoundingClientRect().top,paths:document.querySelectorAll('.overview-path').length}})()`);
      assert.ok(state.scrollWidth <= width && state.panelScrollWidth <= state.panelWidth, '不能横向溢出');
      assert.equal(state.paths, 7);
      if (width >= 1180) assert.ok(state.overflow <= 1 && state.bottom <= height, `默认信息应在首屏：${JSON.stringify(state)}`);
      await shot(`${width}-${theme}`);
      checks.push({ width, height, theme, ...state });
    }
  }
  // 使用超长路径覆盖展开、文本可选取和内容滚动；从真实运行数据派生，不修改配置。
  const longPath = ['G:', ...Array(45).fill('超长目录名称'), 'studio_config.json'].join('\\');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });
  await c.evaluate(`(()=>{const native=window.fetch.bind(window);window.__warmupDone=false;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input.url;
    if(url.endsWith('/api/tasks/warmup')){window.__warmupRequested=true;return new Response(JSON.stringify({taskId:'overview-warmup',status:'queued'}))}
    if(url.endsWith('/api/tasks/overview-warmup'))return new Response(JSON.stringify({taskId:'overview-warmup',status:window.__warmupDone?'succeeded':'running',statusText:window.__warmupDone?'预热验收完成':'预热中'}));
    const r=await native(input,init);if(url.endsWith('/api/runtime/summary')){const data=await r.json();data.config_path=${JSON.stringify(longPath)};return new Response(JSON.stringify(data))}return r};document.querySelector('.overview-status button').click()})()`);
  await until(() => c.evaluate("window.__warmupRequested&&document.querySelector('.overview-status button').disabled"));
  await c.evaluate('window.__warmupDone=true');
  await until(() => c.evaluate("!document.querySelector('.overview-status button').disabled&&document.querySelectorAll('.overview-path strong')[4].textContent.length>300"));
  const headingTop = await c.evaluate("document.querySelector('.studio-page-heading').getBoundingClientRect().top");
  await c.evaluate("document.querySelectorAll('.overview-path summary')[4].click()");
  assert.ok(await c.evaluate("(()=>{const e=document.querySelectorAll('.overview-path code')[4];return e.getBoundingClientRect().height>80&&getComputedStyle(e).userSelect==='text'&&e.textContent.endsWith('studio_config.json')})()"));
  const point = await c.evaluate("(()=>{const r=document.querySelector('.overview-directories').getBoundingClientRect();return {x:r.left+50,y:r.top+100}})()");
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1200 }); await wait(200);
  assert.ok(await c.evaluate("document.querySelector('.panel-shell').scrollTop>0"));
  assert.equal(await c.evaluate("document.querySelector('.studio-page-heading').getBoundingClientRect().top"), headingTop);
  assert.equal(await c.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
  await shot('expanded-long-path');
  // 键盘可操作折叠，完整路径仍可通过 title 查看。
  await c.evaluate("document.querySelectorAll('.overview-path summary')[4].focus()");
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => c.evaluate("!document.querySelectorAll('.overview-path')[4].open"));
  for (const label of ['运行控制', '批量生成', '声音设计与克隆']) {
    await nav(label);
    assert.equal(await c.evaluate("Boolean(document.querySelector('.overview-shell'))"), false);
    assert.equal(await c.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
  }
  assert.equal(c.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  const report = { result: 'passed', mode, checks, longPath: true, keyboard: true, warmup: 'mocked task responses', javascriptErrors: 0 };
  fs.writeFileSync(path.join(output, `${mode}-result.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'passed', mode, states: checks.length, longPath: true, keyboard: true, javascriptErrors: 0 }));
})().catch(async error => { console.error(error); try { if(c) await shot('failure'); } catch {} process.exitCode = 1; }).finally(() => {
  c?.close(); if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
});
