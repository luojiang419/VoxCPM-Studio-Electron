# Windows 便携打包说明

这套方案不是 Docker，也不是只开浏览器，而是一个适合 Windows 迁移使用的本地桌面包：

1. 前端控制台优先切换为 Electron 原生桌面工作台。
2. 旧 Gradio / WebView 控制台仍保留为回退入口，但不再作为默认桌面版。
3. 通过 Windows Embeddable Python 构建私有运行时，整个目录可以直接打包迁移。

这意味着：

1. 运行时不依赖目标机本地 Python。
2. 运行时不依赖目标机本地 CUDA Toolkit。
3. 只要目标机有兼容的 NVIDIA 驱动，就可以直接使用包内的 CUDA 版 Torch。

如果你要给最终用户一份“拿到包后怎么运行、需要什么环境、不需要什么环境”的说明，请直接看：

- [Electron便携包开箱即用说明.md](./Electron便携包开箱即用说明.md)

## 目录结构

打包完成后，产物结构大致如下：

```text
VoxCPM-Studio-Electron-Portable/
  app/
    app.py
    desktop_api.py
    desktop_app.py
    src/
    assets/
    conf/
    scripts/
    examples/
  runtime/
    python/
  data/
    config/
      studio_config.json
    outputs/
    lora/
    cache/
  electron_shell/
  ffmpeg/
  models/
  Launch VoxCPM Studio Desktop.bat
  Launch VoxCPM Studio Electron.bat
  Launch VoxCPM Studio Legacy WebView.bat
  Launch VoxCPM Studio Browser.bat
  Check Portable Runtime.bat
```

## 桌面版入口

- `desktop_api.py`
  作用：启动本地 HTTP API，供 Electron 原生前端调用。

- `Launch VoxCPM Studio Desktop.bat`
  作用：默认桌面版入口，直接启动 Electron 原生前端。

- `Launch VoxCPM Studio Electron.bat`
  作用：Electron 桌面入口别名，和默认桌面版入口一致。

- `Launch VoxCPM Studio Legacy WebView.bat`
  作用：保留旧 `pywebview` 壳，作为 Electron 不可用时的兼容回退入口。

- `Launch VoxCPM Studio Browser.bat`
  作用：直接打开浏览器版本地控制台。

- `Check Portable Runtime.bat`
  作用：快速检查包内 Python、Torch、CUDA、GPU、FFmpeg 和模型状态。

## data 目录系统

为了让软件配置和自动生成结果与程序主体分离，当前默认会在软件同级目录维护一套 `data/` 目录系统：

- `data/config/`
  - 存放控制台配置文件，例如 `studio_config.json`
- `data/outputs/`
  - 存放自动保存的单条音频、批量归档和其他输出结果
- `data/lora/`
  - 存放 LoRA 训练输出和检查点
- `data/cache/`
  - 存放模型缓存、下载缓存和运行缓存

这意味着：

1. 程序代码目录和运行数据目录分离。
2. 升级桌面壳或替换程序文件时，不容易误覆盖已有配置和生成结果。
3. 便携包内的默认桌面入口、浏览器入口、Legacy WebView 回退入口都会自动把 `VOXCPM_DATA_ROOT` 指向同级 `data/`。

## 打包脚本

推荐 Electron 便携打包脚本位置：

```text
Electron版本/scripts/build_windows_electron_bundle.ps1
```

它会完成这些事情：

1. 先构建私有 Python 运行时和后端依赖。
2. 安装 Electron 前端依赖。
3. 构建 React + TypeScript + Vite 前端产物。
4. 复制 Electron 壳目录到便携包。
5. 保留浏览器版与旧 WebView 版回退入口。
6. 把默认桌面版入口重定向到 Electron。
7. 自动压缩成 zip，便于迁移。

这是当前更推荐的 `Electron + 本地 Python API` 便携包方案。

如果你只想保留旧的 Python / WebView 便携壳，仍可使用：

```text
scripts/build_windows_portable.ps1
```

如果你还想用 Flutter 原生 EXE 作为最外层桌面壳，项目里还额外提供了：

```text
scripts/build_windows_flutter_bundle.ps1
```

它会先构建后端运行时，再编译 Flutter Windows 壳，最后把两者打成一套目录包。

如果你想直接一条命令构建 CUDA 便携包，可以用：

```text
scripts/build_windows_cuda_portable.ps1
```

## 推荐打包方式

在 Windows PowerShell 中执行：

```powershell
cd G:\data\app\VoxCPM-2.0.2
powershell -ExecutionPolicy Bypass -File .\Electron版本\scripts\build_windows_electron_bundle.ps1 `
  -PythonVersion 3.12.10 `
  -TorchChannel cu126 `
  -TorchVersion 2.6.0 `
  -TorchAudioVersion 2.6.0 `
  -ModelDir G:\data\models\VoxCPM2 `
  -FfmpegDir G:\data\app\DIT\ffmpeg `
  -ProxyUrl http://127.0.0.1:7890
