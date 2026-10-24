# Windows 安装进度原子替换与文件共享

表现：安装下载途中出现 Electron 主进程 JavaScript 异常，堆栈为 `atomicJson` 的 `.progress.tmp → .progress` rename，Windows 错误 EPERM。

根因：原生安装器的 File.ReadAllText 默认共享模式不含 FileShare.Delete，读文件的短时间内禁止 JS 原子替换；JS 同步写进度又位于下载 Transform 回调，异常直接越过流处理造成未捕获异常。

解决：原生进度/报告读取允许删除共享；JS 安装报告使用唯一临时文件和异步串行写入，合并高频进度，并对 EPERM/EACCES/EBUSY 有界重试。进度显示失败可以等待下一次更新，最终 ready/fail 报告必须严格等待写入成功，不能吞掉最终报告错误或假报安装完成。

验证：任务 029 的 53 项 Node 回归和 26 项原生安装回归通过；用 Windows CreateFileW 真实持有禁止删除共享的句柄 150ms，验证进度与最终报告均能在释放后恢复写入。另覆盖永久错误、终态顺序及临时文件清理，证据与新构建位于 `builds/progress-lock-validation/`。

2026-10-24 同类问题扩展到更新提示窗口：旧客户端公网下载时 `prompt-state.json.tmp → prompt-state.json` 偶发 EPERM，主进程错误弹窗阻断下载。`updater/Program.cs` 的通用 JSON 读取现允许删除共享；`UpdateService` 提示进度改为复用 `writeReport`，异步串行合并并有界重试，关闭状态不被迟到进度覆盖。显示错误不从流事件回调抛出，关闭通知写失败时只关闭本次原生提示窗口。17 项更新/安装协议回归通过。已发布旧客户端仍携带旧实现，可用最终新版一体安装器在原目录升级；不能把新版代码回归说成所有旧客户端都已修复。
