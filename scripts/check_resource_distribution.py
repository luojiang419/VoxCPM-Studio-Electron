"""匿名核对魔搭分发清单，并用单字节请求验证两套 CUDA wheel 的下载入口。"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import urllib.request
from urllib.parse import parse_qs, urlsplit, urlencode

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'jiangjiang419/voxcpm-studio-updates'
API = f'https://modelscope.cn/api/v1/models/{REPOSITORY}'


def assets(value):
    if isinstance(value, dict):
        if all(key in value for key in ('size', 'sha256', 'urls')):
            yield value
        else:
            for child in value.values():
                yield from assets(child)
    elif isinstance(value, list):
        for child in value:
            yield from assets(child)


def check():
    checked, errors, pending = {}, [], []
    for manifest in ['frontend/voxcpm_studio_electron/runtime-config.json',
                     'frontend/voxcpm_studio_electron/music-config.json', 'backend/voxcpm/lipsync-install.json']:
        for asset in assets(json.loads((ROOT / manifest).read_text(encoding='utf8'))):
            url = asset['urls'][0]
            parsed = urlsplit(url)
            match = re.fullmatch(r'/api/v1/models/([^/]+/[^/]+)/repo', parsed.path)
            if parsed.scheme != 'https' or parsed.netloc != 'modelscope.cn' or not match:
                errors.append(f'{manifest}: 首选资源不在魔搭: {asset.get("name", asset.get("path"))}')
                continue
            query = parse_qs(parsed.query)
            pending.append((match[1], query['Revision'][0], query['FilePath'][0], asset))

    def listing(key):
        repository, revision = key
        try:
            url = f'https://modelscope.cn/api/v1/models/{repository}/repo/files?' + urlencode({'Revision': revision, 'Recursive': 'true'})
            with urllib.request.urlopen(url, timeout=30) as response:
                result = json.load(response)
            if result.get('Code') != 200:
                raise ValueError('魔搭匿名清单不可读')
            return key, {item['Path']: item for item in result['Data']['Files'] if item['Type'] == 'blob'}, None
        except Exception as error:
            return key, {}, str(error)

    with ThreadPoolExecutor(max_workers=4) as pool:
        remote = {}
        for key, files, error in pool.map(listing, sorted({(repo, revision) for repo, revision, _, _ in pending})):
            remote[key] = files
            if error:
                errors.append(f'{key}: {error}')
    for repository, revision, path, asset in pending:
        item = remote[repository, revision].get(path, {})
        key = f'{repository}@{revision}/{path}'
        if item.get('Size') != asset['size'] or item.get('Sha256') != asset['sha256']:
            errors.append(f'{key}: 远端文件大小或 SHA256 与清单不一致')
        checked[key] = {'size': asset['size'], 'sha256': asset['sha256']}
    probes = []
    runtime = json.loads((ROOT / 'frontend/voxcpm_studio_electron/runtime-config.json').read_text(encoding='utf8'))
    for profile in ('cu126', 'cu128'):
        asset = runtime['profiles'][profile]['wheels'][0]
        request = urllib.request.Request(asset['urls'][0], headers={'Range': 'bytes=0-0', 'User-Agent': 'JVOX-Resource-Audit/1'})
        with urllib.request.urlopen(request, timeout=30) as response:
            expected = f'bytes 0-0/{asset["size"]}'
            if response.status != 206 or response.headers.get('Content-Range') != expected or len(response.read(2)) != 1:
                errors.append(f'{profile}: 单字节续传下载检查失败')
            probes.append({'profile': profile, 'name': asset['name'], 'status': response.status,
                           'contentRange': response.headers.get('Content-Range')})
    return {'checkedAt': datetime.now(timezone.utc).isoformat(), 'repository': REPOSITORY,
            'passed': not errors, 'files': checked, 'count': len(checked), 'downloadProbes': probes, 'errors': errors,
            'verification': '远端元数据大小/SHA256 与单字节下载；未全量下载或执行各 GPU 推理'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = check()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({key: value for key, value in result.items() if key != 'files'}, ensure_ascii=False))
    raise SystemExit(0 if result['passed'] else 1)
