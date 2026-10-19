# 035-JVOX品牌更名与更新庆祝弹窗

[CODEX_LONG_TASK_CONTINUE_V3]

状态：全部完成。首次进入第一屏庆祝页已实现并发布，当前为2.0.3 / 20261019103629；新版安装器基准与魔搭入口同步。
下一步：新用户使用当前基准安装器；已有用户在软件内检查更新。确认过庆祝页的用户继续直接进入工作台。
TODO：无。
最近验证：实际ready-to-show首帧、后端未就绪及资源错误遮挡/交接、深浅主题、确认后跨进程不重复、最终安装/修复/复检、111项一致、同版本跨发布序号本地及真实公网升级、新旧客户端状态均通过。
Branch/Commit：feat/jvox-studio-rebrand；首次庆祝页实现7172135，最终发布验收与本条一同提交，未推送GitHub。
阻塞：无；已授权正式更名、重编译与魔搭发布。必要源码备份 ../backup/v075_20261019_jvox_rebrand_source.zip。

统一产品名称：`JVOX Studio配音系统`。旧模型标识、数据目录、签名公钥、协议与旧安装识别需要保留兼容，不能机械替换底层 VoxCPM 模型名称和路径。保护两份用户已有便携说明修改；今日 GitHub 检查已完成，按约定只本地提交。

预览验收：实际 React 弹窗在 Electron 中运行；支持深浅主题、键盘焦点、关闭与重新打开、更新按钮的明确演示反馈；小窗口可滚动，减弱动效偏好生效。预览不调用正式更新、下载、安装或发布接口。正式更新安装仍需保留现有验签、独立安装、握手与回滚能力。

## 已完成预览

- `frontend/voxcpm_studio_electron/src/BrandAnnouncementDialog.tsx` 与对应 CSS：暖白/香槟橙、深色适配、立体 J 字声波、微动效、更名前后名称、三项说明与更新/稍后操作。使用原生 HTML dialog 支持模态语义、Escape 和焦点恢复。
- `BrandAnnouncementPreview.tsx` 与对应 CSS：独立交互查阅页；更新按钮明确显示演示反馈，不调用正式服务。`main.tsx` 的 `?preview=jvox-announcement` 可打开，默认软件入口不变。
- `scripts/preview_jvox_announcement.cjs`：使用现有 Electron 运行实际生产构建，隔离 userData、不加载后端或更新服务。重开命令（仓库目录）：`frontend\voxcpm_studio_electron\node_modules\electron\dist\electron.exe scripts\preview_jvox_announcement.cjs`。构建缺失时先在前端目录执行 `npm run build`。
- 验证记录：`builds/jvox-announcement-preview/report.json`；截图 `light.png`、`dark.png`、`compact.png`。15 项覆盖模态、新名称/标题、默认焦点、桌面宽度、Tab、深色、Escape、重新打开、更新演示、延期、关闭、小窗口滚动、减弱动效、运行时异常。
- 预览阶段已结束；正式接入、重编译与魔搭发布完成，详见后文。独立安装与验签流程保持兼容。

## 查阅反馈：移除窗口标题 Electron 字样

- 主窗口 `main.js` 的 BrowserWindow 标题、异常回退页面标题和标题正文，以及 `index.html` 的页面标题均统一为 `JVOX Studio配音系统`，防止页面加载后恢复旧标题。
- `node --check` 与 Vite 构建通过。隔离 Electron 调用当前源码中的真实 `createWindow` 与 `loadFallbackHtml`，实际主窗口、页面、回退页标题均为新名称；记录 `builds/jvox-title-validation/report.json`。该标题检查未启动后端与 IPC 服务，因此其中缺少 IPC handler 的日志属于隔离夹具，不代表完整工作台启动验收。
- 此项已进入当前 2.0.3 安装包与魔搭更新，旧客户端升级后生效。

## 正式更名与本地验收

- 正式版本 2.0.3 / 20261019101750；111 项签名应用文件，保留更新协议 product、仓库ID、公钥、appId、包内部名称和原数据路径。软件显示名称统一为 JVOX Studio配音系统，J 字图标与安装器/卸载器同步，新安装入口使用完整新名称。
- 首次工作台就绪后显示正式庆祝弹窗，主按钮为“开启新声，开始创作”，确认持久保存；延期不下载、不伪装更新，下次启动再提示。
- 旧版应用升级创建新版 EXE 兼容副本，旧入口保留；带安装归属记录时替换已签名的新卸载器、图标，并迁移已归属快捷方式和卸载显示名。失败回滚新入口、卸载器和图标，白名单未扩大到任意根文件。
- TypeScript/Vite、39 项 Node、53 项 Python、26 项原生安装集成、9 项引导器、6 项一体版入口，以及原生更新器深浅/缩放状态检查通过。
- 实际最终 EXE 新目录展开、GPU/音频检查、renderer/API 握手、正常检查、删除主程序并损坏 main.js 后修复、再次正常：`builds/unified-validation/1792405129143560500/report.json`。
- 未修改 2.0.2 基准直接升级：`builds/legacy-update-validation/1792405242390/report.json`；新版一次选择启动自动更新：`builds/legacy-update-validation/1792405347397/report.json`。两者真实签名校验、独立安装、移开整个旧前端目录、重启健康、再次 current 和数据保持通过。
- 正式工作台弹窗/侧栏/窗口标题、深浅主题、延期后再提醒、确认后不重复与主题持久化：`builds/jvox-brand-validation/1792405308382/report.json`。未进行模型生成推理。
- 基准包 `builds/正式分发/基准包-2.0.3-20261019101750/`；安装器构建 ff0f78a9e7，131,751,424 字节，SHA256 `4d424cef061e1bee0b4baf8048872d476b5c30e977658f852bb826d22f10ad2a`。源码/签名ZIP/桌面包/实际安装111项一致。
- 发现中文 package.json 在 GBK 默认读取时报错，构建读取显式 UTF-8 后通过。卸载前先删 EXE 会使动态入口解析回退旧名，已改为分别比较新旧固定路径，26项原生检查通过。旧升级冒烟原先只认旧按钮文案、UI重载夹具早于React主题生效的竞态均已按实际界面修正；未跳过实际更新步骤。

