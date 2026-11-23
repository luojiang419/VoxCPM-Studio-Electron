# VoxCPM Studio Electron

这是 VoxCPM Studio 的 Electron 原生桌面前端工程。

## 依赖关系

这套前端不是独立替代官方 VoxCPM 推理项目，而是桌面层封装：

1. 官方 VoxCPM 项目负责模型、推理和语音能力
2. 当前 Electron 工程负责桌面壳、前端交互和本地 API 联动

官方项目地址：

- [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)
- 模型页：[openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2)

## 官方 VoxCPM 安装方法

根据官方项目 README，最直接的安装方式是：

```bash
pip install voxcpm
```

官方环境要求：

1. Python `>= 3.10`
2. PyTorch `>= 2.5.0`
3. CUDA `>= 12.0`

如果希望从 ModelScope 下载模型到本地，可按官方说明额外安装：

```bash
pip install modelscope
```

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

## Electron 前端安装方法

```bash
cd Electron版本/frontend/voxcpm_studio_electron
npm install
```

## Electron 前端构建

```bash
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

## 联系作者

欢迎友好交流，添加时请注明来意。

1. QQ：`419773176`
2. QQ邮箱：`419773176@qq.com`
3. 微信：`15085152352`
