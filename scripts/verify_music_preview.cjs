/* 不提供音乐运行包/权重路径覆盖，验证本机预览可从完整启动门禁进入。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {connect,until}=require('./lib/electron_cdp.cjs');
const root=path.resolve(__dirname,'..'),run=path.join(root,'builds/music-ui-live-validation');
let child,client;
(async()=>{
  fs.cpSync(path.join(root,'frontend/voxcpm_studio_electron/dist'),path.join(run,'resources/app/dist'),{recursive:true});
  fs.cpSync(path.join(root,'backend/voxcpm'),path.join(run,'app/src/voxcpm'),{recursive:true,filter:file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')});
  const env={...process.env,VOXCPM_COMPONENT_REUSE_ROOT:process.argv[2]||''};
  for(const key of ['ELECTRON_RUN_AS_NODE','VOXCPM_DATA_ROOT','VOXCPM_PYTHON_EXE','VOXCPM_MUSIC_ENGINE_ROOT','VOXCPM_MUSIC_MODELS_ROOT','VOXCPM_PROJECT_ROOT','PYTHONPATH']) delete env[key];
  child=spawn(path.join(run,'VoxCPM Studio.exe'),['--voxcpm-run','--remote-debugging-port=19248','--disable-backgrounding-occluded-windows'],{cwd:run,env,windowsHide:true,stdio:'ignore'});
  client=await connect(19248);
  await until(async()=>{
    const state=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
    if(state.status==='error') throw new Error(state.detail);
    return state.status==='ready';
  },240000);
  const state=await client.evaluate('window.voxcpmDesktop.getBootstrapState()');
  const status=await (await fetch(state.backendBaseUrl+'/api/music/status')).json();
  assert.equal(status.models.filter(model=>model.ready).length,4);
  const receipt=JSON.parse(fs.readFileSync(path.join(run,'data/cache/component-ready.json')));
  assert.deepEqual([...receipt.selected].sort(),['ace-xl-turbo','heartmula','minimax-music3','yue2'].sort());
  await client.evaluate('window.voxcpmDesktop.setAutoCheckUpdate(false)');
  console.log('PASS 本机预览从默认路径启动、四模型资源自检完成、工作区已开放，无新下载');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(client){await client.evaluate('window.voxcpmDesktop.stopBackend()').catch(()=>{});client.close();}
  if(child?.pid) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
});
