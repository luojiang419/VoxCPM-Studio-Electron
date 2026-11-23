# MOSS 在 Windows 的隔离推理

表现与根因：

- MOSS-VoiceGenerator 的本地 `AutoProcessor.from_pretrained` 会将剩余kwargs透传到 `ProcessorMixin`，传 `torch_dtype` 或 `local_files_only` 导致 `Unexpected keyword argument`。只传已支持的 `codec_path`，离线通过进程环境约束。
- 音频解码器内部投影会显式将输入转为float32。将全部解码器权重转为BF16会触发 `Input type (float) and bias type BFloat16`。保持解码器float32，语音模型生成token后先迁到CPU，再将解码器移到GPU，减少16GB显卡峰值。
- 音效v2上游构造DiT后仍保留float32权重；只传pipeline的 `torch_dtype` 不会将DiT所有权重转为BF16。按用户质量优先要求，最终实现保持官方加载行为，不主动转换DiT。研究精度转换时，注意 `Module.to(dtype)` 会破坏complex RoPE缓冲区；`freqs`还是只读property，不能直接赋值。此前手动转换方案已移除，不作为当前推荐实现。
- 音效官方pipeline默认始终计算30秒latent，即使输出仅需5或10秒。不能为了提速把内部长度改成输出长度：用户原描述「燧发枪补充弹药和击发」、种子1247、100步、CFG4，内部11秒时AC RMS约1.49e-5，仅剩8个PCM值；相同参数恢复30秒后AC RMS约0.05961，正常出声。应保持完整内部生成，再裁到目标时长。
- 非零音频不一定可听。旧smoke的RMS>1e-5会漏掉量化噪声。现改为检查有限数值、去直流交流RMS与峰值，并在原波形、导出PCM和服务入库三处校验；允许有长静音的短促枪声，也允许低音量环境声，不把噪声放大成有效作品。
- 质量优先并不要求组件同时常驻GPU。使用上游 `pipe.engine.enable_cpu_offload()` 按阶段移动原精度组件，避免Windows共享显存换页；本机16GB保留完整内部长度与100步后，真实流程约66秒、GPU分配峰值约9.9GiB。同一原描述已通过真实主项目API和浏览器音频解码验证。
- Windows venv的 `Scripts/python.exe` 会产生真实解释器子进程；只terminate父进程可能残留CUDA占用。取消时按本任务明确PID执行 `taskkill /PID ... /T /F`，再wait回收；不要按python进程名批量结束。
- PowerShell启动Electron时，仅修改进程环境后使用Start-Process会重新继承外部的 `ELECTRON_RUN_AS_NODE`。应显式传 `-Environment`，并将该变量设为null，否则Electron按Node模式执行，`require('electron').app` 为undefined。字符串相加放入ArgumentList数组时每个表达式加括号，避免PowerShell把多个参数拼成一个。

验证：真实24kHz/3.52秒语音、48kHz/5秒音效成功；后端43项测试含Windows子进程树取消通过，桌面15项交互与四分辨率深浅主题通过。上游固定commit `934d6826b084c46a0d033402174d5f8ac4ed2519`。
