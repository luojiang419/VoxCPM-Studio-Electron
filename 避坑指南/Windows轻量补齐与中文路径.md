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
