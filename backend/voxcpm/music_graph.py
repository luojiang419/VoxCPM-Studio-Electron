"""编译已验证的ComfyUI音频节点输入，不把AI自由文本当作工作流代码。"""


def graph_for(packet, prefix):
    model, inputs = packet['modelId'], packet['inputs']
    if model not in {'ace-xl-turbo', 'minimax-music3'}:
        raise ValueError('该模型使用独立音乐推理进程')
    mini = model == 'minimax-music3'
    def node(kind, **values):
        return {'class_type': kind, 'inputs': values}
    graph = {
        '1': node('UNETLoader', unet_name='minimax_music3_dit_fp16.safetensors' if mini else 'acestep_v1.5_xl_turbo_bf16.safetensors', weight_dtype='default'),
        '3': node('VAELoader', vae_name='minimax_music3_dav.safetensors' if mini else 'ace_1.5_vae.safetensors'),
        '5': node('ConditioningZeroOut', conditioning=['4', 0]),
        '7': node('KSampler', model=['1', 0], seed=packet['seed'], steps=30 if mini else 8, cfg=1.7 if mini else 1.0,
                  sampler_name='euler', scheduler='simple', positive=['4', 0], negative=['5', 0], latent_image=['6', 0], denoise=1.0),
        '8': node('VAEDecodeAudioTiled', samples=['7', 0], vae=['3', 0], tile_size=512, overlap=64),
        '9': node('SaveAudio', audio=['8', 0], filename_prefix=prefix),
    }
    if mini:
        graph['2'] = node('CLIPLoader', clip_name='minimax_music3_text_encoder_pruned_int8_convrot.safetensors', type='minimax', device='default')
        graph['4'] = node('MiniMaxMusic3TextEncode', clip=['2', 0], **inputs, cfg_scale=1.7, top_k=50)
        graph['6'] = node('EmptyMiniMaxMusic3LatentAudio', seconds=['4', 1], batch_size=1)
    else:
        graph['2'] = node('DualCLIPLoader', clip_name1='qwen_0.6b_ace15.safetensors', clip_name2='qwen_1.7b_ace15.safetensors', type='ace', device='default')
        graph['4'] = node('TextEncodeAceStepAudio1.5', clip=['2', 0], **inputs, generate_audio_codes=True,
                          cfg_scale=2.0, temperature=.85, top_p=.9, top_k=0, min_p=0.0)
        graph['6'] = node('EmptyAceStep1.5LatentAudio', seconds=packet['duration'], batch_size=1)
        graph['10'] = node('ModelSamplingAuraFlow', model=['1', 0], shift=3.0)
        graph['7']['inputs']['model'] = ['10', 0]
    return graph
