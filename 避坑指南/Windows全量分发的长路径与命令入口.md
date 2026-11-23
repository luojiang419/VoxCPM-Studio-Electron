# Windows 全量分发的长路径与命令入口

表现：完整环境的深层 Python 文件在解压暂存目录中超过 260 字符，原生安装出现 PathTooLongException；仅关闭 .NET 长路径限制后又出现 DirectoryNotFoundException。把环境复制到另一目录后，pip/torchrun 等命令还可能指向原安装的绝对 Python 路径。

根因：短安装路径叠加暂存 GUID、运行时目录及模型框架层级后仍可能超长。.NET 路径处理开关与 Windows 程序清单的 longPathAware 需要配合。wheel 生成的 Windows EXE 入口把解释器绝对路径写进了启动器，复制整个环境不会自动重定位。

解决：全量安装器启用 .NET 现代路径处理并使用 `bootstrap/long-path.manifest` 编译；不更改系统注册表。全量大清单放宽解析长度，安装标记只记录根应用文件，运行时与模型依照已有所属目录卸载，避免把十三万条依赖路径写入安装身份文件。

命令入口从原 wheel EXE 提取 `__main__.py`，改为相对自身定位 Python 的 C# 小入口。必须转发 stdout/stderr/stdin；仅让子进程继承默认句柄会在管道调用中出现退出码成功但无输出。字节流转发保留二进制结果，参数统一按 Windows 引号规则转义。使用 `-B`，因为 `-I` 下仅设置 PYTHONDONTWRITEBYTECODE 环境变量并不能阻止生成字节码。

增量修复少量入口时，用 7-Zip 更新指定文件并原样复用大型压缩数据，更新 inventory、资源 SHA256 与内嵌清单后重新编译原生壳。不能只替换 EXE 而保留旧资源校验值，也不能依靠重复 ZIP 条目覆盖，原生完整性校验会拒绝。

验证：329 字符的实际原生解压测试通过；本机 LongPathsEnabled 原已为 1，未改写。完整 130,247 文件 ZIP64 已实际解压并逐项 SHA256 核验；目录移动后两套 CUDA、pip 命令、实际配音及视频离线准备通过，未借用正式安装。记录见任务 045 与 `builds/full-offline-20261024-v1/validation/`。
