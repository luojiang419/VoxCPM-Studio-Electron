// 真实 Electron 页面、布局与媒体播放；任务响应夹具验证界面绑定，真实 GPU 另见 smoke_moss_inference.py。
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'builds/moss-test');
const checks = [];
const fixture = path.join(output, 'ui-fixture.wav');
const b = Buffer.alloc(44 + 16000 * 2 * 3);
b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(fixture, b);
let c;
async function nav(name) { await until(()=>c.evaluate(`[...document.querySelectorAll('.nav-item')].some(x=>x.textContent.trim()===${JSON.stringify(name)})`)); await c.evaluate(`[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.trim()===${JSON.stringify(name)}).click()`); await wait(150); }
async function screenshot(name) { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64')); }
async function change(selector, value) { await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(100); }
(async () => {
  c = await connect(19346); await c.send('Page.reload');
  await until(() => c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"), 180000);
  await until(() => c.evaluate("!!document.querySelector('.nav-item')"));
  await wait(500);
  await c.evaluate("document.querySelector('[aria-label=\"关闭账户窗口\"]')?.click()");
  await nav('音效设计'); await until(() => c.evaluate("!!document.querySelector('.sfx-prompt')"));
  assert.equal(await c.evaluate("document.querySelector('.sfx-shell .primary-button').disabled"), true); checks.push('空描述不能提交');
  await c.evaluate("[...document.querySelectorAll('.sfx-filters button')].find(x=>x.textContent==='日常拟音').click()");
  assert.equal(await c.evaluate("document.querySelectorAll('.sfx-scenes button').length"), 2);
  await c.evaluate("document.querySelector('.sfx-scenes button').click()");
  assert.ok((await c.evaluate("document.querySelector('#sfx-prompt').value")).includes('机械键盘')); checks.push('分类过滤与灵感填入');
  await c.evaluate("document.querySelector('.sfx-filters button').click()");
  for (const [width, height] of [[1560, 980], [1366, 768], [1100, 760], [900, 650]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark']) {
      await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)};document.querySelector('.sfx-layout').scrollTop=0`);
      const before = await c.evaluate("(()=>{const f=document.querySelector('.workspace-generation-footer').getBoundingClientRect(),s=document.querySelector('.sfx-layout').getBoundingClientRect();return {top:f.top,bottom:f.bottom,scrollBottom:s.bottom,overflow:document.documentElement.scrollWidth>innerWidth}})()");
      assert.equal(before.overflow, false); assert.ok(before.bottom <= height + 1); assert.ok(before.scrollBottom <= before.top + 1);
      await c.evaluate("document.querySelector('.sfx-layout').scrollTop=10000");
      assert.equal(await c.evaluate("document.querySelector('.workspace-generation-footer').getBoundingClientRect().top"), before.top);
      await c.evaluate("document.querySelector('.sfx-layout').scrollTop=0");
      await screenshot(`soundeffect-${width}-${theme}`); checks.push(`${width}x${height} ${theme} 无溢出、播放器固定`);
    }
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await nav('声音设计与克隆');
  await change('#voice-design-model', 'moss-voice');
  assert.equal(await c.evaluate("document.querySelector('.workspace-moss-info').textContent.includes('无需参考音频')"), true);
  assert.equal(await c.evaluate("[...document.querySelectorAll('.panel-card-workspace select:not(#voice-design-model)')].some(e=>e.getBoundingClientRect().height>0)"), false);
  assert.equal(await c.evaluate("[...document.querySelectorAll('.panel-card-workspace .field')].filter(e=>e.offsetHeight>0).some(e=>e.textContent.includes('CFG'))"), false);
  for (const theme of ['light', 'dark']) { await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`); await screenshot('voice-moss-' + theme); }
  checks.push('语音模型切换隐藏不适用参数与参考音频');
  await change('#voice-design-model', 'voxcpm');
  assert.equal(await c.evaluate("!!document.querySelector('.reference-audio-card')"), true);
  checks.push('切回 VoxCPM 恢复克隆功能');
  await nav('音效设计');
  // 仅替换本页的任务与状态接口，音频仍经过真实本地 /media 读取。
  await c.evaluate(`(()=>{window.__originalFetch=window.fetch;window.__requests=[];window.fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/api/tasks/generate-soundeffect')){window.__requests.push(JSON.parse(init.body));return Response.json({taskId:'ui-fixture',status:'queued'});}if(url.endsWith('/api/tasks/ui-fixture'))return Response.json({taskId:'ui-fixture',status:'succeeded',statusText:'UI夹具完成',result:{id:'ui-fixture',outputPath:${JSON.stringify(fixture)},previewUrl:'/media?path='+encodeURIComponent(${JSON.stringify(fixture)}),title:'UI 播放验收',prompt:'机械键盘',createdAt:new Date().toISOString(),duration:3,settings:window.__requests[0]}});if(url.endsWith('/api/moss/status'))return Response.json({models:[{id:'soundeffect',ready:true}]});return window.__originalFetch(input,init);}})()`);
  await nav('声音设计与克隆'); await nav('音效设计');
  await until(() => c.evaluate("!document.querySelector('.sfx-shell .primary-button').disabled"));
  await c.evaluate("document.querySelector('.sfx-duration-chips button').click()");
  await c.evaluate("document.querySelector('.sfx-shell .primary-button').click()");
  await until(() => c.evaluate("!!document.querySelector('.sfx-result')"));
  assert.equal(await c.evaluate("window.__requests[0].seconds"), 5); checks.push('生成请求绑定时长及描述，完成后加入作品');
  await until(() => c.evaluate("document.querySelector('.sfx-shell audio').readyState>=2"));
  await c.evaluate("document.querySelector('.sfx-shell .workspace-play-button').click()"); await wait(200);
  assert.equal(await c.evaluate("document.querySelector('.sfx-shell audio').paused"), false); checks.push('真实本地媒体可播放');
  await c.evaluate("document.querySelector('.sfx-shell .workspace-play-button').click()");
  await c.evaluate("window.fetch=window.__originalFetch;localStorage.removeItem('jvox-soundeffect-v1')");
  const errors = c.events.filter(e => e.method === 'Runtime.exceptionThrown'); assert.equal(errors.length, 0); checks.push('无未处理脚本异常');
  fs.writeFileSync(path.join(output, 'ui-report.json'), JSON.stringify({ checks, passed: checks.length, fixtureGeneration: true }, null, 2));
  await c.send('Page.reload'); await wait(800); await c.evaluate("document.querySelector('[aria-label=\"关闭账户窗口\"]')?.click()"); await nav('音效设计');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2)); c.close();
})().catch(error => { console.error(error); c?.close(); process.exit(1); });
