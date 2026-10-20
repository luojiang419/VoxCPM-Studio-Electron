# 本项目的空间与下载约定

- 本机已通过安装器安装在 `D:/Program Files/VoxCPMStudio`。优先由 `scripts/installed_resources.ps1` 读取注册表定位，直接调用安装目录的模型和环境；不重新下载、不把模型复制到开发项目。安装位置变化时重新读取注册表，不依赖文档中的旧路径。
- `npm start` / `npm run dev` 通过 `start_local.ps1` 使用已安装 Python 和模型运行当前源码，开发数据与安装目录分开，保留用户已有的输出位置设置。安装资源只读，缺失时报告并停止，不自动安装/修复或移除正式软件的模型。
- 常规单元验收执行 `pwsh -File scripts/validate_local.ps1`。实际资源验收用 `-Script scripts/xxx.cjs`（或 `.py`），自动绑定安装资源并保持离线；明确测试缺失模型或模拟资源的脚本加 `-Fixture`，仍禁止大规模联网下载。
- 只有任务明确需要首次安装、网络续传或真实公网升级时，才运行对应联网验收；先说明下载对象、预计体积与本地复用情况。常规文案、布局和提示词修改不重复运行全新 GPU 环境安装。
- 前轮保留的项目根 `models/`、`runtime/music/` 和 `builds/bootstrap-validation/runtime/` 作为备用资源，不再作为本机默认调用或新的模型下载位置。`builds/modelscope-distribution/{assets,wheels}`、`builds/lipsync-assets` 和 `vendor/windows_312_cu126` 是固定离线资源，不因切换调用路径而擅自删除。
- 每次真实下载先核对目标及 `VOXCPM_LOCAL_ASSET_DIRS` 中资源的大小与 SHA256；不使用可写硬链接来共享模型。保留有效断点，完整文件存在时禁止强制重新下载。
- 构建/测试后保留最新正式分发、最新签名快照和必要验证记录；旧安装副本及时清理。用户配置、作品、唯一模型、Git、`.update-private` 私钥及其他工作树源码均保留。
- 清理先生成 `builds/storage-cleanup/plan.json` 并核对绝对路径，再执行 `scripts/cleanup_project.ps1 -Apply`；默认只预览。不得穿透 junction 删除其目标，不清空固定依赖缓存来制造后续重复下载。
