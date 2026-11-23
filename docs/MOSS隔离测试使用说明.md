# MOSS 隔离测试

双击工作树根目录的 `启动MOSS测试版.cmd`。工作区路径为 `G:\app\VoxCPM-2.0.2\MOSS音效开发`，Git 分支为 `feat/moss-audio-studio`。测试版沿用账号登录与授权流程，账号状态、浏览器配置和作品单独保存；没有修改正式安装或发布更新。

2026-10-26已按用户要求合并到主项目 `G:\app\VoxCPM-2.0.2\Electron版本` 的当前开发分支 `feat/unified-license-demo`。主项目继续使用原来的 `npm start` 入口；`builds/moss`通过目录junction复用上述工作树的模型和独立环境，两个MOSS模型已检查就绪。不要删除或归档承载这些资源的独立工作树。原隔离测试入口、样音和数据仍保留，不会自动混入主项目现有作品或账号。

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

MOSS在独立子进程中推理，任务完成即释放显存。语音将语言模型与音频解码器分阶段放到GPU；音效沿用官方模型加载精度和完整30秒内部生成流程，再裁到所选时长，默认100步，不额外降低DiT精度或缩短内部长度。音效启用上游CPU offload分阶段移动组件，保留相同权重与计算，避免16GB显卡因所有组件同时驻留而换页。此前缩短latent长度的提速方式已撤回，它会导致部分描述生成近乎静音。测试入口需要可用NVIDIA CUDA显卡；当前已在RTX4070Ti SUPER 16GB机器验证。

保存前检查原始波形与PCM导出波形，主服务入库前再检查一次；无效数值、纯直流和近乎静音均报错，不会显示为成功作品。该检查避免坏音频被当作成功，声音是否符合具体创作要求仍由试听确认。

质量优先实测：RTX4070Ti SUPER 16GB，以用户原描述「燧发枪补充弹药和击发」、种子1247、100步、CFG4生成10秒/48kHz音效，全流程约66秒，GPU分配峰值约9.9GiB。主项目作品「燧发枪 · 质量优先验证」保留供试听；先前的原静音文件未覆盖。

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
