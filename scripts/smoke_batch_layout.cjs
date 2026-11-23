// 检查批量页真实滚轮与独立滚动；生成任务响应使用夹具，不运行模型推理。
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {spawn,spawnSync}=require('child_process');
const {connect,until,wait}=require('./lib/electron_cdp.cjs');
const root=path.resolve(__dirname,'..'),project=path.join(root,'frontend/voxcpm_studio_electron');
const bundle=path.join(root,'builds/VoxCPM-Studio-Electron-Portable-2.0.1'),output=path.join(root,'builds/batch-layout-validation');
const portable=process.argv.includes('--portable'),mode=portable?'portable':'source',run=path.join(output,`${mode}-${Date.now()}`);
const exe=portable?path.join(bundle,'VoxCPM Studio.exe'):path.join(project,'node_modules/electron/dist/electron.exe');
const env={...process.env,VOXCPM_DATA_ROOT:path.join(run,'data'),VOXCPM_PYTHON_EXE:path.join(bundle,'runtime/python/python.exe')};delete env.ELECTRON_RUN_AS_NODE;
let child,c;const checks=[];
async function click(selector){await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(70);}
async function change(selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);await wait(70);}
async function rects(){return c.evaluate("Object.fromEntries(['.studio-page-heading','.batch-form-card','.batch-result-card','.batch-form-card .panel-head','.batch-result-card .panel-head','.batch-actions'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,{top:r.top,bottom:r.bottom,left:r.left,right:r.right}]}))");}
async function stable(before){assert.deepEqual(await rects(),before);assert.ok(await c.evaluate("document.scrollingElement.scrollTop===0&&document.querySelector('main.workspace').scrollTop===0&&document.querySelector('.panel-shell').scrollTop===0&&document.documentElement.scrollWidth<=innerWidth"));}
async function wheel(selector,deltaY){const point=await c.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(60,r.height/2)}})()`);await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});await wait(150);}
async function shot(name){await wait(200);const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,`${mode}-${name}.png`),Buffer.from(r.data,'base64'));}
(async()=>{
fs.mkdirSync(run,{recursive:true});child=spawn(exe,[...(portable?[]:[project]),'--remote-debugging-port=19240','--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',`--user-data-dir=${path.join(run,'profile')}`],{cwd:path.dirname(exe),env,windowsHide:true,stdio:'ignore'});
c=await connect(19240);await until(()=>c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready')"),180000);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
await c.evaluate("[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()==='批量生成').click()");await until(()=>c.evaluate("Boolean(document.querySelector('.batch-grid'))"));
for(const [width,height]of[[1544,941],[1366,768],[1180,760],[900,760]]){
 await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 for(const theme of ['light','dark']){
  await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`);
  for(const formMode of ['声音设计','可控克隆','极致克隆']){
   await change('.batch-form-card select',formMode);await c.evaluate("document.querySelector('.batch-form-scroll').scrollTop=0");const before=await rects();
   for(const r of Object.values(before))assert.ok(r.top>=0&&r.bottom<=height+1&&r.left>=0&&r.right<=width+1);
   await wheel('.batch-form-scroll',600);assert.ok(await c.evaluate("document.querySelector('.batch-form-scroll').scrollTop>100"),'表单应独立滚动');await stable(before);
   await c.evaluate("document.querySelector('.batch-form-scroll').scrollTop=100000");assert.ok(await c.evaluate("(()=>{const p=document.querySelector('.batch-form-scroll').getBoundingClientRect();return [...document.querySelectorAll('.batch-form-card .toggle-row')].every(e=>{const r=e.getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom+1})})()"));await stable(before);
   checks.push({width,height,theme,formMode,realWheel:true,fixed:true});
  }
  await change('.batch-form-card select','声音设计');await c.evaluate("document.querySelector('.batch-form-scroll').scrollTop=0");await shot(`${width}-${theme}`);
 }
}
await c.send('Emulation.setDeviceMetricsOverride',{width:1180,height:760,deviceScaleFactor:1,mobile:false});await c.evaluate("document.body.dataset.theme='light'");await change('[aria-label="批量文本"]','第一条\n第二条');
await c.evaluate("(()=>{const native=window.fetch.bind(window);window.__batchFinish=false;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/api/tasks/generate-batch')){window.__batchPayload=JSON.parse(init.body);return new Response(JSON.stringify({taskId:'batch-layout-test',status:'queued',statusText:'排队中'}),{headers:{'Content-Type':'application/json'}})}if(url.endsWith('/api/tasks/batch-layout-test'))return new Response(JSON.stringify({taskId:'batch-layout-test',status:window.__batchFinish?'succeeded':'running',statusText:window.__batchFinish?'批量任务完成':'正在批量生成',result:window.__batchFinish?{archivePath:'C:/validation/batch-result.zip',log:Array.from({length:500},(_,i)=>'第 '+(i+1)+' 条生成完成').join('\\n')}:undefined}),{headers:{'Content-Type':'application/json'}});return native(input,init)}})()");
await click('.batch-actions .primary-button');await until(()=>c.evaluate("document.querySelector('.batch-actions .primary-button').disabled"));await wheel('.batch-form-scroll',500);await c.evaluate("window.__batchFinish=true");await until(()=>c.evaluate("!document.querySelector('.batch-actions .primary-button').disabled&&document.querySelector('[aria-label=\"批量日志\"]').value.includes('第 500 条')"));assert.equal(await c.evaluate("window.__batchPayload.batchText"),'第一条\n第二条');assert.equal(await c.evaluate("document.querySelector('.batch-actions .ghost-button').disabled"),false);
const beforeLog=await rects(),formScroll=await c.evaluate("document.querySelector('.batch-form-scroll').scrollTop");await wheel('[aria-label="批量日志"]',900);assert.ok(await c.evaluate("document.querySelector('[aria-label=\"批量日志\"]').scrollTop>100"),'日志应独立滚动');assert.equal(await c.evaluate("document.querySelector('.batch-form-scroll').scrollTop"),formScroll);await stable(beforeLog);await shot('completed-log');
await c.evaluate("document.querySelector('.panel-shell').scrollTop=10000;document.querySelector('main.workspace').scrollTop=10000");await stable(beforeLog);
for(const label of ['声音设计与克隆','配音工作台','设置']){await c.evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);await wait(100);assert.equal(await c.evaluate("Boolean(document.querySelector('.batch-workspace-shell'))"),false);assert.equal(await c.evaluate("document.documentElement.scrollWidth>innerWidth"),false);}
assert.equal(c.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);const report={result:'passed',mode,checks,longLog:true,taskFlow:'mocked task responses',javascriptErrors:0};fs.writeFileSync(path.join(output,`${mode}-result.json`),JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,mode,states:checks.length,realWheel:true,longLog:true,javascriptErrors:0},null,2));
})().catch(async e=>{console.error(e);try{if(c)await shot('failure')}catch{}process.exitCode=1}).finally(()=>{c?.close();if(child)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})});
