# Windows 轻量补齐与中文路径

## 嵌入式 Python 无法导入临时构建环境

表现：安装 `argbind` 等源码分发包时出现 `BackendUnavailable: Cannot import 'setuptools.build_meta'`，切换国内镜像仍失败。

根因：Windows 嵌入式 Python 的 `python312._pth` 固定导入路径，不读取 pip PEP 517 隔离构建临时注入的 `PYTHONPATH`。镜像不是问题根源。

解决：先在托管 Python 内安装固定版本的 `setuptools`、`wheel` 和 `packaging`，再加 `--no-build-isolation` 安装依赖。PyTorch wheel 用固定下载清单和 `--find-links` 供 pip 使用，显式约束 `torch` 与 `torchaudio` 的 CUDA 后缀，避免被普通 PyPI 换成其他构建。

验证：2026-10-18 全新 Python 3.12.10 环境，从国内源完成依赖安装；`argbind`、`antlr4-python3-runtime`、`jieba`、`oss2`、`crcmod` 均构建为纯 Python wheel；GPU 运算及本地 API 健康检查通过。证据在 `builds/bootstrap-validation/data/cache/runtime-bootstrap.log`。

## wetext/kaldifst 无法读取中文路径

表现：资源文件确实存在，但导入 `wetext` 报 `Error opening input stream ...wetext/fsts/traditional_to_simple.fst`，路径包含 `Electron版本` 等中文。

根因：`kaldifst` 使用 C 运行库的窄字符文件接口；Python 传入 UTF-8 路径，但 Windows C 字符 locale 默认仍使用其他编码。

解决：在依赖导入前执行以下代码，只调整本进程的字符 locale，不更改数字格式或系统语言设置：

```python
import locale
import os

if os.name == "nt":
    locale.setlocale(locale.LC_CTYPE, ".UTF8")
```

启动检查与 `studio_app.py` 都需要配置，避免检查通过、实际后端导入时再次失败。不要仅删去检查中的 `wetext` 导入来绕过问题。

验证：相同中文目录中，原导入稳定报错；设置 `LC_CTYPE` 后 `Normalizer().normalize("今天是2026年10月18日。")` 正常输出中文数字。随后完整 GPU/依赖检查与 API 启动通过。

## 中断后不要只依赖 ready 标记

依赖可能已安装完毕，但模型校验或应用检查尚未完成；也可能 Python 可执行文件缺失而依赖目录仍然完整。重试先检查 Python 核心，再检查真实导入、固定直接依赖版本和 `pip check`。检查通过即可复用；缺失的 Python 核心从验证过的嵌入式 ZIP 恢复，并保留已安装依赖。只有模型、FFmpeg 和环境检查均完成才写 ready，避免反复解压数 GB 的 CUDA wheel。

## 魔搭多个单文件并发提交返回 429

表现：大文件上传完成后，HubApi.upload_file 在 create_commit 返回 `commit lock busy, please try again`；部分对象上传了，但目标路径未成功提交。

根因：同一仓库/分支的多个单文件提交竞争远端提交锁；并发上传数据与并发提交仓库是不同阶段。

解决：先校验已有路径的大小和 SHA-256，拒绝同名不同内容；将缺失资源整理到专用暂存目录，使用 `upload_folder(..., allow_patterns=文件列表, max_workers=4)` 由 SDK 管理批量上传与提交。不要每个工作线程各自 upload_file 提交。已经成功上传的 LFS 对象可复用。

验证：168 项运行时资源批量发布完成；远端文件大小/SHA-256 与匿名范围读取全通过。新 CPU 环境从魔搭下载全部依赖，`pip --no-index --only-binary=:all:` 安装、CPU 运算和 API 健康检查通过。发布不写 public/latest.json。

## 安装完成需要等待渲染层与 API，隔离配置必须早于单实例锁

仅以下载完成或 RuntimeService 的 ready 事件登记安装，仍可能在 API 启动、渲染初始化失败时产生“安装成功”的错误状态。安装模式使用随机会话和当前目录下的受限报告路径，只有 API 和 renderer 都就绪才写最终 ready；原生安装器校验成功后再创建快捷方式和 HKCU 卸载入口。

