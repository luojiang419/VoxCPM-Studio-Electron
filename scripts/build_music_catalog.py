"""把已验证的魔搭模型及独立运行包转换为安装器固定清单。"""
import argparse
import json
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]


def build(source, runtime, output):
    models = {key: {'id': key, 'label': label, 'files': []} for key, label in [
        ('ace-xl-turbo', 'ACE-Step 1.5 XL Turbo'), ('yue2', 'YuE2-3B'),
        ('minimax-music3', 'MiniMax Music 3'), ('heartmula', 'HeartMuLa 3B')]}
    for asset in json.loads(source.read_text(encoding='utf8'))['files']:
        repo, relative = asset['repo'], asset['relative_path']
        key = ('ace-xl-turbo' if 'ace_step' in repo else 'minimax-music3' if 'MiniMax-Music' in repo
               else 'yue2' if 'YuE2' in repo else 'heartmula')
        target = relative.replace('vendor/ComfyUI/models/', 'models/music/comfy/')
        models[key]['files'].append({'name': target, 'size': asset['size'], 'sha256': asset['sha256'],
            'reusePath': relative,
            'urls': [f'https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath=' + quote(asset['path'], safe='')]})
    spec = {'protocol': 1, 'runtime': json.loads(runtime.read_text(encoding='utf8')), 'models': list(models.values())}
    output.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'frontend/voxcpm_studio_electron/music-config.json')
    args = parser.parse_args()
    build(args.source, args.runtime, args.output)
