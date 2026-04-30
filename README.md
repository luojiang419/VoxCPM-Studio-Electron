# VoxCPM Studio Electron

这是 `VoxCPM Studio` 的 Electron 原生桌面版源码仓库目录，包含：

![VoxCPM Studio Electron 首页预览](./docs/screenshots/homepage-hero.png)

一个面向中文本地工作流优化的 `Electron + React + TypeScript + Vite` 桌面前端，连接本地 `Python HTTP API`，覆盖：

1. 语音工作台
2. 运行控制
3. 概览
4. 批量生成
5. 训练
6. 设置

1. `frontend/voxcpm_studio_electron`
   - Electron 主进程
   - React + TypeScript + Vite 渲染层
   - 本地 Python HTTP API 桌面联动逻辑
2. `scripts`
   - Windows 便携包构建脚本
3. `docs`
   - 便携包、打包和使用说明

## 界面预览

首图展示当前首页，下面是其他页面截图：

![首页界面](./docs/screenshots/homepage-hero.png)

| 页面截图 1 | 页面截图 2 |
| --- | --- |
| ![页面截图 1](./docs/screenshots/page-01.png) | ![页面截图 2](./docs/screenshots/page-02.png) |
| ![页面截图 3](./docs/screenshots/page-03.png) | ![页面截图 4](./docs/screenshots/page-04.png) |

![页面截图 5](./docs/screenshots/page-05.png)

## 为什么做这个项目

官方 `VoxCPM` 项目已经提供了很强的模型能力、Python API、CLI、在线 Demo 和文档体系。  
这个仓库不是替代官方，而是把官方能力包装成一套更适合中文本地工作流、Windows 桌面使用和便携分发的前端方案。

如果你是：

1. 不想每次都进命令行手动拼参数
2. 想把生成、批量、训练、设置放在统一桌面界面里
3. 想把项目交给非开发者直接使用
4. 想做本地便携包、离线包或团队内部工具分发

那这套 Electron 版本会比直接使用官方 CLI / Demo 更顺手。

## 与官方部署相比的亮点差异

| 维度 | 官方 VoxCPM | 当前 Electron 项目 |
| --- | --- | --- |
| 核心定位 | 模型、推理、API、CLI、Web Demo | 桌面化工作流封装与本地交互体验 |
| 主要使用方式 | Python API、命令行、在线演示 | Electron 桌面前端 + 本地 Python HTTP API |
| 面向用户 | 开发者、研究者、熟悉命令行的用户 | 创作者、运营、测试、需要图形界面的普通使用者 |
| 启动方式 | 代码调用、命令行、在线页面 | 桌面程序直接启动 |
| 参数操作 | 主要通过代码 / CLI 参数传入 | 表单化交互、可视化选择、按钮式操作 |
| 运行控制 | 通常依赖外部终端观察 | 内置运行控制页、服务状态、资源监控 |
| 批量处理 | 需要命令或脚本组织 | 独立批量页面，带说明和归档入口 |
| 本地数据组织 | 由使用者自行管理路径 | 默认同级 `data/` 目录统一沉淀配置、输出、缓存、LoRA |
| 便携分发 | 需自行封装环境 | 已提供 Windows 便携包构建脚本 |
| 面向中文桌面体验 | 不是主要目标 | 是主要优化方向 |

## 这套前端为什么更优雅

这里说的“更优雅”，不是模型比官方更强，而是**使用过程更顺**：

1. 把“模型能力”翻译成“桌面可操作工作流”。
   官方项目强调能力完整和接口开放；这个仓库强调把这些能力变成一套可点击、可观察、可回看的桌面流程。
2. 把分散操作收敛到统一界面。
   生成、批量、训练、设置、运行控制不再分散在脚本、命令行、日志窗口里。
3. 把环境问题尽量前移处理。
   通过便携打包、包内 Python、运行控制、自检脚本，尽量减少“装好了但不会用”的落差。
4. 把本地状态显式展示出来。
   服务是否在跑、输出目录在哪、日志在哪、显存用了多少，都能直接看到，而不是让用户自己猜。
5. 把中文用户最常见的桌面操作补齐。
   例如音频预览、输出目录打开、预设词、批量占位说明、运行页按钮和本地图标联动，这些都更符合日常工具习惯。

## 更适合哪些使用场景

这套 Electron 前端尤其适合：

1. 中文创作场景：需要反复试听、调参数、改文本、导出结果
2. 团队内部交付：希望把模型工具交给不写代码的人直接使用
3. Windows 本地部署：希望做开箱即用或便携包分发
4. 运营 / 内容生产：需要批量生成、统一风格、归档结果
5. 微调与实验：希望把训练和推理工作流收进一个桌面入口

## 重要说明

这个项目的价值在于：

1. **前端体验更完整**
2. **本地桌面工作流更顺滑**
3. **更适合打包分发和交给非开发者使用**

但它依然建立在官方 `VoxCPM` 模型与推理能力之上。  
如果你想研究模型本身、训练原理、API 细节和论文实现，仍然应该首先阅读官方仓库与官方文档。

## 目录结构

```text
Electron版本/
  frontend/
    voxcpm_studio_electron/
  scripts/
    build_windows_electron_bundle.ps1
  docs/
```

## 官方项目地址

官方 VoxCPM 项目地址：

- [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)

官方模型主页：

- [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2)

## 官方项目安装方法

根据官方项目当前 README，最直接的安装方式是：

```bash
pip install voxcpm
```

环境要求：

1. Python `>= 3.10`
2. PyTorch `>= 2.5.0`
3. CUDA `>= 12.0`

一个最小可运行示例：

```python
from voxcpm import VoxCPM
import soundfile as sf

model = VoxCPM.from_pretrained(
  "openbmb/VoxCPM2",
  load_denoiser=False,
)

wav = model.generate(
    text="VoxCPM2 是目前推荐使用的多语言语音合成版本。",
    cfg_value=2.0,
    inference_timesteps=10,
)
sf.write("demo.wav", wav, model.tts_model.sample_rate)
```

如果你希望优先从 ModelScope 下载模型到本地，可按官方说明先安装：

```bash
pip install modelscope
```

官方中文说明可继续参考当前主项目中的：

- [README_zh.md](../README_zh.md)

## Electron 前端安装方法

这套 Electron 源码仓库是 `VoxCPM Studio` 的桌面前端和打包脚本，不替代官方 VoxCPM 推理项目本身。  
也就是说：

1. 官方 `VoxCPM` 负责模型与推理能力
2. 这个仓库负责 Electron 桌面壳、前端交互、本地 API 联动和便携打包

### 前端源码安装

```bash
cd frontend/voxcpm_studio_electron
npm install
```

### 前端构建

```bash
npm run build
```

### 本地启动

如果本机 Electron 运行环境已就绪，可直接运行：

```bash
npm start
```

如需指定 Python 或模型目录，可使用环境变量：

```bash
VOXCPM_PYTHON_EXE=/path/to/python VOXCPM_MODEL_DIR=/path/to/model npm start
```

如果你在 Windows 侧配套使用本项目主目录中的后端代码，通常需要让 `desktop_api.py` 和模型目录可被当前前端工程访问。

## Windows 便携打包

Windows 下推荐使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_electron_bundle.ps1
```

更多说明见：

1. [docs/Windows便携打包说明.md](./docs/Windows便携打包说明.md)
2. [docs/Electron便携包开箱即用说明.md](./docs/Electron便携包开箱即用说明.md)
