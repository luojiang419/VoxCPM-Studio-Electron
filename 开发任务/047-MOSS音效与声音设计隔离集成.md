状态：已修复；按用户质量优先要求恢复官方精度、完整30秒内部生成及默认100步，采用不改变计算的CPU分阶段加载。主项目已重启后端并选中新样音。
下一步：用户在底部播放器试听「燧发枪 · 质量优先验证」；后续生成使用修复后的质量配置。
TODO：无本轮剩余开发项；未推送或发布安装更新。
最近验证：53项MOSS/作品/工作区回归、44项运行时、11项视频资源检查通过。真实主项目API原描述/种子1247/100步/CFG4生成48kHz/10秒；AC RMS约0.05937，流程约66秒，GPU分配峰值10120.9MiB。浏览器实际解码有正常交流信号，播放器非静音、音量1。
branch/commit：fix/moss-silent-output在主项目实现并本地提交后快进合回feat/unified-license-demo；具体实现见本文件所在提交。2026-10-26已完成当日Git检查，本轮不自动推送。
阻塞：无。本轮已沿用用户当前有效授权，通过真实主项目API完成生成与浏览器解码验证，不使用生成夹具。

[CODEX_LONG_TASK_CONTINUE_V3]

## 目标与验收

- 新增「音效设计」导航；描述编辑与场景灵感、生成参数、作品列表；沿用既有深浅色卡片与底部固定播放器。
- 声音设计与克隆页新增模型选择：VoxCPM2、MOSS-VoiceGenerator；MOSS 仅用于声音设计，不显示无效的 LoRA/CFG/参考音控件。
- MOSS 音效 v2 采用 48kHz、最长30秒接口；语音采用官方 VoiceGenerator 自然语言音色描述接口。共享任务队列、授权及作品记录；生成退出时释放独立进程显存。
- 开发源码、Electron profile、配置、作品、MOSS 环境与权重均隔离；只读复用正式 VoxCPM 资源；不发布、不更新正式软件。
- 交付可重复启动脚本，类型检查、相关后端测试、真实生成与界面布局实测记录。

## 上游依据

- https://github.com/OpenMOSS/MOSS-TTS
- moss_soundeffect_v2/README.md：Python3.12、transformers4.57、torch2.9、numpy1.26 独立环境。
- docs/moss_voice_generator_model_card.md：AutoProcessor + AutoModel，instruction/text，官方采样参数 1.5/0.6/50/1.1。
- 音效权重约10.46GiB，VoiceGenerator约3.95GiB，音频Tokenizer约6.61GiB。下载前检查已有安装目录，本机无对应模型。

## 实现与验证

- `studio_moss.py` 与 `moss_worker.py`：共享既有任务队列、授权及作品入口，两个隔离环境，语音分阶段GPU加载，音效已恢复官方精度及完整30秒内部生成后裁切；Windows取消完整进程树。
- `SoundEffectStudio.tsx` / CSS：描述、六组分类灵感、参数、最近作品；底部固定播放器，四分辨率深浅主题验收。声音设计页模型切换并隐藏不适用控件，MOSS音色转为固定参考后用VoxCPM克隆。
- `prepare_moss.py` / `moss-models.json`：用户追问下载源后改为魔搭优先、hf-mirror备用；原官方源已完成文件同SHA复用，最后3.2GiB音效编码器从魔搭分段完成。
- 真实报告：`builds/moss-test/real-voice.json`、`real-soundeffect.json`；界面报告与截图：同目录`ui-report.json`及`*-light/dark.png`。只将源码与说明提交，不提交模型、账号、生成作品、依赖与日志。
- 旧工作区/作品测试fixture尚未适配新增授权门禁，原403失败已通过测试内注入假授权修正，生产授权逻辑保持启用。
- 启动脚本已修复PowerShell数组拼参及环境继承，独立data/profile；现有正式安装只读复用。详见`docs/MOSS隔离测试使用说明.md`及`避坑指南/048-MOSS在Windows的隔离推理.md`。
- 最终重启后重新通过15项界面验收；实际样音与语音历史已保存在隔离测试数据，播放器可直接试听。主程序和前端已构建，无需再次下载资源；测试窗口保留供用户体验。

## 合并到主项目

- 用户明确要求合并后，主工作树`Electron版本`保持现有开发分支`feat/unified-license-demo`，执行`git merge --ff-only feat/moss-audio-studio`，无冲突，包含完整27文件实现。
- 原有`docs/WINDOWS_PORTABLE_GUIDE.md`及`docs/Windows便携打包说明.md`的未提交改动保留，合并前后SHA256一致，未纳入本任务提交。
- 主项目`builds/moss`为指向`../MOSS音效开发/builds/moss`的目录junction，复用已校验权重和两个独立环境，不复制、不重新下载。主项目默认MOSS资源路径检查已通过。此资源目标仍在独立工作树中，暂不归档或删除该工作树。
- 本轮只合并与构建主项目源码，不修改已安装程序，不将隔离测试账号或样音写入主项目现有数据。

## 静音修复与质量优先

- 原因：此前接入为提速将完整30秒latent改为输出时长加1秒。用户原描述10秒输出变为内部11秒，结果仅8个PCM值、AC RMS约1.49e-5，原RMS>1e-5检测未覆盖；相同描述、种子和参数恢复官方30秒内部长度后即正常出声。
- 按用户追加要求，移除手动BF16 DiT转换，保留官方加载行为及100步默认采样。官方精度所有组件同时驻留时本机接近16GB且换页；启用上游CPU offload按阶段移动组件，不减少权重精度、采样或时长。
- `moss_audio.py`在原波形、PCM导出及服务入库前检测NaN/Inf、DC和近乎静音；无效音频不写成功result索引。测试允许长静音中的短促枪声、安静环境与反相立体声，避免只按全段平均响度误判。音效取消入口已补入共享队列白名单。
- 原静音文件保留不覆盖。主项目真实新作：`../data/outputs/soundeffects/b7fbe91c79ef435aa618f2fbb69cdf01/audio.wav`，名称「燧发枪 · 质量优先验证」。用户原文案、种子、时长、步数与CFG保持不变。
- 证据位于`builds/moss-silence-diagnostics/{comparison.json,quality-final-result.json,browser-audio-check.json}`。浏览器实际解码RMS约0.05937，已将底部播放器选到该作品，未自动播放。
