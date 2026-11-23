"""真实 GPU 推理验收，直接验证隔离服务，不修改桌面账号或授权。"""
import argparse
import json
import os
from pathlib import Path
import sys
import types
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType('voxcpm'); package.__path__ = [str(ROOT / 'backend/voxcpm')]
sys.modules['voxcpm'] = package
from voxcpm.studio_moss import MossService

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', choices=['voice', 'soundeffect', 'all'], default='all')
    args = parser.parse_args()
    studio = SimpleNamespace(reset_runtime=lambda: None, training_status_payload=lambda: {'running': False})
    data = ROOT / 'builds/moss-test/data'
    service = MossService(data, studio)
    inputs = {
        'voice': {'text': '你好，欢迎来到声音的世界。', 'control': '年轻女性，温暖自然，吐字清晰，语速舒缓。'},
        'soundeffect': {'title': '清晨森林 · MOSS 实测', 'prompt': '清晨森林中，几只小鸟清脆地鸣叫，微风轻轻吹动树叶。没有人声和音乐。', 'seconds': 5, 'steps': 40, 'guidance': 4, 'seed': 1247, 'negativePrompt': '音乐，人声'},
    }
    report = {}
    for key in (list(inputs) if args.kind == 'all' else [args.kind]):
        result = service.generate(key, inputs[key], lambda n, text: print(text, flush=True), lambda: False)
        import soundfile as sf
        import numpy as np
        audio, rate = sf.read(result['outputPath'])
        rms = float(np.sqrt(np.mean(audio ** 2)))
        assert len(audio) > rate and rms > 1e-5 and np.isfinite(audio).all()
        report[key] = {**result, 'rms': rms}
    target = ROOT / f'builds/moss-test/real-{args.kind}.json'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('真实推理通过：' + str(target), flush=True)
