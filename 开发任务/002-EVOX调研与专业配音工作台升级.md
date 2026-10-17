# 002-EVOX调研与专业配音工作台升级

[CODEX_LONG_TASK_CONTINUE_V3]

- 当前状态：功能、源码与便携版实测全部完成；待本地Git提交记录。
- 下一步：用户直接运行现有便携目录的 VoxCPM Studio.exe；后续发布可复用已生成签名包。
- TODO：功能项全部完成，正在收尾Git交付。
- 最近验证：49项自动化检查通过；真实CUDA两角色、单段重做、极致克隆、整片/字幕/ZIP通过；源码与便携版界面、保存和重启恢复通过。
- branch：feat/dubbing-production-studio；起点 2274c47。
- 阻塞：暂无；作者公开演示可访问，未取得EVOX本体，不宣称测试其桌面内部实现。

## 目标与范围

把现有 VoxCPM 从单条生成工具升级为可保存的多角色配音工程：角色音色管理、台词自动识别/分段、逐段生成与重做、真实任务进度、历史与音色库、合成试听、WAV/SRT/分段ZIP导出。原创深色专业布局：宽侧栏、顶栏、中央台词与右侧角色参数、底部试听输出。现有单条克隆/设计、批量、LoRA、运行控制与更新保留并融合。

## 调研证据（REA）

- 作者来源：https://www.bilibili.com/video/BV1XBczzXEdt/，作者老鹰的AI思考。
- ev_f0bf34c325fd5829bbfb5c4880f903959fdfb3e37c89a7a0370e2778e4f80011：页面正文明确说明四列变三列、统一文案区、按字数分段、{角色}识别、音色应用、音效停顿、按角色/目录导出及主题切换。证据为公开作者陈述，不是本体功能实测。
- ev_c903f275a224ed2e75048fc54fd0cd695c19c8735ddd04e49968d9a355092ac5：公开视频页面截图，观察到深色侧栏、功能入口卡片与工程概览；视频免费预览限制，不推断未看见的视图。
- ev_1606a6fbd0e21bca105f80bb2ee548ca3f988f5a1eef6dce9605e706aee2a1ac：360搜索找到作者教程与配音/声音管理器资料。
- ev_59dd29bdc5c0f77aab7e4438d41eb9f028f634c4b32b62c5b0ae173f906dd240：12d.tv同名营销页含BVxxxxxx、shop.yourdomain占位链接，不认定为官方来源、不作为实现依据。
- 百度/Google/搜狗被验证码阻断，未绕过；已通过作者公开B站资料完成核心调查。

## 实现与验收

1. 项目/角色/音色/历史保存在 data/workspace，原子写入；模型生成保持已有单线程队列。
2. 能导入角色文案，分配音色，逐段/整篇生成、重试失败或过期段落；编辑后不误用过期音频。
3. 真实音频拼接含段间停顿，SRT以实际生成时长计算；ZIP包含分段、整片和清单。
4. 实际启动桌面，完成两角色配音、单段重做、导出、重启恢复；检查1366宽度、长文、空状态和错误状态。
5. 不创建无实现支撑的数字人或插件占位功能；不冒称在所有方面超过EVOX，升级聚焦本地配音工作流。

主要模块：src/voxcpm/studio_workspace.py、studio_api.py；Electron前端ProductionStudio组件、CSS及App导航；打包/发布后端覆盖层；测试与使用说明。

修改前备份：主目录 backup/v062_20261017_dubbing_studio_source.tar.gz。
保护原有未提交文件：docs/WINDOWS_PORTABLE_GUIDE.md、docs/Windows便携打包说明.md。


## 最终交付与验证

- 已实现全新深浅主题布局：宽导航、顶部引擎状态、中央台词、右侧角色/音色/参数、底部试听与导出。
- 支持持久项目、TXT/SRT/角色文案导入、自动分段、段落增删复制排序与停顿、角色独立生成配置、音色收藏/应用、作品历史。
- 生成复用原单线程队列，逐段真实进度、段间停止、失败续生成、单段重做；指纹保护过期声音和过期整片。
- 导出完整双声道WAV、实际时间SRT、分段WAV、分角色WAV及清单ZIP；音量/声像与WAV背景音乐混音在导出时生效。
- 原有设计/克隆、批量、ASR、LoRA、运行控制与自动更新均保留。
- 修复实际模型验证发现的旧问题：未请求降噪也加载过期zipenhancer。现在按最终denoise参数加载，缓存区分实际增强状态，失败明确提示。

### 实际测试结果

1. TypeScript typecheck、Vite生产构建通过。
2. Python新工作台与降噪回归14项、原API7项、更新事务24项全部通过；Node更新4项通过，合计49项。打包PowerShell语法解析、Python编译通过。
3. 真实CUDA运行VoxCPM2，两角色配置生成后只重做第一段，第二段音频路径不变；再使用自产音频作为参考进行极致克隆，实际成功。
4. 最终音频48000Hz、双声道、7.02秒；WAV、SRT与ZIP文件结构/时间轴通过。报告：builds/production-validation/real-inference.json。
5. 原始与便携版Electron通过CDP真实加载：导入角色文案、复制台词、自动保存、音色库、作品记录、实际播放（readyState4且playing=true）、点击导出、重启后恢复工程；无JS异常。
6. 1560x980、1366x768、1180x760及浅色主题截图复核，无横向溢出。报告：builds/production-validation/ui-result.json；README截图：docs/screenshots/production-studio.png。
7. 后端root源码与Electron/backend/voxcpm的3个覆盖文件字节一致；打包和更新构建均优先使用覆盖层。

### 本机交付

- 程序：builds/VoxCPM-Studio-Electron-Portable-2.0.1/VoxCPM Studio.exe；保留目录名，内部版本仍2.0.2，不为调试增加正式版本。
- 本地签名包：builds/updates/2.0.2-20261017131416/VoxCPM-Studio-2.0.2.zip。
- 发布序号：20261017131416（UTC）；大小586994字节；SHA256：864eb97f0365936a52f833d369ec28d84398c50b47a0465b792f0d09febf7255。
- 已对便携包68个应用文件核验，全部匹配本地签名清单。覆盖前备份在该便携包 data/cache/updates/bootstrap-20261017-211418-550232。
- 新功能本轮只交付本机与本地签名包，尚未上传魔搭；远端仍保留上轮已验证的更新版本。未重建大型全量运行时压缩包。
- 测试数据均位于builds/production-validation，不写入正式用户工程。真实模型产生的测试音频与截图已保留可复核。
- Git按当日规则仅本地提交；原有两个便携文档修改仍保留，不纳入本任务。

### 用户指定视频补充

https://www.bilibili.com/video/BV18Kep6TEim/ 为本轮主参考。REA ev_42183bf4dfcc97f05c6aadb34b20bbbf09ea17227f3fe1a4564e70334c000dd4 与 ev_07b367ba024ef45bd69bff28ba3cbc57c7750c55f92b17e7483ec969cbe0cb82 记录标题、作者与约4秒/20秒公开视频预览。可见三列文案/声音/角色与本地参考音频挑选；未登录、未绕过试看限制，不声称已测试EVOX本体。来源、实测和推断范围在docs/EVOX调研与配音工作台.md分别说明。
