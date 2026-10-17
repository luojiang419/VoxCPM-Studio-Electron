// 用隔离工程验证角色删除、台词转移、音频缓存和自动保存；不运行模型推理。
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {spawn,spawnSync}=require('child_process');
const {connect,until,wait}=require('./lib/electron_cdp.cjs');
const root=path.resolve(__dirname,'..'),project=path.join(root,'frontend/voxcpm_studio_electron');
const bundle=path.join(root,'builds/VoxCPM-Studio-Electron-Portable-2.0.1'),output=path.join(root,'builds/role-delete-validation');
const portable=process.argv.includes('--portable'),mode=portable?'portable':'source',run=path.join(output,`${mode}-${Date.now()}`);
const python=path.join(bundle,'runtime/python/python.exe'),exe=portable?path.join(bundle,'VoxCPM Studio.exe'):path.join(project,'node_modules/electron/dist/electron.exe');
const data=path.join(run,'data'),env={...process.env,VOXCPM_DATA_ROOT:data,VOXCPM_PYTHON_EXE:python};delete env.ELECTRON_RUN_AS_NODE;
const seed=`from pathlib import Path
import importlib.util,sys,copy,json,wave
root=Path(sys.argv[1]);folder=Path(sys.argv[2]);folder.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('workspace_seed',root/'backend/voxcpm/studio_workspace.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
store=mod.WorkspaceStore(folder/'workspace',None)
audio=folder/'sample.wav'
with wave.open(str(audio),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(bytes(32000))
def role(id,name,control,color):return {'id':id,'name':name,'color':color,'config':{**mod.DEFAULT_CONFIG,'control':control},'volume':1,'pan':0}
def segment(id,role,text,pause):
 s={'id':id,'roleId':role['id'],'text':text,'pauseAfterMs':pause,'audioPath':str(audio),'duration':1,'status':'ready','error':''};s['fingerprint']=store._fingerprint(s,role);return s
a=role('a','地方','轻柔自然','#f6a66d');b=role('b','角色 2','沉稳清晰','#a6b880');c=role('c','角色 3','自然文艺','#d6b66b');d=role('d','空角色','','#d59683')
p={'id':'delete_test','name':'角色删除验收','roles':[a,b,c,d],'segments':[segment('s1',a,'第一句完整保留',450),segment('s2',a,'第二句完整保留',600),segment('s3',b,'这句保持原样',300),segment('s4',c,'这句用于撤销恢复',350)],'backgroundMusic':{'path':'','volume':.15},'createdAt':mod.timestamp(),'updatedAt':mod.timestamp()}
p['lastExport']={'outputPath':str(audio),'archivePath':'','srtPath':'','duration':4,'fingerprint':store._export_fingerprint(p)}
x=role('x','同配置甲','相同音色','#f6a66d');y=role('y','同配置乙','相同音色','#a6b880')
q={'id':'same_config','name':'相同配置复用验收','roles':[x,y],'segments':[segment('same_segment',x,'相同配置复用已有音频',300)],'backgroundMusic':{'path':'','volume':.15},'createdAt':mod.timestamp(),'updatedAt':mod.timestamp()}
store.db={'projects':[p,q],'voices':[],'history':[]};store._save()
`;
let child,c,boot;const cases=[];
async function click(selector){await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(60);}
async function change(selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await wait(70);}
async function saved(){await until(()=>c.evaluate("document.querySelector('.ps-save-state')?.classList.contains('saved')"));}
async function stored(id='delete_test'){const r=await fetch(boot.backendBaseUrl+'/api/workspace/projects/'+id);assert.ok(r.ok);return r.json();}
async function shot(name){const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,`${mode}-${name}.png`),Buffer.from(r.data,'base64'));}
async function count(n){await until(()=>c.evaluate(`document.querySelectorAll('.ps-role-tab').length===${n}`));}
(async()=>{
fs.mkdirSync(run,{recursive:true});const seeded=spawnSync(python,['-c',seed,root,data],{encoding:'utf8',windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);
child=spawn(exe,[...(portable?[]:[project]),'--remote-debugging-port=19238',`--user-data-dir=${path.join(run,'profile')}`],{cwd:path.dirname(exe),env,windowsHide:true,stdio:'ignore'});
c=await connect(19238);boot=await until(()=>c.evaluate("window.voxcpmDesktop?.getBootstrapState().then(s=>s.status==='ready'&&s)"),180000);
await until(()=>c.evaluate("Boolean(document.querySelector('[aria-label=\"切换项目\"]'))"));await change('[aria-label="切换项目"]','delete_test');await count(4);await saved();const baseline=await stored();assert.ok(baseline.segments.every(s=>!s.stale));
assert.equal(await c.evaluate("document.querySelectorAll('.ps-role-tabs button button').length"),0);
for(const [width,height]of[[1544,941],[1180,760]]){
 await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 for(const theme of ['light','dark']){
  await c.evaluate(`document.body.dataset.theme=${JSON.stringify(theme)}`);
  await click('[aria-label="删除角色 地方"]');await until(()=>c.evaluate("document.querySelector('.ps-role-delete-dialog')?.open"));
  const bounds=await c.evaluate("(()=>{const e=document.querySelector('.ps-role-delete-dialog'),r=e.getBoundingClientRect();return {fits:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,focus:e.contains(document.activeElement),overflow:document.documentElement.scrollWidth>innerWidth}})()");
  assert.equal(bounds.fits,true);assert.equal(bounds.focus,true);assert.equal(bounds.overflow,false);
  assert.equal(await c.evaluate("[...document.querySelector('#ps-delete-role-target').options].some(e=>e.value==='a')"),false);
  await shot(`${width}-${theme}-dialog`);await click('.ps-role-delete-actions button');assert.equal(await c.evaluate("Boolean(document.querySelector('.ps-role-delete-dialog'))"),false);await count(4);
 }
}
await click('[aria-label="删除角色 地方"]');await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>c.evaluate("!document.querySelector('.ps-role-delete-dialog')"));assert.deepEqual((await stored()).roles,baseline.roles);cases.push('cancel-and-escape');
await click('[aria-label="删除角色 空角色"]');await count(3);await saved();let current=await stored();assert.equal(current.roles.some(r=>r.id==='d'),false);assert.deepEqual(current.segments,baseline.segments);assert.equal(await c.evaluate("document.querySelector('[aria-label=\"角色名称\"]').value"),'地方');cases.push('delete-empty-preserve-selection');
await click('[aria-label="删除角色 地方"]');await change('#ps-delete-role-target','b');await click('.ps-delete-role-confirm');await count(2);await saved();current=await stored();
assert.equal(current.roles.some(r=>r.id==='a'),false);assert.equal(current.segments.length,4);assert.equal(current.lastExport.stale,true);
for(const id of ['s1','s2']){const before=baseline.segments.find(s=>s.id===id),after=current.segments.find(s=>s.id===id);assert.equal(after.roleId,'b');assert.equal(after.text,before.text);assert.equal(after.pauseAfterMs,before.pauseAfterMs);assert.equal(after.audioPath,before.audioPath);assert.equal(after.stale,true);}
assert.deepEqual(current.segments.find(s=>s.id==='s3'),baseline.segments.find(s=>s.id==='s3'));assert.equal(await c.evaluate("document.querySelector('[aria-label=\"角色名称\"]').value"),'角色 2');cases.push('transfer-text-order-pauses-and-invalidate-audio');await shot('transferred');
// 验证合成锁：仅模拟任务响应，不启动模型。
await c.evaluate("(()=>{const native=window.fetch.bind(window);window.__deleteRoleTaskDone=false;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/generate'))return new Response(JSON.stringify({taskId:'role-delete-test',status:'queued',statusText:'验收排队'}),{headers:{'Content-Type':'application/json'}});if(url.endsWith('/api/tasks/role-delete-test'))return new Response(JSON.stringify({taskId:'role-delete-test',status:window.__deleteRoleTaskDone?'succeeded':'running',statusText:'验收任务',completed:0,total:1,result:window.__deleteRoleTaskDone?{failedCount:0}:undefined}),{headers:{'Content-Type':'application/json'}});return native(input,init)}})()");
await click('.ps-footer-actions .ps-primary');await until(()=>c.evaluate("[...document.querySelectorAll('.ps-delete-role')].every(e=>e.disabled)"));await click('[aria-label="删除角色 角色 3"]');await count(2);await c.evaluate("window.__deleteRoleTaskDone=true");await until(()=>c.evaluate("[...document.querySelectorAll('.ps-delete-role')].some(e=>!e.disabled)"));cases.push('block-deletion-during-generation');
await c.evaluate("[...document.querySelectorAll('.ps-segment')].find(e=>e.querySelector('textarea').value==='这句用于撤销恢复').querySelector('[aria-label=\"删除台词\"]').click()");await until(()=>c.evaluate("document.querySelectorAll('.ps-segment').length===3"));await click('[aria-label="删除角色 角色 3"]');await count(1);await c.evaluate("document.querySelector('.ps-undo button').click()");await until(()=>c.evaluate("document.querySelectorAll('.ps-segment').length===4"));await saved();current=await stored();assert.equal(current.roles.length,1);assert.equal(current.segments.find(s=>s.id==='s4').roleId,'b');assert.equal(current.segments.find(s=>s.id==='s4').text,baseline.segments.find(s=>s.id==='s4').text);assert.ok(current.segments.every(s=>current.roles.some(r=>r.id===s.roleId)));cases.push('delete-with-undo-keeps-valid-role');
assert.equal(await c.evaluate("document.querySelector('.ps-delete-role').disabled"),true);await click('.ps-delete-role');await count(1);cases.push('preserve-last-role');
await c.send('Page.reload');await until(()=>c.evaluate("document.querySelectorAll('.ps-role-tab').length===1&&document.querySelectorAll('.ps-segment').length===4"));await saved();assert.equal((await stored()).roles[0].id,'b');cases.push('reload-persistence');
await change('[aria-label="切换项目"]','same_config');await until(()=>c.evaluate("document.querySelector('[aria-label=\"项目名称\"]')?.value==='相同配置复用验收'"));await count(2);const sameBefore=await stored('same_config');await click('[aria-label="删除角色 同配置甲"]');await click('.ps-delete-role-confirm');await count(1);await saved();const sameAfter=await stored('same_config');assert.equal(sameAfter.segments[0].roleId,'y');assert.equal(sameAfter.segments[0].stale,false);assert.equal(sameAfter.segments[0].audioPath,sameBefore.segments[0].audioPath);cases.push('reuse-audio-with-same-config');await shot('final-role');
assert.equal(c.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);const report={result:'passed',mode,cases,dialogStates:4,javascriptErrors:0};fs.writeFileSync(path.join(output,`${mode}-result.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(async e=>{console.error(e);try{if(c)await shot('failure')}catch{}process.exitCode=1}).finally(()=>{c?.close();if(child)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})});
