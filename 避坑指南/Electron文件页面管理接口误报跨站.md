# Electron 文件页面管理接口误报跨站

表现：浏览器同源设置演示正常，真实 Electron 的开发者 API 设置只显示密钥区，提示“不允许跨站管理 API”。主进程令牌存在，后端仍返回403。

根因：本项目 Electron 35 的 `file:` 页面部分 GET 请求省略 `Origin`，却带 `Sec-Fetch-Site: cross-site`。仅允许 `Origin: null` 的桌面校验漏掉了这种实际请求；模拟客户端测试仅覆盖 null，不能替代启动验收。

解决：继续限制本机连接和 localhost Host。对无 Origin 或 null Origin 的桌面请求，仅在 `X-JVOX-Management` 与当前主进程生成的令牌恒定时间比较相等时允许；普通网页 Origin 仍须同源。前端加载设置时依赖服务地址和管理令牌，避免令牌到达后不重试。

验证：`tests/test_public_voice_api.py` 覆盖无 Origin/null Origin 的正确、错误令牌，以及带正确令牌的外站 Origin 仍403；`scripts/smoke_public_api.cjs` 在真实 Electron、preload、React 和已安装 Python 上操作密钥生命周期、复制、监听启停和完全重启。2026-10-21实际通过，证据位于 `builds/public-api-acceptance/`，不保存明文密钥到报告或截图。
