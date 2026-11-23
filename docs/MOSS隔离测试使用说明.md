# MOSS 隔离测试

双击工作树根目录的 `启动MOSS测试版.cmd`。工作区路径为 `G:\app\VoxCPM-2.0.2\MOSS音效开发`，Git 分支为 `feat/moss-audio-studio`。测试版沿用账号登录与授权流程，账号状态、浏览器配置和作品单独保存；没有修改正式安装或发布更新。

## 测试入口

- 左侧「音效设计」：输入中英文描述，或选择自然环境、日常拟音、影视游戏的六组灵感。右侧调整1～30秒时长；高级设置支持10～200步、引导强度、随机种子和负面描述。底部固定播放器负责生成、试听、进度拖动、静音、导出及打开目录。最近作品支持复用设置。
- 「声音设计与克隆」→「生成模型」：选择 `MOSS-VoiceGenerator`，填写试听文案和音色描述。只显示此模型支持的声音设计控件；生成后可保存音色。应用到配音工作台时，固定生成的参考音，使用 VoxCPM 继续克隆。需要原来的可控/极致克隆或LoRA时切回 VoxCPM2。
- 「作品记录」新增音效分区；MOSS语音保存在声音设计分区，记录模型来源。

## 隔离范围与资源

- `builds/moss-test/data`：测试配置、账号状态、工作区与真实生成作品。
- `builds/moss-test/electron-profile-trial`：测试版 Electron profile。
- `builds/moss`：专用源码、两个 Python3.12 环境、MOSS权重及动态模块缓存。音效使用 torch2.9.0+cu128 / transformers4.57.1 / numpy1.26.4；语音使用 torch2.9.0+cu128 / transformers5.0.0 / numpy2.1.0。
- 正式 VoxCPM、音乐和视频资源从注册表所指安装目录只读复用，不复制模型、不升级正式运行环境。
- 本地 frontend/node_modules 使用原开发仓库的目录 junction；没有复制Node依赖。该测试入口仍依赖现有开发资源，不是独立分发安装包。

模型下载使用魔搭 `OpenMOSS/MOSS-SoundEffect-v2.0`、`OpenMOSS/MOSS-VoiceGenerator`、`OpenMOSS/MOSS-Audio-Tokenizer`，备用为 `hf-mirror.com` 的固定版本。`scripts/moss-models.json` 锁定逐文件体积及SHA256；已校验文件复用，64MiB分段续传，下载损坏文件不标记就绪。整套权重约21GiB。初次准备中的已下载官方源文件经相同SHA256校验后复用，最后缺失权重从魔搭补齐。

需要重新检查或补齐时运行 `准备MOSS模型.cmd`。源码来自固定GitHub commit `934d6826b084c46a0d033402174d5f8ac4ed2519`；模型国内源策略不改变PyTorch CUDA官方wheel的来源。已经安装的完整依赖会复用，不会因启动重复安装。

## 运行与恢复

MOSS在独立子进程中推理，任务完成即释放显存。语音将语言模型与音频解码器分阶段放到GPU；音效使用BF16 DiT并保留复数RoPE缓冲区，按所选时长计算。测试入口需要可用NVIDIA CUDA显卡；当前已在RTX4070Ti SUPER 16GB机器验证。长音效和高步数耗时较长，不承诺实时生成。

音效取消会结束完整Windows推理进程树；页面草稿及运行任务ID持久化，切页后可继续查看。后端重启后不存在的任务会提示重启，不无限轮询。推理失败日志保存在该次作品目录的 `inference.log`，不会把失败任务加入作品列表。

## 可复现验收

```powershell
python scripts/test_music_suite.py tests/test_studio_moss.py tests/test_moss_download.py tests/test_studio_works.py tests/test_studio_workspace.py -q -p no:cacheprovider
cd frontend/voxcpm_studio_electron
npm run typecheck
npm run build
```

真实GPU测试：`python scripts/smoke_moss_inference.py --kind voice` 或 `--kind soundeffect`，报告在 `builds/moss-test/real-*.json`。此脚本直接验证隔离推理服务，不修改或跳过桌面授权。

界面验收：`pwsh -File scripts/start_moss_test.ps1 -DebugPort 19346 -Hidden`，然后 `node scripts/smoke_moss_ui.cjs`。该脚本在真实Electron内验证四种分辨率、深浅主题、模型切换及真实媒体播放；任务响应使用夹具，不能将界面夹具宣称为真实GPU生成。报告与截图在 `builds/moss-test`。
