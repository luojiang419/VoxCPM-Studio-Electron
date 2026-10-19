# 035-JVOX品牌更名与更新庆祝弹窗

[CODEX_LONG_TASK_CONTINUE_V3]

状态：用户已要求逐步执行全软件更名、安装器重编译及魔搭发布；本地更名与兼容迁移、签名包、安装器、全部实机验收已完成，正在发布魔搭。
下一步：魔搭上传与匿名回读，激活入口后验证真实公网升级和新旧客户端状态。
TODO：魔搭发布与公网升级验收；最终记录与Git提交。
最近验证：TypeScript 类型检查、Vite 生产构建、15 项真实 Electron 交互检查通过；窗口标题追加修改已通过 JS 语法、生产构建及真实 Electron 主窗口/页面/回退页标题验证。
Branch：feat/jvox-studio-rebrand，基于 15ba88a。
阻塞：无；已授权正式更名、重编译与魔搭发布。必要源码备份 ../backup/v075_20261019_jvox_rebrand_source.zip。

统一产品名称：`JVOX Studio配音系统`。旧模型标识、数据目录、签名公钥、协议与旧安装识别需要保留兼容，不能机械替换底层 VoxCPM 模型名称和路径。保护两份用户已有便携说明修改；今日 GitHub 检查已完成，按约定只本地提交。

预览验收：实际 React 弹窗在 Electron 中运行；支持深浅主题、键盘焦点、关闭与重新打开、更新按钮的明确演示反馈；小窗口可滚动，减弱动效偏好生效。预览不调用正式更新、下载、安装或发布接口。正式更新安装仍需保留现有验签、独立安装、握手与回滚能力。

## 已完成预览

- `frontend/voxcpm_studio_electron/src/BrandAnnouncementDialog.tsx` 与对应 CSS：暖白/香槟橙、深色适配、立体 J 字声波、微动效、更名前后名称、三项说明与更新/稍后操作。使用原生 HTML dialog 支持模态语义、Escape 和焦点恢复。
- `BrandAnnouncementPreview.tsx` 与对应 CSS：独立交互查阅页；更新按钮明确显示演示反馈，不调用正式服务。`main.tsx` 的 `?preview=jvox-announcement` 可打开，默认软件入口不变。
- `scripts/preview_jvox_announcement.cjs`：使用现有 Electron 运行实际生产构建，隔离 userData、不加载后端或更新服务。重开命令（仓库目录）：`frontend\voxcpm_studio_electron\node_modules\electron\dist\electron.exe scripts\preview_jvox_announcement.cjs`。构建缺失时先在前端目录执行 `npm run build`。
- 验证记录：`builds/jvox-announcement-preview/report.json`；截图 `light.png`、`dark.png`、`compact.png`。15 项覆盖模态、新名称/标题、默认焦点、桌面宽度、Tab、深色、Escape、重新打开、更新演示、延期、关闭、小窗口滚动、减弱动效、运行时异常。
- 已完成设计预览与下述主窗口标题修改；其余正式名称、安装文件名、协议、正式版本、签名包、魔搭入口尚未修改，也未重新编译安装器。正式接入需与现有 C# 原生更新选择及 UpdateService 保持一致，不能将预览反馈冒充实际更新。

## 查阅反馈：移除窗口标题 Electron 字样

- 主窗口 `main.js` 的 BrowserWindow 标题、异常回退页面标题和标题正文，以及 `index.html` 的页面标题均统一为 `JVOX Studio配音系统`，防止页面加载后恢复旧标题。
- `node --check` 与 Vite 构建通过。隔离 Electron 调用当前源码中的真实 `createWindow` 与 `loadFallbackHtml`，实际主窗口、页面、回退页标题均为新名称；记录 `builds/jvox-title-validation/report.json`。该标题检查未启动后端与 IPC 服务，因此其中缺少 IPC handler 的日志属于隔离夹具，不代表完整工作台启动验收。
- 本次修改尚未进入安装包或魔搭发布，已安装的旧客户端需要后续打包更新才能生效。

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
