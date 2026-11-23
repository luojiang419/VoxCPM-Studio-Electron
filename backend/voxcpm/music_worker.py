"""安装前独立进程自检；强制离线，不在用户进入工作区后隐式下载。"""
import argparse
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys


def probe(engine, model):
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_DATASETS_OFFLINE='1',
                      HF_ENDPOINT='https://hf-mirror.com', TOKENIZERS_PARALLELISM='false')
    sys.path.insert(0, str(engine / 'ComfyUI'))
    sys.path.insert(0, str(engine))
    if model in {'heartmula', 'yue2'}:
        sys.path.insert(0, str(engine / 'heartlib'))
        sys.path.insert(0, str(engine / 'heart-python'))
    import torch
    import torchaudio
    import soundfile
    assert torch.cuda.is_available(), '音乐模型需要可用 NVIDIA CUDA 显卡'
    assert torch.version.cuda == '12.8', '音乐运行环境 CUDA 版本不匹配'
    # 小矩阵实际执行，避免仅凭驱动可见就判定环境就绪。
    assert (torch.ones((4, 4), device='cuda') @ torch.ones((4, 4), device='cuda'))[0, 0].item() == 4
    if model == 'heartmula':
        from heartlib import HeartMuLaGenPipeline
    elif model == 'yue2':
        from yue2_comfy.nodes import YuE2GenerateSong
    else:
        import comfy.sd
        import comfy_extras.nodes_audio
        # 节点文件名随已锁定的 Comfy 版本确定，避免拉取最新版。
        candidates = list((engine / 'ComfyUI/comfy_extras').glob('*ace*' if model == 'ace-xl-turbo' else '*minimax*'))
        assert candidates, f'缺少 {model} 节点'
        for file in candidates:
            if file.suffix == '.py':
                importlib.import_module('comfy_extras.' + file.stem)
    print(json.dumps({'ok': True, 'model': model, 'torch': torch.__version__, 'audio': torchaudio.__version__}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--probe', action='store_true')
    mode.add_argument('--generate', action='store_true')
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--models', default='ace-xl-turbo')
    parser.add_argument('--single')
    parser.add_argument('--models-root', type=Path)
    parser.add_argument('--request', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    engine = args.engine.resolve()
    if args.generate:
        if not args.models_root or not args.request or not args.output:
            parser.error('生成需要模型目录、请求文件和输出路径')
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from music_inference import generate
        report = generate(engine, args.models_root.resolve(), json.loads(args.request.read_text(encoding='utf8')), args.output.resolve())
        args.output.with_suffix('.report.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf8')
    elif args.single:
        probe(engine, args.single)
    else:
        for model in args.models.split(','):
            if model not in {'ace-xl-turbo', 'minimax-music3', 'yue2', 'heartmula'}:
                raise ValueError('无效音乐模型')
            subprocess.run([sys.executable, str(Path(__file__).resolve()), '--probe', '--engine', str(engine), '--single', model], check=True)
