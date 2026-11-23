// 宣传片实操专用启动：只读复用安装资源，移除 Electron 的 Node 模式环境变量。
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'builds/promo');
fs.mkdirSync(out, { recursive: true });
const resources = spawnSync('pwsh.exe', ['-NoProfile', '-Command',
  `. '${path.join(__dirname, 'installed_resources.ps1').replaceAll("'", "''")}'; Get-InstalledVoxCPMResources | ConvertTo-Json -Compress`
], { encoding: 'utf8', windowsHide: true });
if (resources.status !== 0) throw new Error(resources.stderr);
const env = { ...process.env, ...JSON.parse(resources.stdout),
  VOXCPM_APP_ROOT: path.join(__dirname, 'dev_backend'),
  VOXCPM_DATA_ROOT: path.resolve(root, '../data'),
  VOXCPM_OFFLINE: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
  PIP_NO_INDEX: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const frontend = path.join(root, 'frontend/voxcpm_studio_electron');
const args = ['.'];
if (process.argv.includes('--software-rendering')) args.push('--disable-gpu');
const child = spawn(path.join(frontend, 'node_modules/electron/dist/electron.exe'), args, {
  cwd: frontend, env, detached: true, windowsHide: false,
  stdio: ['ignore', fs.openSync(path.join(out, 'app.stdout.log'), 'a'), fs.openSync(path.join(out, 'app.stderr.log'), 'a')]
});
fs.writeFileSync(path.join(out, 'session.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), python: env.VOXCPM_PYTHON_EXE }, null, 2));
child.unref();
console.log(`JVOX PID ${child.pid}`);
