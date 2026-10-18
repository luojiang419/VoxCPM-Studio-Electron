const { connect, until } = require('./lib/electron_cdp.cjs');
let connection;
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const c=await connect(9442);connection=c;
 const output=path.resolve(__dirname,'../builds/bootstrap-validation/visual');fs.mkdirSync(output,{recursive:true});
 if (process.argv.includes('--resume')) {
  await c.evaluate(`document.querySelector('.runtime-dialog .primary-button').click()`);
  await until(async()=>{
   const state=await c.evaluate(`window.voxcpmDesktop.getBootstrapState()`);
   if(state.status==='error')throw Error(state.detail);
   return state.status==='ready';
  },180000);
  const result=await c.evaluate(`(async()=>{const state=await window.voxcpmDesktop.getBootstrapState();return {state,runtime:await (await fetch(state.backendBaseUrl+'/api/runtime/summary')).json(),dialogOpen:document.querySelector('.runtime-dialog').open};})()`);
  if(result.dialogOpen)throw Error('服务就绪后补齐弹窗应关闭');
  fs.writeFileSync(path.join(output,'ready-result.json'),JSON.stringify(result,null,2));
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'ready-light.png'),Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify(result));return;
 }
 console.log(await c.evaluate(`(async()=>({title:document.title,text:document.body.innerText.slice(-800),state:await window.voxcpmDesktop.getBootstrapState()}))()`));
 const initial=await c.evaluate(`window.voxcpmDesktop.getPreparationState()`);if(initial.status!=='idle')throw Error('轻量包应等用户点击运行');
 await c.evaluate(`document.querySelector('.runtime-run-button').click()`);
 await until(()=>c.evaluate(`document.querySelector('.runtime-dialog')?.open`));
 console.log('popup',await c.evaluate(`(async()=>({state:await window.voxcpmDesktop.getPreparationState(),rect:document.querySelector('.runtime-dialog').getBoundingClientRect().toJSON()}))()`));
 for(const theme of ['dark','light']){
  await c.evaluate(`document.body.dataset.theme='${theme}'`);
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,`preparation-${theme}.png`),Buffer.from(shot.data,'base64'));
 }
 await c.evaluate(`window.voxcpmDesktop.cancelPreparation()`);
 await until(()=>c.evaluate(`window.voxcpmDesktop.getPreparationState().then(s=>s.status==='cancelled')`));
 console.log('cancelled',await c.evaluate(`(async()=>({state:await window.voxcpmDesktop.getPreparationState(),dialog:document.querySelector('.runtime-dialog').innerText}))()`));
 const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'paused-light.png'),Buffer.from(shot.data,'base64'));
 c.close();
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection?.close());
