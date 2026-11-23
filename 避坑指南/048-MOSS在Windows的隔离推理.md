# MOSS 在 Windows 的隔离推理

表现与根因：

- MOSS-VoiceGenerator 的本地 `AutoProcessor.from_pretrained` 会将剩余kwargs透传到 `ProcessorMixin`，传 `torch_dtype` 或 `local_files_only` 导致 `Unexpected keyword argument`。只传已支持的 `codec_path`，离线通过进程环境约束。
- 音频解码器内部投影会显式将输入转为float32。将全部解码器权重转为BF16会触发 `Input type (float) and bias type BFloat16`。保持解码器float32，语音模型生成token后先迁到CPU，再将解码器移到GPU，减少16GB显卡峰值。
- 音效v2上游构造DiT后仍保留float32权重；只传pipeline的 `torch_dtype` 不会将DiT所有权重转为BF16。Windows16GB显卡容易发生共享内存换页，显著变慢。显式转换DiT，并保留原始complex RoPE缓冲区；它们位于 `freqs_cis_0/1/2`，`freqs` 是只读property，不能直接赋值。
- 音效官方pipeline默认始终计算30秒latent，即使仅需5秒。使用官方 `max_inference_seconds` 参数按请求时长计算，并预留1秒给DAC hop_length舍入，最后裁到目标时长。
- Windows venv的 `Scripts/python.exe` 会产生真实解释器子进程；只terminate父进程可能残留CUDA占用。取消时按本任务明确PID执行 `taskkill /PID ... /T /F`，再wait回收；不要按python进程名批量结束。
- PowerShell启动Electron时，仅修改进程环境后使用Start-Process会重新继承外部的 `ELECTRON_RUN_AS_NODE`。应显式传 `-Environment`，并将该变量设为null，否则Electron按Node模式执行，`require('electron').app` 为undefined。字符串相加放入ArgumentList数组时每个表达式加括号，避免PowerShell把多个参数拼成一个。

验证：真实24kHz/3.52秒语音、48kHz/5秒音效成功；后端43项测试含Windows子进程树取消通过，桌面15项交互与四分辨率深浅主题通过。上游固定commit `934d6826b084c46a0d033402174d5f8ac4ed2519`。
