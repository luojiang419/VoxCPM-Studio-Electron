# Windows 音乐后端动态显存推理停滞

## 表现与证据

2026-10-24 宣传片案例使用 RTX 4070 Ti SUPER 16GB、已安装音乐环境中的 PyTorch 2.11.0+cu128、ACE-Step 1.5 XL Turbo。默认独立后端首次冷启动超过180秒；预热后能启动，但扩散进度停在1/8，超过300秒未继续，GPU利用率约100%。该次任务已通过项目取消接口结束，没有冒充生成成功。

原任务记录分别为 `builds/promo/music-case-r2-status.json`、`music-case-r4-status.json`。诊断进程还出现过 Windows access violation，不能据此单独认定为某个内核或单项选项的确定缺陷。

## 已验证的兼容启动方式

保持已安装模型、Python与依赖只读，不重新下载。对本任务独立启动的原版 ComfyUI 追加：

```text
--disable-dynamic-vram --disable-async-offload --disable-pinned-memory
```

通过软件现有的 `comfyUrl` 兼容接口暂时连接这个本地后端，其余编译、模型工作流、结果归档仍由项目实际音乐服务执行。未改写模型工作流或伪造结果。操作脚本见 `scripts/promo_music_backend.py` 与 `scripts/promo_music_case.py music-case-r5`。

本次同时关闭上述三项，尚未分别测试最小必要组合；只能确认这个组合在本机有效，不应无证据推广为所有显卡的默认设置。

## 验证及恢复

任务 `2c95f3751edd4304b3241154952cf5ee` 实际成功：30秒、48kHz纯音乐，音乐阶段17.19秒，ComfyUI日志记录8/8采样及实际WAV输出。最终产物为 `builds/promo/exports/一起开场-本地纯音乐.wav`，截图与试听录屏均保留。

完成后已把 `comfyUrl` 恢复为空，并关闭本任务自己的临时后端。用户正式安装资源未修改。这是本机制作的兼容启动方案，未打包为软件更新。

另一个独立限制：音乐UI的自动双语适配需要配置AI助手。本次未添加账号或密钥，使用项目支持的手工双语提示词接口生成；不能把该结果描述为“未配置助手也能完成UI自动适配”。纯音乐提示词不要写“给解说留空间”，当前校验可能把“解说”识别为人声要求；改成直接描述配器、节奏与纯器乐。
