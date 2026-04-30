# VoxCPM Studio Electron

这是 VoxCPM Studio 的 Electron 原生桌面前端工程。

## 当前结构

1. `main.js`
   - Electron 主进程
   - 拉起 `desktop_api.py`
   - 管理主题、窗口、对话框和桌面动作
2. `src/`
   - `React + TypeScript + Vite` 渲染层
   - 五个主工作区页面：工作台、概览、批量、训练、设置
3. `dist/`
   - `vite build` 后产出的前端静态文件

## 本地运行

```bash
cd Electron版本/frontend/voxcpm_studio_electron
npm install --ignore-scripts
npm run build
```

如果本机 Electron 二进制已完整安装，可直接运行：

```bash
npm start
```

如需指定 Python 或模型目录，可使用环境变量：

```bash
VOXCPM_PYTHON_EXE=/path/to/python VOXCPM_MODEL_DIR=/path/to/model npm start
```
