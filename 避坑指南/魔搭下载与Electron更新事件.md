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
