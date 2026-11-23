状态：全部完成；独立测试入口已重启，窗口显示「MOSS隔离测试」，本地提交交付。
下一步：用户双击「启动MOSS测试版.cmd」，登录原有账号后测试新生成；已有真实样音可直接试听。
TODO：无本轮剩余开发项；未合并或发布至正式版。
最近验证：后端43项、Electron15项、typecheck/build通过；RTX4070Ti SUPER真实生成24kHz/3.52秒语音与48kHz/5秒音效，三组模型逐文件SHA256通过。
branch/commit：feat/moss-audio-studio；基线 006c748。2026-10-26 Git 检查完成，当前分支无明确 upstream，不自动创建远程；本轮本地提交。
阻塞：无。测试版保留正常账号授权；UI任务绑定用夹具验收，真实GPU通过独立服务验收，不虚称已登录账号完成端到端生成。

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

- `studio_moss.py` 与 `moss_worker.py`：共享既有任务队列、授权及作品入口，两个隔离环境，语音分阶段GPU加载，音效BF16 DiT及复数RoPE保留，按时长计算；Windows取消完整进程树。
- `SoundEffectStudio.tsx` / CSS：描述、六组分类灵感、参数、最近作品；底部固定播放器，四分辨率深浅主题验收。声音设计页模型切换并隐藏不适用控件，MOSS音色转为固定参考后用VoxCPM克隆。
- `prepare_moss.py` / `moss-models.json`：用户追问下载源后改为魔搭优先、hf-mirror备用；原官方源已完成文件同SHA复用，最后3.2GiB音效编码器从魔搭分段完成。
- 真实报告：`builds/moss-test/real-voice.json`、`real-soundeffect.json`；界面报告与截图：同目录`ui-report.json`及`*-light/dark.png`。只将源码与说明提交，不提交模型、账号、生成作品、依赖与日志。
- 旧工作区/作品测试fixture尚未适配新增授权门禁，原403失败已通过测试内注入假授权修正，生产授权逻辑保持启用。
- 启动脚本已修复PowerShell数组拼参及环境继承，独立data/profile；现有正式安装只读复用。详见`docs/MOSS隔离测试使用说明.md`及`避坑指南/048-MOSS在Windows的隔离推理.md`。
- 最终重启后重新通过15项界面验收；实际样音与语音历史已保存在隔离测试数据，播放器可直接试听。主程序和前端已构建，无需再次下载资源；测试窗口保留供用户体验。