```

如果你想打 CPU 版，才需要额外加上：

```powershell
-UseCpuTorch
```

如果本地没有模型目录，也可以不传 `-ModelDir`，脚本会默认下载：

```text
openbmb/VoxCPM2
```

如需关闭构建阶段自动下载，可加：

```powershell
-SkipModelDownload
```

## 旧 Python / WebView 便携壳打包方式

如果你想继续保留旧的 `desktop_app.py + pywebview` 方案，请用：

```powershell
cd G:\data\app\VoxCPM-2.0.2
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_portable.ps1 `
  -PythonVersion 3.12.10 `
  -TorchChannel cu126 `
  -TorchVersion 2.6.0 `
  -TorchAudioVersion 2.6.0 `
  -ModelDir G:\data\models\VoxCPM2 `
  -FfmpegDir G:\data\app\DIT\ffmpeg `
  -ProxyUrl http://127.0.0.1:7890
```

## Flutter 桌面壳打包方式

如果你要直接产出 Flutter Windows 原生 EXE 壳，请用：

```powershell
cd G:\data\app\VoxCPM-2.0.2
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_flutter_bundle.ps1 `
  -FlutterSdk G:\data\flutter `
  -PythonVersion 3.12.10 `
  -TorchChannel cu126 `
  -TorchVersion 2.6.0 `
  -TorchAudioVersion 2.6.0 `
  -ModelDir G:\data\models\VoxCPM2 `
  -FfmpegDir G:\data\app\DIT\ffmpeg `
  -ProxyUrl http://127.0.0.1:7890
```

## 一键 CUDA 便携包方式

默认使用 Electron 桌面壳：

```powershell
cd G:\data\app\VoxCPM-2.0.2
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_cuda_portable.ps1 `
  -ModelDir G:\data\models\VoxCPM2
```

如果你想改成旧 Python 桌面壳：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_cuda_portable.ps1 `
  -ShellMode python `
  -ModelDir G:\data\models\VoxCPM2
```

如果你不传 `-ModelDir`，它会默认在构建阶段下载 `openbmb/VoxCPM2` 到包内。

如果你只想构建 CPU 版 Electron 包，再额外加入：

```powershell
-UseCpuTorch
```

## 为什么这里优先建议 CPU 打包

因为 Windows 便携包的第一目标是“可迁移、可直接启动、少踩环境坑”。  
GPU 版虽然性能更好，但包体更大，也更依赖目标机驱动兼容性。

更稳妥的做法是：

1. 如果目标机明确有 NVIDIA 环境，优先直接打 CUDA 版便携包。
2. 如果要做最大兼容性版本，再额外补一个 CPU 版包。

## 模型下载策略

桌面控制台内部已经内置这套顺序：

1. 先尝试 ModelScope 国内源。
2. 失败后尝试 Hugging Face 镜像。
3. 仍失败则使用代理地址。

代理地址默认是：

```text
http://127.0.0.1:7890
```

如果目标机不是本机回环代理，而是局域网代理，可以在桌面控制台的“系统设置”里改成：

```text
http://192.168.x.x:7890
```

## 桌面壳说明

当前已经有两层桌面方案：

1. Electron 原生桌面前端：
   - 左侧窄导航
   - 右侧原生工作区
   - 深灰暗黑 / 浅色主题
   - 本地文件选择、保存、日志和任务状态更稳定
2. 旧 WebView 回退入口：
   - 仍可启动统一控制台
   - 主要用于兼容或排障

这样做的好处是：

1. Electron 成为正式桌面版主入口。
2. 旧控制台仍可回退，降低迁移风险。
3. Windows 便携化和后续原生前端演进可以继续共用同一套 Python 后端能力。

## 注意事项

1. Electron 方案不再依赖 WebView2 作为主窗口承载，但旧回退入口仍会涉及 `pywebview`。
2. CUDA 加速依然要求目标机具备兼容的 NVIDIA 驱动，但不要求本地 Python 或 CUDA Toolkit。
3. 如果某台机器 Electron 启动异常，可以先改用旧 WebView 入口或浏览器入口排障。
4. 可以先运行 `Check Portable Runtime.bat`，确认 Torch、CUDA、GPU、FFmpeg 和模型目录状态。
5. LoRA 训练脚本也会被一起复制到便携包里，因此不是只能推理，训练入口也保留。
6. 如果要进一步做成单独安装器，可以在这套便携包基础上再加 NSIS / Inno Setup，但当前先以“可迁移目录包”为主。
