// 真实 Electron + 真实媒体播放；生成任务用静音 WAV 夹具替代模型，验证界面绑定。
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {spawn,spawnSync}=require('child_process');
const {connect,until,wait}=require('./lib/electron_cdp.cjs');
const root=path.resolve(__dirname,'..'),project=path.join(root,'frontend/voxcpm_studio_electron');
const output=path.join(root,'builds/voice-layout-validation'),bundle=path.join(root,'builds/VoxCPM-Studio-Electron-Portable-2.0.1');
const portable=process.argv.includes('--portable'),mode=portable?'portable':'source';
const exe=portable?path.join(bundle,'VoxCPM Studio.exe'):path.join(project,'node_modules/electron/dist/electron.exe');
const env={...process.env,VOXCPM_DATA_ROOT:path.join(output,'player-data'),VOXCPM_PYTHON_EXE:path.join(bundle,'runtime/python/python.exe')};delete env.ELECTRON_RUN_AS_NODE;
let child,c;const checks=[];
function wav(seconds){const rate=16000,bytes=rate*seconds*2,b=Buffer.alloc(44+bytes);b.write('RIFF',0);b.writeUInt32LE(36+bytes,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(bytes,40);return b;}
async function change(selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);await wait(70);}
async function nav(label){await c.evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);await wait(100);}
async function shot(name){const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,`${mode}-player-${name}.png`),Buffer.from(r.data,'base64'));}
async function layout(){return c.evaluate(`(()=>{const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}};return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,outerScroll:document.querySelector('.panel-shell').scrollTop,footerParent:document.querySelector('.workspace-generation-footer').parentElement.matches('main.workspace'),form:rect('.workspace-form-scroll'),footer:rect('.workspace-generation-footer'),panels:['.panel-card-workspace','.workspace-reference-panel','.panel-card-control-presets'].map(rect),toggles:[...document.querySelectorAll('.panel-card-workspace .toggle-row')].map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}))}})()`);}
async function media(){return c.evaluate("(()=>{const a=document.querySelector('.workspace-generation-footer audio');return {paused:a.paused,time:a.currentTime,duration:a.duration,ready:a.readyState,muted:a.muted,error:!!a.error}})()");}
(async()=>{
fs.mkdirSync(output,{recursive:true});const fixture1=path.join(output,'sample-4s.wav'),fixture2=path.join(output,'sample-2s.wav');fs.writeFileSync(fixture1,wav(4));fs.writeFileSync(fixture2,wav(2));
child=spawn(exe,[...(portable?[]:[project]),'--remote-debugging-port=19234',`--user-data-dir=${path.join(output,mode+'-player-profile')}`],{cwd:path.dirname(exe),env,windowsHide:true,stdio:'ignore'});
c=await connect(19234);await until(()=>c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"),180000);
await nav('声音设计与克隆');await until(()=>c.evaluate("Boolean(document.querySelector('.workspace-generation-footer'))"));
assert.equal(await c.evaluate("document.querySelector('.workspace-play-button').disabled"),true);
assert.equal(await c.evaluate("document.querySelectorAll('.panel-card-preview').length"),0);
for(const [width,height] of [[1560,980],[1544,941],[1366,768],[1180,760]]){
 await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 for(const theme of ['light','dark']){
  await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`);
  for(const formMode of ['声音设计','可控克隆','极致克隆']){
   await change('.panel-card-workspace select',formMode);await c.evaluate("document.querySelector('.workspace-form-scroll').scrollTop=0");
   const before=await layout();assert.equal(before.overflow,false);assert.equal(before.outerScroll,0);assert.equal(before.footerParent,true);assert.ok(before.form.bottom<=before.footer.top);assert.ok(before.footer.bottom<=height+1);
   for(const r of before.panels)if(r)assert.ok(r.top>=0&&r.bottom<=before.footer.top+1&&r.left>=0&&r.right<=width+1&&r.height>0,JSON.stringify(before));
   for(const r of before.toggles)assert.ok(r.top>=before.form.top&&r.bottom<=before.form.bottom+1,'参数开关应完整可见');
   await c.evaluate("document.querySelector('.workspace-form-scroll').scrollTop=10000");assert.deepEqual((await layout()).footer,before.footer);
   if(formMode!=='极致克隆'){
    await c.evaluate("document.querySelector('.preset-chip-grid').scrollTop=10000");
    assert.ok(await c.evaluate("(()=>{const e=document.querySelector('.preset-chip-grid'),last=e.lastElementChild.getBoundingClientRect(),r=e.getBoundingClientRect();return last.top>=r.top&&last.bottom<=r.bottom+1})()"));
    const preset=await c.evaluate("(()=>{const e=document.querySelector('.preset-chip-grid').lastElementChild;e.click();return e.textContent})()");await wait(40);
    assert.equal(await c.evaluate("document.querySelector('.panel-card-control-presets textarea').value"),preset);
   }else assert.equal(before.panels[2],null);
   checks.push({width,height,theme,formMode,passed:true});
  }
  await change('.panel-card-workspace select','声音设计');await c.evaluate("document.querySelector('.workspace-form-scroll').scrollTop=0;document.querySelector('.preset-chip-grid').scrollTop=0");await shot(`${width}-${theme}-empty`);
 }
}
await change('[aria-label="合成文本"]','用于验收的长文。'.repeat(1000));const beforeLong=await layout();
assert.ok(await c.evaluate("(()=>{const e=document.querySelector('[aria-label=\"合成文本\"]');e.scrollTop=e.scrollHeight;return e.scrollHeight>e.clientHeight&&e.scrollTop>0})()"));assert.deepEqual((await layout()).footer,beforeLong.footer);
for(const [width,height]of[[900,760],[1180,600]]){
 await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await c.evaluate("document.querySelector('.panel-shell').scrollTop=10000");const r=await layout();assert.equal(r.overflow,false);assert.ok(r.footer.bottom<=height+1);assert.ok(r.panels[2].bottom<=r.footer.top+1);checks.push({width,height,fallback:true,passed:true});
}
await c.send('Emulation.setDeviceMetricsOverride',{width:1544,height:941,deviceScaleFactor:1,mobile:false});await c.evaluate("document.querySelector('.panel-shell').scrollTop=0;document.body.dataset.theme='light'");await change('[aria-label="合成文本"]','底部试听播放器验收。');
// 只替代生成及任务查询响应，其余 API、媒体读取和音频解码均为真实行为。
await c.evaluate(`(()=>{const nativeFetch=window.fetch.bind(window);let serial=0,polls=0;window.__playerGenerationCount=0;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/api/tasks/generate-single')){serial++;polls=0;window.__playerGenerationCount++;return new Response(JSON.stringify({taskId:'player-test',kind:'generate-single',status:'queued',statusText:'已排队'}),{headers:{'Content-Type':'application/json'}})}if(url.endsWith('/api/tasks/player-test')){polls++;const pending=polls<2;const file=serial===1?${JSON.stringify(fixture1)}:${JSON.stringify(fixture2)};return new Response(JSON.stringify({taskId:'player-test',kind:'generate-single',status:pending?'running':'succeeded',statusText:pending?'正在生成':'生成完成',result:pending?undefined:{output_path:file,previewUrl:'/media?path='+encodeURIComponent(serial===3?file+'.missing':file)}}),{headers:{'Content-Type':'application/json'}})}return nativeFetch(input,init)}})()`);
async function generate(){await c.evaluate("document.querySelector('.workspace-action-bar .primary-button').click()");await until(()=>c.evaluate("Boolean(document.querySelector('.workspace-progress-track'))"));const r=await layout();assert.ok(r.form.bottom<=r.footer.top);await until(()=>c.evaluate("!document.querySelector('.workspace-action-bar .primary-button').disabled"));}
await generate();await until(async()=>{const a=await media();return a.ready>=2&&Math.abs(a.duration-4)<.1});assert.equal(await c.evaluate("document.querySelector('.workspace-action-bar .ghost-button').disabled"),false);
await c.evaluate("document.querySelector('.workspace-play-button').click()");await until(async()=>{const a=await media();return !a.paused&&a.time>.1});await c.evaluate("document.querySelector('.workspace-play-button').click()");assert.equal((await media()).paused,true);
await change('.workspace-audio-seek',1.25);assert.ok(Math.abs((await media()).time-1.25)<.1);
await c.evaluate("document.querySelector('.workspace-mute-button').click()");assert.equal((await media()).muted,true);await c.evaluate("document.querySelector('.workspace-mute-button').click()");assert.equal((await media()).muted,false);
await change('.workspace-audio-seek',3.9);await c.evaluate("document.querySelector('.workspace-play-button').click()");await until(async()=>{const a=await media();return a.paused&&a.time>=3.99});
await c.evaluate("document.querySelector('.workspace-play-button').click()");await until(async()=>{const a=await media();return !a.paused&&a.time>.1&&a.time<1});
await generate();await until(async()=>{const a=await media();return a.ready>=2&&Math.abs(a.duration-2)<.1});assert.equal((await media()).paused,true);assert.equal((await media()).time,0);await shot('ready');
await c.evaluate("window.__lastPlayerAudio=document.querySelector('.workspace-generation-footer audio');document.querySelector('.workspace-play-button').click()");await until(async()=>!(await media()).paused);await nav('设置');assert.equal(await c.evaluate("window.__lastPlayerAudio.paused"),true);assert.equal(await c.evaluate("Boolean(document.querySelector('.workspace-generation-footer'))"),false);
await nav('声音设计与克隆');await until(async()=>{const a=await media();return a.ready>=2&&a.duration===2});assert.equal((await media()).paused,true);
await generate();await until(()=>c.evaluate("Boolean(document.querySelector('.workspace-playback-error'))"));await shot('media-error');await generate();await until(async()=>{const a=await media();return a.ready>=2&&!a.error});assert.equal(await c.evaluate("Boolean(document.querySelector('.workspace-playback-error'))"),false);
for(const page of ['配音工作台','音色库','作品记录','批量生成','LoRA 训练','运行控制','资源概览','设置']){await nav(page);assert.equal(await c.evaluate("Boolean(document.querySelector('.workspace-generation-footer'))"),false);assert.equal(await c.evaluate("document.documentElement.scrollWidth>innerWidth"),false);}
assert.equal(c.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);
const report={result:'passed',mode,checks,playback:['play','pause','seek','mute','ended','replay','replace-source','stop-on-navigation','return-paused','media-error','error-recovery'],longText:true,media:'real silent WAV fixtures with mocked generation task responses',javascriptErrors:0};fs.writeFileSync(path.join(output,`${mode}-player-result.json`),JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,mode,states:checks.length,playback:report.playback,javascriptErrors:0},null,2));
})().catch(async e=>{console.error(e);try{if(c)await shot('failure')}catch{}process.exitCode=1}).finally(()=>{c?.close();if(child)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})});
