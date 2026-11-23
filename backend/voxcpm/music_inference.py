"""YuE2/HeartMuLa的隔离推理入口，复用已验证的Windows低显存路径。"""
from pathlib import Path
import os
import sys


def generate(engine, models, packet, output):
    # 与本机试听实测环境保持一致，YuE2的模型代码也使用4.57版transformers覆盖层。
    sys.path[:0] = [str(engine / 'heart-python'), str(engine / 'heartlib'), str(engine), str(engine / 'ComfyUI')]
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_DATASETS_OFFLINE='1', TOKENIZERS_PARALLELISM='false',
                      YUE2_MODELS_ROOT=str(models / 'comfy'), YUE2_CONSOLE_PROGRESS='0')
    sys.argv = [sys.argv[0]]
    import torch
    import soundfile as sf
    torch.manual_seed(packet['seed'])
    torch.cuda.reset_peak_memory_stats()
    if packet['modelId'] == 'yue2':
        if not packet['canGenerate']:
            raise ValueError('当前YuE2运行接口尚未接入纯音乐转谱流程，请改用ACE/MiniMax')
        import folder_paths
        folder_paths.add_model_folder_path('checkpoints', str(models / 'comfy/checkpoints'))
        folder_paths.set_output_directory(str(output.parent))
        # 不写入运行时源码目录中的用户缓存。
        folder_paths.set_user_directory(str(output.parent / 'yue2-user'))
        from yue2_comfy.constants import DEFAULT_OPTIONS
        from yue2_comfy.nodes import YuE2GenerateSong
        with torch.inference_mode():
            result = YuE2GenerateSong().generate(style=packet['inputs']['style'], lyrics=packet['inputs']['lyrics'], seed=packet['seed'],
                options={**DEFAULT_OPTIONS, 'max_seconds': packet['duration'], 'cot': 'full', 'offload': 'on', 'download': 'off',
                         'quantization': 'int8', 'keep_model_loaded': False}, score_abc='')
        audio, score = result['result']
        waveform = audio['waveform'].squeeze(0).float().cpu().numpy().T
        rate = audio['sample_rate']
        peak = float(abs(waveform).max())
        gain = min(1, .98 / peak) if peak else 1
        sf.write(output, waveform * gain, rate, subtype='PCM_24')
        output.with_suffix('.abc').write_text(score, encoding='utf8')
        report = {'normalizationGain': gain, 'sampleRate': rate}
    elif packet['modelId'] == 'heartmula':
        from heartlib import HeartMuLaGenPipeline
        report = {'sampleRate': 48000, 'codecDtype': 'float32', 'codecSteps': 30}
        class LocalPipeline(HeartMuLaGenPipeline):
            def _apply_compile(self, model):
                pass  # Windows eager，避免新增在线Triton编译依赖。
            def _forward(self, model_inputs, **kwargs):
                needed = model_inputs['tokens'].shape[1] + kwargs['max_audio_length_ms'] // 80 + 4
                self.mula.backbone.max_seq_len = min(self.mula.backbone.max_seq_len, ((needed + 127) // 128) * 128)
                return super()._forward(model_inputs, **kwargs)
            def postprocess(self, model_outputs, save_path):
                frames = model_outputs['frames'].to(self.codec_device)
                wav = self.codec.detokenize(frames, num_steps=report['codecSteps']).float().cpu().numpy().T
                peak = float(abs(wav).max())
                gain = min(1, .98 / peak) if peak else 1
                sf.write(save_path, wav * gain, 48000, subtype='PCM_24')
                report['normalizationGain'] = gain
                report['reachedFrameLimit'] = frames.shape[-1] >= int(packet['duration'] * 1000) // 80
                self._unload()
        pipeline = LocalPipeline.from_pretrained(str(models / 'heartmula'), version='3B', lazy_load=True,
            device={'mula': torch.device('cuda'), 'codec': torch.device('cuda')},
            dtype={'mula': torch.bfloat16, 'codec': torch.float32})
        # 官方pipeline会把看似文件名的字符串按路径读取；仅传入本次管理目录的文本文件。
        lyrics_file, tags_file = output.parent / 'lyrics.txt', output.parent / 'tags.txt'
        lyrics_file.write_text(packet['inputs']['lyrics'], encoding='utf8'); tags_file.write_text(packet['inputs']['tags'], encoding='utf8')
        with torch.inference_mode():
            pipeline({'lyrics': str(lyrics_file), 'tags': str(tags_file)}, save_path=str(output),
                max_audio_length_ms=int(packet['duration'] * 1000), topk=50, temperature=.85, cfg_scale=1.5)
    else:
        raise ValueError('该模型使用ComfyUI音频工作流')
    report['peakReservedMB'] = round(torch.cuda.max_memory_reserved() / 1024**2)
    return report
