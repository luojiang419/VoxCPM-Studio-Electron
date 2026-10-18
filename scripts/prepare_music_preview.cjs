/* 本机预览使用已安装资源：硬链接后真实校验，不把权重或用户配置混入分发ZIP。 */
const fs = require('node:fs'), path = require('node:path');
const { ComponentService } = require('../frontend/voxcpm_studio_electron/component-service');
const root = path.resolve(__dirname, '..');
const run = path.join(root,'builds/music-ui-live-validation');
const appDir = path.join(run,'resources/app');
const source = process.argv[2];
if(!source) throw new Error('请传入已部署音乐项目根目录');
const catalog = JSON.parse(fs.readFileSync(path.join(appDir,'music-config.json')));
(async()=>{
  const controller = new AbortController();
  const runtimeService={controller,emit:()=>{}};
  const components=new ComponentService({root:run,dataRoot:path.join(run,'data'),appRoot:path.join(run,'app'),appDir,runtimeService});
  components.fetchImpl=()=>{throw new Error('本机预览只使用既有资源，不发起新下载');};
  for(const model of catalog.models){
    console.log('VERIFY_LOCAL_MODEL',model.label);
    for(const asset of model.files){
      const target=path.join(run,asset.name);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      if(!fs.existsSync(target)) fs.linkSync(path.join(source,asset.reusePath),target);
      await components.ensureFile(asset,target,()=>{},controller.signal);
    }
  }
  const engine=path.resolve(root,'../启动准备开发/builds/component-live-validation/runtime/music',catalog.runtime.version);
  const target=path.join(run,'runtime/music',catalog.runtime.version);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!fs.existsSync(target)) fs.symlinkSync(engine,target,'junction');
  fs.writeFileSync(path.join(run,'本机预览启动.cmd'),['@echo off','setlocal',`set "VOXCPM_COMPONENT_REUSE_ROOT=${path.resolve(source)}"`,'start "" "%~dp0VoxCPM Studio.exe"','endlocal',''].join('\r\n'));
  fs.writeFileSync(path.join(run,'本机预览说明.txt'),'此副本仅供本机使用，复用现有配音依赖、音乐运行包和模型。\n启动：双击本机预览启动.cmd。AI助手已按当前Windows账户加密配置。\n此目录含个人配置与资源链接，请勿将其作为正式安装包分发。\n正式轻量分发包另行构建，不包含个人配置或大模型。\n');
  console.log('LOCAL_PREVIEW_ASSETS_VERIFIED');
})().catch(error=>{console.error(error);process.exitCode=1;});
