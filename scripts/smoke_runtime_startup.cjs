// 使用实际安装资源验证启动检测；任何重新安装请求均使验收失败。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { RuntimeService } = require('../frontend/voxcpm_studio_electron/runtime-service');

(async () => {
  assert.equal(process.env.VOXCPM_INSTALLED_RESOURCES_READONLY, '1');
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'builds/gpu-resource-validation');
  const service = new RuntimeService({ root: process.env.VOXCPM_INSTALLED_ROOT,
    appRoot: path.join(root, 'scripts/dev_backend'), dataRoot: output,
    appDir: path.join(root, 'frontend/voxcpm_studio_electron'), readOnlyResources: false });
  service.prepare = async () => { throw Error('已安装环境不应重新下载或安装'); };
  const started = Date.now();
  const result = await service.launch({ existingPython: process.env.VOXCPM_PYTHON_EXE,
    existingModel: process.env.VOXCPM_MODEL_DIR, managed: true });
  assert.equal(result.python, process.env.VOXCPM_PYTHON_EXE);
  assert.equal(result.modelDir, process.env.VOXCPM_MODEL_DIR);
  assert.match(result.env.CUDA_VISIBLE_DEVICES, /^\d+$/);
  const report = { passed: true, startupCheckMs: Date.now() - started, python: result.python,
    cudaVisibleDevices: result.env.CUDA_VISIBLE_DEVICES, modelScan: false, downloads: 0 };
  await fs.writeFile(path.join(output, 'startup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