安装目录独立的 Electron userData 必须在 `app.whenReady` / `requestSingleInstanceLock` 之前设置；否则隐藏准备进程与后续正常启动使用不同单实例身份，无法可靠显示同一个窗口。已安装目录和准备模式采用同一 profile，第二次启动显式 `mainWindow.show()`。

验证：新桌面包真实展开、4070 GPU 环境复检、隐藏窗口 API/renderer 握手、第二次启动显示原窗口、隔离快捷方式/注册和默认卸载保留数据均通过。环境通过且无新增日志时可能没有 runtime-bootstrap.log，验收脚本按实际存在的日志采集，不将可选日志缺失误判为产品故障。

## WinForms 磁盘卡片的原生滚动条会相互挤压

`FlowLayoutPanel.AutoScroll` 在子项略超宽时出现横向滚动条，随后可用高度下降又触发纵向滚动条；最后一张卡片多余的右边距也会制造溢出。系统滚动条配色还会破坏自绘深浅主题。

磁盘区域改为关闭 AutoScroll 的自绘 Panel，按横向偏移排列卡片，只绘制底部主题色轨道和滑块，显式限制滚动边界；焦点、滚轮、轨道点击通过同一贝塞尔动画滚入视野。测试六分区情况下无原生横纵滚动条、首尾卡片完整可达、负偏移和过大偏移均被限制。

## 自绘圆角 Button 仍可能露出原生主题白底

表现：深色主题下，“更改/重新检测”按钮外圆角出现白色矩形残角和锯齿；源码 DrawToBitmap 预览未必与桌面合成结果一致。

根因：继承原生 Button 时，原生主题背景绘制仍可能参与窗口合成；仅设置 FlatStyle/BorderSize、重写 OnPaint 绘制圆角，没有完全控制底层背景。

解决：使用实现 IButtonControl 的自绘 Control，显式清除为父控件背景；圆角背景以 4 倍尺寸绘制后高质量缩小，并缓存预合成位图，避免透明边缘白色杂边。保留 Enter/Escape/空格、焦点与辅助功能点击，禁用状态不得触发。

验证：深浅主题、100/125/150/200% 多尺寸模拟及正常/悬停/按下/禁用/焦点状态的四角像素检查通过，补充实际屏幕合成截图；20 项安装和按钮集成测试通过。图片证据在 builds/installer-validation/button-rendering。

补充：HighQualityBicubic 缩小时默认采样到位图外透明区域，会在浅色父背景上产生额外白色亮边；检查像素 (0,0) 可能正常，内侧 (1,1)/(6,1) 反而变白。设置 ImageAttributes.SetWrapMode(WrapMode.TileFlipXY) 镜像边界后，实际屏幕截图对应像素恢复父背景。按钮背景和开关图像均需设置，回归覆盖整个角落小块而非仅四个端点。

## 普通文件可写不代表卸载 EXE 能替换，管理员测试会掩盖问题

表现：应用已下载展开，但复制 `uninstall.exe` 时返回访问拒绝，默认 `LocalAppData/Programs` 路径在用户机器上不可用。

原探测只创建普通临时文件，没有覆盖 EXE 创建、读写、重命名，以及已有卸载器只读/占用的情况。卸载器写入发生在下载之后，导致失败暴露太晚。

修复：默认 C 盘首选当前用户的 `LocalAppData/VoxCPMStudio`，按序检查多个专用候选；用真实 EXE 测试创建、读写、重命名、删除，并检查已有卸载器独占读写。相同卸载器内容复用，新版本用临时 EXE 原子替换并有限重试；写入提前到下载前，失败保留原文件。不放宽 ACL，不请求管理员权限，不迁移已完成安装的个人数据。

仅在管理员 shell 中测试无法证明无提权可用。本轮增加 SAFER 普通用户令牌测试，明确断言不在管理员组；在 C 盘中文和空格路径设置拒绝写入 ACL，验证候选避让，并完成应用/GPU/API/渲染、HKCU 与快捷方式和卸载保留数据。23 项安装集成测试及真实非管理员验收通过，证据在 `builds/installer-cdrive-validation/`。
