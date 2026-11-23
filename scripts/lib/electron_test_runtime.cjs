// 嵌入式 Python 忽略 PYTHONPATH；隔离启动文件并引用现有依赖，确保验收运行当前源码。
const fs = require('fs'), path = require('path');
function preparePython(root, run) {
  const original = path.join(root, 'builds/VoxCPM-Studio-Electron-Portable-2.0.1/runtime/python');
  const target = path.join(run, 'python');
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(original)) {
    if (/^(python(?:3|312)?\.(?:exe|dll|zip)|vcruntime.*\.dll)$/.test(file)) fs.copyFileSync(path.join(original, file), path.join(target, file));
  }
  fs.writeFileSync(path.join(target, 'python312._pth'), ['python312.zip', '.', original, path.join(original, 'Lib/site-packages'),
    path.resolve(root, '../src'), 'import site', ''].join('\n'));
  return path.join(target, 'python.exe');
}
module.exports = { preparePython };
