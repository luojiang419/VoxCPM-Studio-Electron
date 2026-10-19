# 035-JVOX品牌更名与更新庆祝弹窗

[CODEX_LONG_TASK_CONTINUE_V3]

状态：更名庆祝弹窗首版已完成，实际 Electron 预览已打开，供用户先行查阅；整体更名发布任务尚未完成。
下一步：根据用户查阅反馈调整设计，随后继续全软件更名、安装器重编译、魔搭更新发布。
TODO：正式名称覆盖；旧安装兼容；弹窗正式接入；安装器编译验收；签名更新包与魔搭发布验收。
最近验证：TypeScript 类型检查、Vite 生产构建、15 项真实 Electron 交互检查通过；已查看浅色、深色及窄窗口截图。
Branch：feat/jvox-studio-rebrand，基于 15ba88a。
阻塞：暂无；按用户“先给我真实演示查阅弹窗页”的顺序，先交付设计预览，暂不发布设计未查阅的新版本。

统一产品名称：`JVOX Studio配音系统`。旧模型标识、数据目录、签名公钥、协议与旧安装识别需要保留兼容，不能机械替换底层 VoxCPM 模型名称和路径。保护两份用户已有便携说明修改；今日 GitHub 检查已完成，按约定只本地提交。

预览验收：实际 React 弹窗在 Electron 中运行；支持深浅主题、键盘焦点、关闭与重新打开、更新按钮的明确演示反馈；小窗口可滚动，减弱动效偏好生效。预览不调用正式更新、下载、安装或发布接口。正式更新安装仍需保留现有验签、独立安装、握手与回滚能力。

## 已完成预览

- `frontend/voxcpm_studio_electron/src/BrandAnnouncementDialog.tsx` 与对应 CSS：暖白/香槟橙、深色适配、立体 J 字声波、微动效、更名前后名称、三项说明与更新/稍后操作。使用原生 HTML dialog 支持模态语义、Escape 和焦点恢复。
- `BrandAnnouncementPreview.tsx` 与对应 CSS：独立交互查阅页；更新按钮明确显示演示反馈，不调用正式服务。`main.tsx` 的 `?preview=jvox-announcement` 可打开，默认软件入口不变。
- `scripts/preview_jvox_announcement.cjs`：使用现有 Electron 运行实际生产构建，隔离 userData、不加载后端或更新服务。重开命令（仓库目录）：`frontend\voxcpm_studio_electron\node_modules\electron\dist\electron.exe scripts\preview_jvox_announcement.cjs`。构建缺失时先在前端目录执行 `npm run build`。
- 验证记录：`builds/jvox-announcement-preview/report.json`；截图 `light.png`、`dark.png`、`compact.png`。15 项覆盖模态、新名称/标题、默认焦点、桌面宽度、Tab、深色、Escape、重新打开、更新演示、延期、关闭、小窗口滚动、减弱动效、运行时异常。
- 仅完成设计预览；尚未更改正式名称、安装文件名、协议、正式版本、签名包、魔搭入口，也未重新编译安装器。正式接入需与现有 C# 原生更新选择及 UpdateService 保持一致，不能将预览反馈冒充实际更新。
