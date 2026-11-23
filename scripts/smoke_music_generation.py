"""复用已安装权重与运行包，实际验收音乐生成；只终止本次创建的推理进程。"""
import argparse
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
package = ModuleType('voxcpm'); package.__path__ = [str(ROOT / 'backend/voxcpm'), str(ROOT.parent / 'src/voxcpm')]
sys.modules['voxcpm'] = package
from voxcpm.studio_api import MusicGenerateRequest
from voxcpm.studio_music import MusicService


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--models-root', type=Path, required=True)
    parser.add_argument('--models', default='ace-xl-turbo')
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--auto-optimize', action='store_true')
    parser.add_argument('--isolated', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'builds/music-ai-live-validation')
    args = parser.parse_args()
    os.environ['VOXCPM_MUSIC_ENGINE_ROOT'] = str(args.engine.resolve())
    os.environ['VOXCPM_MUSIC_MODELS_ROOT'] = str(args.models_root.resolve())
    data = args.output / 'data'; data.mkdir(parents=True, exist_ok=True)
    (data / 'component-selection.json').write_text(json.dumps({'selected': ['ace-xl-turbo','minimax-music3','yue2','heartmula'], 'removed': [], 'defaultModel': 'ace-xl-turbo'}), encoding='utf8')
    service = MusicService(data, SimpleNamespace(reset_runtime=lambda: None), root=ROOT)
    if args.isolated:
        original = service._http
        def no_auto(base, route, body=None, timeout=15):
            if base == 'http://127.0.0.1:8188' and route.startswith('/object_info/'):
                raise urllib.error.URLError('独立后端实机验收')
            return original(base, route, body, timeout)
        service._http = no_auto
    for model in args.models.split(','):
        source = json.loads((args.output / (model + '-prompt.json')).read_text(encoding='utf8'))
        brief = {**source['brief'], 'duration': args.seconds}
        payload = MusicGenerateRequest(brief=brief, draft=source['draft'], autoOptimize=args.auto_optimize)
        service.reserve(model)
        result = service.generate(payload, lambda n, text: print(model, n, text, flush=True))
        print('AUDIO_VERIFIED', json.dumps({k: result[k] for k in ('title','modelId','duration','outputPath','report')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
