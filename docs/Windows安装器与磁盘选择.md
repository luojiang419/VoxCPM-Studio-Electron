# Windows 轻量安装器

用户只需分发 `VoxCPM安装器.exe`。安装器从魔搭获取桌面包、独立 Python、固定依赖和模型，校验 SHA-256 后安装；模型仍使用魔搭官方仓库。启动器本身不包含 Electron、Python、CUDA 或模型。

## 安装位置

- 自动选择当前用户可读写、剩余空间至少 25 GiB 的非 C 本地固定分区，优先剩余空间最多的分区。
- 磁盘卡片显示盘符、可用空间和不可选原因。点击非 C 盘后默认安装到 `盘符:\Program Files\VoxCPMStudio`，例如 `D:\Program Files\VoxCPMStudio`；需要时创建目录，不能直接安装在磁盘根目录。自动选择也使用同一规则。
- 非 C 盘的 `Program Files` 无读写权限或有同名目录冲突时，跳过该分区；全部不满足条件时明确提示，可通过“更改”手动选择可写专用目录，不自动改用磁盘根目录。已有本产品的安装继续原位恢复，不迁移数据。
- 仅有 C 分区时，使用 `LocalAppData/Programs/VoxCPMStudio`。存在其他分区但全都不满足条件时，明确提示，阻止新安装，不自动回退 C。释放空间后可重新检测，也可修改专用目录。
- 手动路径仍检查分区、容量、归属和写入权限。已有本产品的准备中/已完成目录可继续恢复，卸载后的重装重新检查容量。
- 所有操作使用当前用户权限，不安装 Windows 系统服务或显卡驱动，不要求管理员权限。

## 界面与图片

`assets/brand/disk-local.png` 为全新薄型机械硬盘透明 RGBA 图片，包含盘片、读写臂、金属底座及柔和投影；安装器内嵌其 256 像素版本。代码生成脚本为 `scripts/build_disk_icon.py`。

选中时图标放大到 117%，同时显示高亮和勾选；切换后原图标复原。悬停、选中、自动横向滚动和准备动画统一使用 `cubic-bezier(0.22, 1, 0.36, 1)`，曲线实现包含 x 的反解。拖动滚动块直接跟随指针。

磁盘区域不启用 Windows 原生横纵滚动条；卡片超宽时仅显示底部自绘横向滚动条，配色跟随深浅主题。支持滚轮、拖动、轨道点击和键盘聚焦后自动滚入视野。

应用和安装器品牌标志由 `scripts/build_brand_icons.py` 生成 SVG、透明 PNG 和多尺寸 ICO；应用 EXE、窗口、快捷方式和应用列表使用相应图标。

## 完成安装与卸载

先验证桌面、运行环境和 GPU 运算，再启动隐藏的 Electron 窗口。API 与渲染层均就绪后，安装器校验当前会话报告，才创建桌面/开始菜单快捷方式并登记 HKCU 的 Windows 卸载入口。第二次启动显示已准备好的窗口。

卸载默认删除应用、下载模型、托管运行时和缓存，保留个人配置、音色、作品和 LoRA；用户明确勾选后才清除个人数据。遇到文件占用时保留卸载入口以便重试；删除过程不递归穿越目录连接。专用归属标记和独占锁防止误接管目录及并发安装。

## 验证与构建

```powershell
python scripts/build_brand_icons.py
python scripts/build_disk_icon.py
python scripts/test_installation.py
python scripts/test_bootstrap.py
python scripts/render_bootstrap.py
```

`render_bootstrap.py` 渲染实际 WinForms 窗口，输出深浅主题、空间不足、多磁盘滚动预览和真实卡片缩放动图；不下载或安装应用。`build_bootstrap.py --demo` 构建可点击的独立演示 EXE。

`scripts/smoke_installation.py` 可显式验收完整握手，借用 `builds/bootstrap-validation` 中的专用测试运行时和模型，并在隔离快捷方式目录和 HKCU 测试键中完成安装、展示窗口和卸载；测试安装根包含 `Program Files`，同时验证空格路径。大型模型不重复下载，借用的运行时 `_pth` 在结束时恢复，目录连接只移除连接本身。证据为 `builds/installer-live-validation/result.json`。

本机 RTX 4070 Ti SUPER/cu126 已完成真实验收。RTX 50/Blackwell 自动分流 cu128 和最低驱动规则已测试；没有 50 系硬件，尚未实机验收。
