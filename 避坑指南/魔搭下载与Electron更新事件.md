# 魔搭更新下载与 Electron 事件接入

## 魔搭 CDN 对无 User-Agent 请求返回 403

表现：清单可读取，Python 发布器匿名包回读成功，但 Node/Electron 下载包在跳转至 `cdn-lfs-cn-1.modelscope.cn` 后返回 403。

根因：Node `https.get` 默认不发送 User-Agent；该 CDN 拒绝无标识请求，与签名 URL、登录态和 Range 无关。

解决：在清单、包和每次重定向请求中统一发送 `User-Agent: VoxCPM-Studio-Updater/1.0`，不使用发布 Token，不关闭 TLS 校验。

验证：同一包实测无标识 403，携带软件标识后 200/206；真实 Electron 魔搭下载及升级通过。`update-service.test.cjs` 的 HTTP 服务断言标识始终存在。

## 更新事件不能覆盖后端启动状态

表现：更新检查成功后，界面丢失后端连接，保存设置等按钮变为不可用，但本地 API 实际仍正常。

根因：原 `runtime:event` 监听器把所有消息整体写入 bootstrap；新增 `update-state` 不包含后端字段，覆盖后导致 backendBaseUrl 变空。

解决：监听器先处理更新事件并立即返回，其他事件继续原有启动状态流程。更新状态由独立面板维护，首页只显示可用更新提示。

验证：`scripts/smoke_update.cjs` 在检查更新和下载完成后断言「保存设置」仍可用，并检查更新后真实 API 健康状态。

## 更新器本身也需要在首次升级中迁移

表现：旧客户端更新后恢复旧文件，随后再次提示同一发布；仅修改新包内的更新器不能保证首次升级使用新逻辑。

根因：原下载流程把当前安装的 `updater.py` 复制到会话中执行。健康检查延期等新修复要等第二次更新才有机会生效；同时仅等待 EXE 的 spawn 事件就关闭主程序，不能证明 Python、签名校验和独立更新窗口已就绪。当前用户的异机失败日志未获得，以上为源码已确认的机制缺陷，不能断言是该机器的唯一根因。

解决：从完整性已确认的 ZIP 读取更新脚本，使用已验证的签名清单逐文件哈希后执行；新版脚本在完成全包签名验证后写 ready.json，主程序等本次会话握手后才退出。取消或超时留下取消标记，工作进程在父进程等待和写入前检查。安装后再次核验文件，健康回执要求本次新版 PID、版本、发布序号一致；重启前清除旧回执。更新结果持久保存，面板显示序号、回滚原因及日志入口。

正常旧版可以直接在线迁移，失败循环的旧版本保留已签名离线修复包作为一次性恢复入口；禁止强行提升本机版本标记来隐藏重复提示。所有便携副本使用各自 data/cache/electron-profile，避免不同安装目录争用默认单实例锁。

验证：28 项 Python 事务测试、5 项 Node 更新测试与准备心跳测试通过。scripts/smoke_update_reliability.cjs 故意破坏旧更新脚本，实际下载签名包、握手安装、重启后再次检查为 current；旧版离线修复、运行中拒绝、相同版本拒绝、用户数据保留与真实设置面板检查通过。记录 builds/update-reliability-validation/1792331704504/report.json。

另用 scripts/smoke_update_legacy.cjs 验证 `20261017132910`、`20261018131046` 两份完整未修补旧客户端直接升级：会话脚本与原旧脚本逐字节相同，升级重启后均为current。报告 builds/legacy-update-validation/1792332759826/report.json、1792332666281/report.json。旧脚本会妨碍某些修复首次生效，但不等于所有旧客户端都会升级失败；不能在没有故障日志时把它当成唯一根因。

2026-10-18已发布魔搭并验证r8未修补客户端的真实公网升级：builds/update-smoke-1792333642094/smoke-result.json。独立修复还需要处理pending事务，否则主程序损坏时会出现“先启动软件恢复”却无法启动的循环；现在确认事务属于当前目录且原进程已退出后直接用原备份恢复。31项Python回归及损坏main.js的实际恢复升级通过，报告builds/repair-recovery-validation/1792333510461/report.json。不要直接删除pending/backup或伪造新版本标记。
