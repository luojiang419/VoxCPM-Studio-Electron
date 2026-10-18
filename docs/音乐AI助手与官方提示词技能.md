# 音乐AI助手与官方提示词技能

在VoxCPM的「音乐创作」中输入故事、情绪、已有提示词或歌词，选择模型后可点击「AI创作/优化」，也可以直接点击「生成音乐」。默认开启生成前的AI创作与适配；已适配或手动编辑的当前草稿直接复用，不重复请求助手。

在「设置 → AI助手」填写服务地址、接口类型、模型名称和API Key。单个启用的助手保存后自动设为默认，创作页不再重复显示助手选择、配置和自动优化开关；自动优化偏好也统一在设置页管理，旧草稿的助手覆盖不再影响音乐创作。支持Chat Completions与Responses兼容接口；也可导入已有minimax的`assistant-providers.json`。导入不会修改原配置，密钥继续使用当前Windows账户加密，前端只显示是否已保存。

## 实际集成的官方规则

| 音乐模型 | 来源 | 最终输入 |
| --- | --- | --- |
| ACE-Step 1.5 XL Turbo | [官方acestep-songwriting](https://github.com/ace-step/ACE-Step-1.5/tree/main/.claude/skills/acestep-songwriting) | 风格caption、分段歌词；速度、调式、拍号、语言和时长单独编译为ComfyUI参数 |
| MiniMax Music 3 | [官方music-caption-rewriter](https://github.com/MiniMax-AI/MiniMax-Music3/tree/main/skills/music-caption-rewriter) | Global Metadata、Vocal Details、Arrangement三段式caption，与歌词分开 |
| YuE2-3B | [官方yue2-music](https://github.com/multimodal-art-projection/YuE/tree/main/skills/yue2-music) | style与lyrics，默认full乐谱规划；不虚构negative_prompt、参考歌手或独立bpm字段 |
| HeartMuLa 3B | [官方heartlib文档与示例](https://github.com/HeartMuLa/heartlib) | 小写英文逗号标签tags与独立lyrics；官方推理还会将英文歌词转小写 |

HeartMuLa来源是官方文档适配，没有标成不存在的官方技能。软件附带固定版本和SHA256清单，不在创作时搜索网页或自动执行第三方技能脚本。

MiniMax完整文本库包含18个风格族与1000个模板。运行时先形成音乐简报，再读取官方路由、1至2个索引及最多3个模板；不会把整个文本库塞进AI上下文，也不照抄模板歌词或未要求的声线、速度、调式。

## 创作与修改

- 「保留已有歌词原文」默认开启。需要AI改词时关闭此选项；纯音乐会使用空歌词。更换模型时，相同需求下保留已写好的歌词与作品名称。
- 速度、调式、拍号、语言等明确参数优先。留空时由AI推断或采用当前模型接口需要的默认值，最终提交字段可在「查看最终模型输入与规则来源」中检查。
- 最终风格描述、歌词与标题都可编辑。更换模型或改变需求后，界面提示重新适配；更新官方规则版本后也会重新检查。
- 可以在AI创作前填写作品名称，用户名称优先，改名不触发重复AI创作。生成后的实际WAV及另存默认名称使用作品名；Windows非法字符会替换，保留名与过长名称会安全处理。同名作品各自保存在独立目录，不相互覆盖，已有作品不改名。
- AI未配置、超时或输出格式不正确时会明确报错，不把原始需求冒充成成功优化。可以关闭AI后手动填写最终输入。
- 生成失败或取消时保留已完成的AI稿；生成成功后保存实际输入、模型、来源、时长和耗时。播放接口支持Range，进度条可以拖动。

## 模型与运行方式

音乐模型卡片展示简短特色与适用方向，后端设置不在创作页显示。ACE与MiniMax使用ComfyUI原生音频节点，默认在点击生成后自动启动当前任务的独立进程；YuE2使用已验证的社区运行接口，HeartMuLa使用heartlib独立进程。任务成功、失败或取消后退出所属进程，释放推理模型占用的内存与显存，权重文件继续复用。音乐推理与配音、视频任务按队列串行运行。

旧版显式指定的共享ComfyUI地址仍兼容，软件不关闭外部服务；仅在队列允许时请求卸载模型，取消也只处理自己的任务。全机桌面及其他软件的内存/显存不属于本任务的释放范围。

当前YuE2运行接口尚未集成官方纯音乐转谱流程。可以创作并导出相应提示词；生成纯音乐时请选择ACE或MiniMax。这里也不提供参考歌手克隆、音频翻唱、逐音跟谱或局部重绘等未接入的能力。

模型大小与是否已安装会显示在模型卡片中。未安装的模型可点击「启用并补齐此模型」，沿用启动器的国内源校验和准备流程。用户移除状态、共享文件保护以及现有ComfyUI模型不变。

## 开发与发布

核心代码位于`backend/voxcpm/music_prompts.py`、`studio_assistant.py`、`studio_music.py`及前端`MusicStudio.tsx`。官方文本在`backend/voxcpm/music_skills/`，通过`scripts/sync_music_prompt_skills.py`按固定提交获取；更新资料时维护版本与清单。

轻量构建和跨版本更新必须持续携带完整的音乐技能文本与新增后端模块。文本库约2.2MB，不含音乐权重、Python或CUDA；既有音乐运行包仍按原固定清单复用。2026-10-18已随2.0.2 / 20261018123054发布并激活魔搭更新，详情见[自动更新说明](自动更新说明.md)。
