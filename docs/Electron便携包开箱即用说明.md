# Electron 便携包开箱即用说明

这份说明面向最终使用者，不讲打包过程，只讲这份 `Electron` 便携包拿到手之后能不能直接用、需要准备什么、出了问题去哪里看。

## 这是什么

当前发布包名称：

```text
VoxCPM-Studio-Electron-Portable-2.0
```

它是一个可直接迁移的 Windows 桌面目录包，默认桌面界面为：

1. `Electron + React + TypeScript + Vite`
2. 本地后端为包内自带的 `Python HTTP API`
3. 所有运行数据默认写入软件同级 `data/` 目录

## 这份包里已经带了什么

当前包内已经集成：

1. Electron 桌面前端
2. 私有内嵌 Python 运行时
3. 已安装好的 Python 依赖，不依赖目标机器本地 `.venv`
4. FFmpeg
5. VoxCPM 模型文件
6. 默认运行所需的 `data/` 目录结构

换句话说，这不是“需要你自己再建虚拟环境”的半成品，而是已经把运行时打进包里的便携目录。

## 不需要额外安装什么

正常情况下，目标机器不需要额外安装：

1. Python
2. pip
3. 项目虚拟环境 `.venv`
4. CUDA Toolkit
5. FFmpeg

## 仍然需要满足什么条件

这份 `2.0` 包当前是 `CUDA` 版，不是 CPU 版，所以目标机器仍然需要满足这些条件：

1. `Windows x64`
2. 有兼容的 `NVIDIA` 显卡驱动
3. 显卡驱动能够兼容当前包内 `Torch 2.6.0 + cu126`

也就是说：

1. 不需要安装本地 CUDA Toolkit
2. 但仍然需要机器本身有可用的 NVIDIA 驱动
3. 如果目标机器没有 NVIDIA 显卡，或驱动不兼容，这个 CUDA 版包就不能保证直接运行

## 如何启动

推荐直接使用下面这个入口：

```text
VoxCPM Studio.exe
```

它位于便携包根目录。

另外也保留了这些辅助入口：

1. `Launch VoxCPM Studio Desktop.bat`
   作用：显式设置包内 Python、FFmpeg、模型目录，再启动桌面程序
2. `Launch VoxCPM Studio Electron.bat`
   作用：和上面相同，是桌面入口别名
3. `Launch VoxCPM Studio Legacy WebView.bat`
   作用：旧桌面壳回退入口

## 首次使用建议

建议按这个顺序使用：

1. 解压整个目录，不要只拷贝其中几个文件
2. 保持 `app/`、`runtime/`、`models/`、`ffmpeg/`、`resources/`、`data/` 在同一个根目录下
3. 直接启动 `VoxCPM Studio.exe`
4. 进入“运行控制”页，观察本地服务状态

## data 目录是什么

程序运行时会默认使用同级 `data/` 目录保存数据：

1. `data/config/`
   保存配置
2. `data/outputs/`
   保存生成结果
3. `data/lora/`
   保存 LoRA 训练输出
4. `data/cache/`
   保存缓存和后台日志

这意味着升级程序时，只要保留原来的 `data/`，通常就能保留配置和历史结果。

## 如果启动失败，先看哪里

如果桌面程序能打开，但“运行控制”里的服务启动失败，优先查看：

```text
data/cache/electron_backend.log
```

常见判断方式：

1. 如果报的是 `startBackend is not a function`
   说明是桌面壳文件版本不一致，不是模型问题
2. 如果报的是 Python 依赖、模型路径、端口占用
   说明已经进入后端启动阶段，需要继续看日志内容
3. 如果提示 CUDA 或 GPU 不可用
   说明目标机器驱动或显卡环境不满足当前 CUDA 包要求

## 一句话发布说明

如果你要把这份包发给别人，可以直接这样描述：

> 这是一个 Windows 便携版目录包，已内置 Electron、Python、依赖、FFmpeg 和模型文件，正常情况下解压即可运行；但当前版本是 CUDA 版，目标机器仍需具备兼容的 NVIDIA 驱动。

