# VoxCPM Studio Electron

这是 `VoxCPM Studio` 的 Electron 原生桌面版源码仓库目录，包含：

1. `frontend/voxcpm_studio_electron`
   - Electron 主进程
   - React + TypeScript + Vite 渲染层
   - 本地 Python HTTP API 桌面联动逻辑
2. `scripts`
   - Windows 便携包构建脚本
3. `docs`
   - 便携包、打包和使用说明

## 目录结构

```text
Electron版本/
  frontend/
    voxcpm_studio_electron/
  scripts/
    build_windows_electron_bundle.ps1
  docs/
```

## 本地开发

```bash
cd frontend/voxcpm_studio_electron
npm install
npm run build
```

如本机 Electron 运行环境已就绪，可直接启动：

```bash
npm start
```

## Windows 便携打包

Windows 下推荐使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_electron_bundle.ps1
```

更多说明见：

1. [docs/Windows便携打包说明.md](./docs/Windows便携打包说明.md)
2. [docs/Electron便携包开箱即用说明.md](./docs/Electron便携包开箱即用说明.md)
