"""只在各自的 MOSS 环境执行；每次任务结束退出并释放模型。"""
import json
import math
import os
from pathlib import Path
import sys


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
    phase('正在加载模型…')
    if request['kind'] == 'soundeffect':
        from moss_soundeffect_v2 import MossSoundEffectPipeline
        pipe = MossSoundEffectPipeline.from_pretrained(str(root / 'models/soundeffect'),
                  torch_dtype=torch.bfloat16, device='cuda')
        # 上游 DiT 构造后仍为 float32；显式转换，避免每步转换权重和16GB显卡共享内存换页。
        rotary_buffers = [(name, value) for name, value in pipe.transformer.named_buffers() if value.is_complex()]
        pipe.transformer.to(dtype=torch.bfloat16)
        # Module.to(dtype) 会丢弃复数缓冲区的虚部，RoPE 频率必须保持 complex。
        for name, value in rotary_buffers:
            parent_name, _, buffer_name = name.rpartition('.')
            parent = pipe.transformer.get_submodule(parent_name) if parent_name else pipe.transformer
            parent.register_buffer(buffer_name, value, persistent=False)
        torch.cuda.empty_cache()
        phase('正在生成音效…')
        audio = pipe(prompt=request['prompt'], seconds=request['seconds'], seed=request['seed'],
                     num_inference_steps=request['steps'], cfg_scale=request['guidance'],
                     max_inference_seconds=min(30, math.ceil(request['seconds']) + 1),
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
    sf.write(str(output), waveform, sample_rate, subtype='PCM_16')
    info = sf.info(str(output))
    if info.frames == 0:
        raise RuntimeError('模型未生成有效音频。')
    (output.parent / 'worker-result.json').write_text(json.dumps({
        'sample_rate': info.samplerate, 'duration': info.duration, 'channels': info.channels}), encoding='utf-8')
    phase('音频已保存。')


if __name__ == '__main__':
    main()