## 正式发布及公网验收

- 2026-10-19 北京时间 18:25:33 激活魔搭 `public/latest.json` 与新品牌 README。先上传不可变路径的安装器并匿名完整回读，再上传应用ZIP并匿名完整回读，最后切换最新入口。没有覆盖历史包或重传大型模型/运行时。
- 不可变安装器路径：`installers/2.0.3/20261019101750-ff0f78a9e7/JVOX-Studio-Installer.exe`。应用包 `releases/2.0.3/20261019101750/JVOX-Studio-2.0.3.zip`，3,196,553 字节，SHA256 `133adf1d175b8e017d9a5f99430aebc07a9d731a43da2d201fe0c187b724dbeb`。签名公钥未变。
- 公网未修改2.0.2客户端实际下载、验签、独立安装、移开旧前端后继续、重启API、再次current通过：`builds/update-smoke-1792405554689/smoke-result.json`。
- 公网新流程一次选择后自动下载/安装/重启通过：`builds/update-smoke-1792405617362/smoke-result.json`。原生更新器由实际主进程启动，整个旧前端目录移开后仍独立完成；模型、作品、配置及主动移除HeartMuLa选择保持。该新流程夹具使用当前2.0.3代码并将安装版本标记置为2.0.2以触发升级，目标为真实公开签名包，不冒充历史已发布客户端。
- `public-client-check.json` 核对旧2.0.2 available、新2.0.3 current，均真实验签；README标题、新安装器路径及SHA256一致。安装器与应用ZIP匿名完整回读证据分别是 `repairer-publication.json`、`publication.json`。
- 正式UI补充验证实际关闭主进程并重新启动后确认不重复公告：`builds/jvox-brand-validation/1792405524449/report.json`。
- 最终证据汇总 `builds/updates/2.0.3-20261019101750/release-final-report.json`；基准目录补齐下载地址、发布记录、公网验收与最终验收记录。所有升级/安装测试均只操作隔离副本，隔离进程已关闭；未停止或更新用户现有D盘安装，未进行模型生成推理。
- 今日 GitHub 同步检查已完成，按用户偏好仅本地提交，不自动推送。用户两份便携说明修改保持原样。

## 追加：首次进入的第一屏

用户要求首次进入软件就看到庆祝页面。移除等待后端ready的展示条件，庆祝页使用独立全窗口背景，工作台在继续前隐藏；后台准备与rendererReady握手照常运行。资源准备弹窗持续订阅进度但延后显示，继续后恢复最新准备/错误状态。主窗口等待首帧就绪再展示，庆祝模态在绘制前打开，避免先闪出空窗口或工作台。确认记录键保持不变，已确认用户不重复展示。

- 实际主程序延迟后端，`ready-to-show` 首帧验证庆祝模态已打开、工作台隐藏、独立背景存在；资源错误在庆祝页期间不抢占，点击后显示待处理错误并衔接真实API启动，确认后跨进程不重复：`builds/first-entry-validation/1792406086171/report.json`。
- TypeScript/Vite及JS语法通过。版本保持2.0.3，最终候选发布序号20261019103629；原公开2.0.3 / 20261019101750保持包身份的同版本升级本地通过：`builds/legacy-update-validation/1792406208565/report.json`。未把当前版本/发布号清零。

- 最终安装器构建 `1d02efcb80`：实际全新安装、准备期间窗口隐藏、renderer/API握手、正常检查、损坏修复及复检通过：`builds/unified-validation/1792406252258165500/report.json`。正式安装副本深浅主题、确认持久化和真实进程重启通过：`builds/jvox-brand-validation/1792406328346/report.json`。111项源码/签名ZIP/桌面包/实际安装一致并冻结 `builds/正式分发/基准包-2.0.3-20261019103629/`。

- 2026-10-19北京时间18:40:38激活魔搭最新入口；安装器及应用ZIP均先匿名完整回读校验再激活。当前安装器不可变路径 `installers/2.0.3/20261019103629-1d02efcb80/JVOX-Studio-Installer.exe`，131,751,424字节，SHA256 `b9afa45e399848e369959462a0eb95847d113ae0e53af1c8676f5acec0cea62f`；应用ZIP 3,196,768字节，SHA256 `fb9e91e49dae7e65ee487cbddc4222490797987375a9f007865565b2f9be6ea0`。
- 真实公网同版本升级保留原公开2.0.3 / 20261019101750客户端的版本及发布标记，实际下载本次包、验签、独立安装、移开旧前端后继续、重启/API及再次current通过，模型/作品/功能选择保留：`builds/update-smoke-1792406464862/smoke-result.json`。
- 公网旧发布available、新发布current、首屏说明/安装器链接/哈希通过：新快照 `public-client-check.json`。最终证据 `builds/updates/2.0.3-20261019103629/release-final-report.json`，基准包补齐下载地址、发布与验收记录。
- 本轮没有修改更新协议、签名公钥或安装事务，复用上一轮相关核心回归，补充当前界面/主窗口时机及最终分发实机验证。全部操作限定本次隔离测试目录，未更改用户现有安装；保留用户两份便携说明修改，不推送GitHub。
