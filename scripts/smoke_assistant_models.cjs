/* 隔离真实 Electron 设置组件；上游接口使用明确的测试夹具，不接触用户密钥。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const out = path.join(root, 'builds/assistant-model-validation');
fs.mkdirSync(out, { recursive: true });
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import AssistantSettings from ${JSON.stringify(path.join(frontend,'src/AssistantSettings.tsx'))};
import ${JSON.stringify(path.join(frontend,'src/styles.css'))};
import ${JSON.stringify(path.join(frontend,'src/studio-shell.css'))};
window.calls=[]; window.saved={protocol:1,defaultProviderId:'',autoOptimizeMusic:true,providers:[]}; window.fail=false;
window.fetch=async(url, options={})=>{const body=options.body?JSON.parse(options.body):null;window.calls.push({url,body});
if(url.endsWith('/reveal-key'))return {ok:true,json:async()=>({apiKey:'fixture-key'})};
if(url.endsWith('/models'))return {ok:!window.fail,status:window.fail?401:200,json:async()=>window.fail?{detail:'测试：密钥无效，可手动填写模型ID'}:{models:['deepseek-flash','deepseek-reasoner']}};
if(options.method==='PUT'){window.saved={...body,providers:body.providers.map(p=>{const {apiKey,...rest}=p;return {...rest,hasApiKey:!!apiKey||p.hasApiKey};})};}
return {ok:true,json:async()=>window.saved};};
createRoot(document.getElementById('root')).render(<AssistantSettings backendBaseUrl='http://fixture'/>);`;
(async()=>{
  await require(path.join(frontend,'node_modules/esbuild')).build({stdin:{contents:entry,loader:'tsx',resolveDir:frontend},bundle:true,outfile:path.join(out,'bundle.js'),loader:{'.png':'dataurl','.webp':'dataurl'},jsx:'automatic'});
  fs.writeFileSync(path.join(out,'index.html'),'<html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><body data-theme="dark"><div class="studio-shell" id="root"></div><script src="bundle.js"></script></body></html>');
  fs.writeFileSync(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out,'profile'))});app.whenReady().then(()=>{let w=new BrowserWindow({width:1500,height:1050,show:true,webPreferences:{contextIsolation:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(out,'index.html'))});});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(require(path.join(frontend,'node_modules/electron')).trim(),[path.join(out,'main.cjs'),'--remote-debugging-port=19481','--remote-debugging-address=127.0.0.1'],{env,windowsHide:true,stdio:'inherit'});
  client=await connect(19481);
  await until(()=>client.evaluate("document.querySelector('.assistant-settings-footer select')!==null"));
  await client.evaluate("(()=>{let e=document.querySelector('.assistant-settings-footer select');e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until(()=>client.evaluate("document.querySelector('.assistant-provider')!==null"));
  assert.equal(await client.evaluate("document.querySelectorAll('.assistant-provider input')[3].value"),'deepseek-flash');
  await client.evaluate("(()=>{let e=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'fixture-key');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(()=>client.evaluate("document.querySelector('select[aria-label]')?.options.length===3"));
  await client.evaluate("document.querySelector('button[aria-label=\"显示 API Key\"]').click()");
  await until(()=>client.evaluate("document.querySelector('.assistant-key-input input').type==='text'"));
  assert.equal(await client.evaluate("document.querySelector('.assistant-key-input input').value"),'fixture-key');
  await client.evaluate("document.querySelector('button[aria-label=\"隐藏 API Key\"]').click()");
  assert.equal(await client.evaluate("window.calls.filter(c=>c.url.endsWith('/models')).length"),1);
  await client.evaluate("(()=>{let e=document.querySelector('select[aria-label]');e.value='deepseek-reasoner';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('应用所选模型');
  await until(()=>client.evaluate("window.saved.providers[0]?.model==='deepseek-reasoner'"));
  assert.ok(await client.evaluate("window.saved.defaultProviderId===window.saved.providers[0].id"));
  assert.equal(await client.evaluate("document.querySelector('input[type=password]').value"),'');
  await until(()=>client.evaluate("document.querySelector('select[aria-label]')?.options.length===3"));
  await client.evaluate("document.querySelector('button[aria-label=\"显示 API Key\"]').click()");
  await until(()=>client.evaluate("document.querySelector('.assistant-key-input input').value==='fixture-key'"));
  await client.evaluate("document.querySelector('button[aria-label=\"隐藏 API Key\"]').click()");
  await until(()=>client.evaluate("document.querySelector('.assistant-key-input input').value===''"));
  await client.evaluate('window.fail=true');await click('刷新模型列表');
  await until(()=>client.evaluate("document.body.textContent.includes('测试：密钥无效')"));
  assert.equal(await client.evaluate("window.saved.providers[0].model"),'deepseek-reasoner');
  await client.evaluate('window.fail=false');await click('刷新模型列表');
  await until(()=>client.evaluate("document.querySelector('select[aria-label]')?.options.length===3"));
  for(const [name,width] of [['dark',1500],['narrow',760]]){
    await client.send('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:1,mobile:false});
    const shot=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
  }
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,checks:['DeepSeek默认模型','输入密钥自动获取','模型选择与应用保存','默认助手','密钥清空展示','失败保留配置','手动刷新恢复','宽窄界面截图','输入密钥显示隐藏','已存密钥查看收起']},null,2));
  console.log('PASS 真实 Electron 助手模型交互，10项检查（上游夹具）');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{client?.close();if(child?.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});});
let child,client;
async function click(label){await client.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);}
