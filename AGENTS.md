# 本项目的空间与下载约定

- 常规开发验收优先执行 `pwsh -File scripts/validate_local.ps1`。需要界面验收时，用该入口的 `-Script scripts/xxx.cjs`（或 `.py`）运行；继承离线模式与本地资源目录。缺少缓存应报告具体文件和大小，不自动转为大规模在线下载。
- 只有任务明确需要首次安装、网络续传或真实公网升级时，才运行对应联网验收；先说明下载对象、预计体积与本地复用情况。常规文案、布局和提示词修改不重复运行全新 GPU 环境安装。
- 模型统一保留在项目根 `models/`，音乐环境在根 `runtime/music/`，音频测试依赖复用 `Electron版本/builds/bootstrap-validation/runtime/`。`builds/modelscope-distribution/{assets,wheels}`、`builds/lipsync-assets` 和 `vendor/windows_312_cu126` 是可离线修复的固定资源，不当垃圾清空。
- 每次真实下载先核对目标及 `VOXCPM_LOCAL_ASSET_DIRS` 中资源的大小与 SHA256；不使用可写硬链接来共享模型。保留有效断点，完整文件存在时禁止强制重新下载。
- 构建/测试后保留最新正式分发、最新签名快照和必要验证记录；旧安装副本及时清理。用户配置、作品、唯一模型、Git、`.update-private` 私钥及其他工作树源码均保留。
- 清理先生成 `builds/storage-cleanup/plan.json` 并核对绝对路径，再执行 `scripts/cleanup_project.ps1 -Apply`；默认只预览。不得穿透 junction 删除其目标，不清空固定依赖缓存来制造后续重复下载。
