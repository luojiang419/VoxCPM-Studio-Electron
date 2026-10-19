/* 实际 Electron 主进程与实际 API，缺失全部模型时仍能进入；不下载、不调用推理。 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect, until, wait } = require('./lib/electron_cdp.cjs');
const root = path.resolve(__dirname,'..'), frontend = path.join(root,'frontend/voxcpm_studio_electron');
const run = path.join(root,'builds/lazy-startup-validation',String(Date.now()));
const shell = path.join(run,'resources/app'), data = path.join(run,'data'), appRoot = path.join(run,'app');
let child, client;
(async()=>{
  for(const directory of [shell,appRoot,path.join(run,'profile'),path.join(data,'config')])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(run,'runtime_manifest.json'),'{"protocol":1}');
  fs.writeFileSync(path.join(run,'package.json'),JSON.stringify({name:'lazy-startup-validation',version:'2.0.2',main:'resources/app/main.js'}));
  fs.writeFileSync(path.join(data,'config/update-settings.json'),'{"autoCheck":false}');
  const lora=path.join(data,'lora/fixture');fs.mkdirSync(lora,{recursive:true});fs.writeFileSync(path.join(lora,'lora_config.json'),JSON.stringify({lora_config:{r:32},base_model:'fixture-model'}));fs.writeFileSync(path.join(lora,'lora_weights.safetensors'),'fixture');
  for(const file of ['main.js','window-behavior.js','preload.js','runtime-service.js','runtime-config.json','runtime-requirements.txt','component-service.js','music-config.json','update-service.js','update-window.js','update-config.json','updater.py','install-protocol.js','app.ico','app-icon.png'])fs.copyFileSync(path.join(frontend,file),path.join(shell,file));
  fs.cpSync(path.join(frontend,'dist'),path.join(shell,'dist'),{recursive:true});
  fs.writeFileSync(path.join(appRoot,'desktop_api.py'),`import os,sys,types,time\nif os.environ.get('VOXCPM_BACKEND_LOG'): sys.stdout=sys.stderr=open(os.environ['VOXCPM_BACKEND_LOG'],'a',encoding='utf8',buffering=1)\nfrom pathlib import Path\np=types.ModuleType('voxcpm');p.__path__=[${JSON.stringify(path.join(root,'backend/voxcpm'))},${JSON.stringify(path.join(root,'../src/voxcpm'))}];sys.modules['voxcpm']=p\ntime.sleep(float(os.environ.get('VOXCPM_VALIDATION_DELAY','0')))\nstarted=time.monotonic()\nif os.environ.get('VOXCPM_VALIDATION_FAIL_BOOT')=='1': raise RuntimeError('fixture backend failure')\nfrom voxcpm.studio_api import create_api_app\napp=create_api_app()\ncreate_ms=round((time.monotonic()-started)*1000)\n@app.get('/validation/imports')\ndef imports(): return {'createApiMs':create_ms,'heavyModules':[n for n in ['torch','gradio','funasr','voxcpm.core'] if n in sys.modules]}\nimport uvicorn\nuvicorn.run(app,host='127.0.0.1',port=int(sys.argv[sys.argv.index('--port')+1]),log_level='warning')\n`);
  const python = spawnSync('python',['-c','import sys; print(sys.executable)'],{encoding:'utf8',windowsHide:true}).stdout.trim();
  assert.ok(fs.existsSync(python));
  const launches=[];
  for(const {delay,fail} of [{delay:2},{delay:0},{delay:0,fail:true}]){
    const env={...process.env,VOXCPM_APP_ROOT:appRoot,VOXCPM_DATA_ROOT:data,VOXCPM_PYTHON_EXE:python,VOXCPM_VALIDATION_DELAY:String(delay),VOXCPM_VALIDATION_FAIL_BOOT:fail?'1':'0'};delete env.ELECTRON_RUN_AS_NODE;
    const started=Date.now(),log=fs.openSync(path.join(run,'electron.log'),'a');
    child=spawn(require(path.join(frontend,'node_modules/electron')).trim(),[run,'--remote-debugging-port=19482',`--user-data-dir=${path.join(run,'profile')}`],{env,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
    client=await connect(19482);
    await until(()=>client.evaluate("!!document.querySelector('.studio-shell')"));
    const shellMs=Date.now()-started;
    if(delay){assert.equal(await client.evaluate("document.querySelector('.runtime-startup-dialog')?.open"),false);assert.equal(await client.evaluate('window.voxcpmDesktop.getBootstrapState().then(s=>s.status!==\'ready\')'),true);}
    if(fail){
      const error=await until(async()=>{const b=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');return b.status==='error'&&b;},15000);
      assert.ok(error.detail.includes('fixture backend failure'));
      assert.ok(Date.now()-started<15000);
      await until(()=>client.evaluate("document.querySelector('.runtime-startup-dialog')?.open"));
      launches.push({expectedFailure:true,shellMs,errorMs:Date.now()-started});
    } else {
    const boot=await until(async()=>{const b=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');if(['error','stopped'].includes(b.status))throw Error(b.detail);return b.status==='ready'&&b;},120000);
    const readyMs=Date.now()-started;
    const recognition=await fetch(boot.backendBaseUrl+'/api/asr/recognize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audioPath:'fixture.wav'})});
    assert.equal(recognition.status,400);
    const reason=await recognition.json();assert.ok(reason.detail.includes('模型资源缺失或损坏'));
    const config={protocol:1,defaultProviderId:'responses',autoOptimizeMusic:true,providers:[{id:'responses',name:'示例 Responses 助手',baseUrl:'https://fixture.invalid/v1',model:'example-model',apiType:'responses',enabled:true},{id:'deepseek',name:'示例 DeepSeek 助手',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',apiType:'chat-completions',enabled:true}]};
    for(const defaultProviderId of ['responses','deepseek']){
      const response=await fetch(boot.backendBaseUrl+'/api/assistant/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...config,defaultProviderId})});
      assert.equal(response.status,200);assert.equal((await response.json()).defaultProviderId,defaultProviderId);
    }
    const loras=await (await fetch(boot.backendBaseUrl+'/api/lora')).json();assert.equal(loras.items[0].config.r,32);
    const detail=await (await fetch(boot.backendBaseUrl+'/validation/imports')).json();assert.deepEqual(detail.heavyModules,[]);
    assert.equal(fs.existsSync(path.join(data,'cache/component-ready.json')),false);
    const state=await client.evaluate('window.voxcpmDesktop.getPreparationState()');assert.equal(state.phase,'ready');
    await client.evaluate("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.includes('设置')).click()");
    await until(()=>client.evaluate("!!document.querySelector('.settings-layout')"));
    await wait(200);const shot=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(run,delay?'settings-actual.png':'settings-repeat.png'),Buffer.from(shot.data,'base64'));
    assert.equal(client.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);
    launches.push({injectedBackendDelayMs:delay*1000,shellMs,readyMs,...detail});
    }
    await client.evaluate('window.voxcpmDesktop.stopBackend()');client.close();client=null;
    if(child?.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});child=null;
  }
  fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({ok:true,launches,checks:['本地服务连接前已显示工作区且可导航','所有模型缺失不阻塞正常启动','实际API、运行摘要和已有LoRA列表未导入Torch/Gradio/FunASR/core','未执行组件完整准备或伪写就绪凭证','实际调用ASR时才校验该模型并返回明确400错误','实际助手配置保存与默认选择持久化','实际设置布局截图与重启通过','后端提前退出立即显示错误与修复入口'],run},null,2));
  console.log(JSON.stringify({run,launches},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(client){await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(()=>{});client.close();}if(child?.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});});
