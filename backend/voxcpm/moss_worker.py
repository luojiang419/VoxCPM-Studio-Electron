"""只在各自的 MOSS 环境执行；每次任务结束退出并释放模型。"""
import json
import os
from pathlib import Path
import sys
import time
from moss_audio import validate_audio


def main():
    request = json.loads(Path(sys.argv[1]).read_text('utf-8'))
    root, output = Path(request['root']), Path(request['output'])
    def phase(message):
        target = output.parent / 'progress.json'
        temp = target.with_suffix('.tmp')
        temp.write_text(json.dumps({'message': message}), encoding='utf-8')
        temp.replace(target)
        print(message, flush=True)

    os.environ.setdefault('TORCHDYNAMO_DISABLE', '1')
    import torch
    import soundfile as sf
    if not torch.cuda.is_available():
        raise RuntimeError('MOSS 测试版需要可用的 NVIDIA CUDA 显卡。')
    torch.backends.cuda.enable_cudnn_sdp(False)
    torch.manual_seed(request.get('seed', 1247))
    torch.cuda.reset_peak_memory_stats()
    started = time.monotonic()
    phase('正在加载模型…')
    if request['kind'] == 'soundeffect':
        from moss_soundeffect_v2 import MossSoundEffectPipeline
        pipe = MossSoundEffectPipeline.from_pretrained(str(root / 'models/soundeffect'),
                  torch_dtype=torch.bfloat16, device='cuda')
        # 沿用官方权重精度、完整内部长度和采样流程，不另行转换DiT或RoPE缓冲区。
        # 仅移动各阶段不用的组件到CPU，避免16GB显卡换页；不改变权重或采样计算。
        pipe.engine.enable_cpu_offload()
        phase('正在生成音效…')
        audio = pipe(prompt=request['prompt'], seconds=request['seconds'], seed=request['seed'],
                     num_inference_steps=request['steps'], cfg_scale=request['guidance'],
                     negative_prompt=request.get('negativePrompt', ''))
        sample_rate = pipe.sample_rate
        waveform = audio[0].float().cpu().numpy().T
    else:
        from transformers import AutoModel, AutoProcessor
        processor = AutoProcessor.from_pretrained(str(root / 'models/voice'), trust_remote_code=True,
                    codec_path=str(root / 'models/codec'))
        # 音频解码器先留在 CPU，语音 token 生成完再切换到 GPU，降低显存峰值。
        model = AutoModel.from_pretrained(str(root / 'models/voice'), trust_remote_code=True,
                    attn_implementation='sdpa', torch_dtype=torch.bfloat16, local_files_only=True).to('cuda').eval()
        conversation = [[processor.build_user_message(text=request['text'], instruction=request['control'])]]
        batch = processor(conversation, mode='generation')
        phase('正在合成语音…')
        with torch.inference_mode():
            tokens = model.generate(input_ids=batch['input_ids'].to('cuda'), attention_mask=batch['attention_mask'].to('cuda'),
                         max_new_tokens=min(4096, max(512, len(request['text']) * 18 + 128)), audio_temperature=1.5, audio_top_p=.6,
                         audio_top_k=50, audio_repetition_penalty=1.1)
            model.to('cpu')
            torch.cuda.empty_cache()
            processor.audio_tokenizer.to(device='cuda')
            phase('正在解码语音…')
            message = processor.decode(tokens)[0]
            waveform = message.audio_codes_list[0].float().cpu().numpy()
        sample_rate = processor.model_config.sampling_rate
    # 保持官方30秒latent生成后裁切；缩短latent会使部分描述坍缩为静音。
    validate_audio(waveform)
    sf.write(str(output), waveform, sample_rate, subtype='PCM_16')
    info = sf.info(str(output))
    if info.frames == 0:
        raise RuntimeError('模型未生成有效音频。')
    # 再检查实际导出数据，PCM量化后仍须存在可听的交流信号。
    saved, _ = sf.read(str(output))
    quality = validate_audio(saved)
    (output.parent / 'worker-result.json').write_text(json.dumps({
        'sample_rate': info.samplerate, 'duration': info.duration, 'channels': info.channels,
        'audioQuality': quality, 'generationSeconds': time.monotonic() - started,
        'peakGpuMemoryMiB': torch.cuda.max_memory_allocated() / 1024**2}), encoding='utf-8')
    phase('音频已保存。')


if __name__ == '__main__':
    main()
