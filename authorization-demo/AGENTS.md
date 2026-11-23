# Prototype Instructions

管理员须能随时按用户与软件调整试用到期时间，包括延长、缩短、立即结束和为过期用户恢复试用；保存调整前后时间、管理员与原因，客户端倒计时按最新期限更新。

用户已选定方案2：顶部横向导航、石墨深灰背景、银白主按钮、左侧用户列表与右侧授权详情；避免蓝色主色。项目文档和界面均使用中文。此工程为独立流程演示，禁止把localStorage授权、演示密码表单或固定演示时钟当成生产认证；不能写入用户真实密码、服务端签名私钥或生产凭据。

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
