"""固定版本获取官方音乐提示词资料；仅打包文本，不运行第三方技能脚本。"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'backend/voxcpm/music_skills'
ACE = 'ca1e85fe9430179831e6bc6be790c332190a3866'
MINIMAX = '945655064d59b98004dd70002e7eb5c8c6e11373'
YUE = '1647252d68b70cbead046ffd3f7caf036dde47ee'
HEART = '5858ca8f1ffe58d62be7c007ea55f1033c5ca456'
SOURCES = {
    'ace-songwriting.md': f'https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/{ACE}/.claude/skills/acestep-songwriting/SKILL.md',
    'ace-license.txt': f'https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/{ACE}/LICENSE',
    'yue2-music.md': f'https://raw.githubusercontent.com/multimodal-art-projection/YuE/{YUE}/skills/yue2-music/SKILL.md',
    'yue2-generation.md': f'https://raw.githubusercontent.com/multimodal-art-projection/YuE/{YUE}/skills/yue2-music/references/generation-and-covers.md',
    'yue2-instrumental.md': f'https://raw.githubusercontent.com/multimodal-art-projection/YuE/{YUE}/skills/yue2-music/instrumental/SKILL.md',
    'yue2-license.txt': f'https://raw.githubusercontent.com/multimodal-art-projection/YuE/{YUE}/skills/yue2-music/LICENSE',
    'heartmula-readme.md': f'https://raw.githubusercontent.com/HeartMuLa/heartlib/{HEART}/README.md',
    'heartmula-tags.txt': f'https://raw.githubusercontent.com/HeartMuLa/heartlib/{HEART}/assets/tags.txt',
    'heartmula-lyrics.txt': f'https://raw.githubusercontent.com/HeartMuLa/heartlib/{HEART}/assets/lyrics.txt',
    'heartmula-license.txt': f'https://raw.githubusercontent.com/HeartMuLa/heartlib/{HEART}/LICENSE',
}


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'VoxCPM-music-docs'}), timeout=90) as response:
        return response.read()


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    def save(item):
        name, url = item
        data = fetch(url)
        (OUTPUT / name).write_bytes(data)
        return name, {'url': url, 'sha256': hashlib.sha256(data).hexdigest()}
    with ThreadPoolExecutor(max_workers=6) as pool:
        files = dict(pool.map(save, SOURCES.items()))
    archive_url = f'https://codeload.github.com/MiniMax-AI/MiniMax-Music3/zip/{MINIMAX}'
    archive = fetch(archive_url)
    tree = json.loads(fetch(f'https://api.github.com/repos/MiniMax-AI/MiniMax-Music3/git/trees/{MINIMAX}?recursive=1'))
    git_hashes = {entry['path']: entry['sha'] for entry in tree['tree'] if entry['type'] == 'blob'}
    target = OUTPUT / 'minimax-rewriter.zip'
    count = 0
    with zipfile.ZipFile(io.BytesIO(archive)) as source, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as result:
        prefix = f'MiniMax-Music3-{MINIMAX}/skills/music-caption-rewriter/'
        for entry in sorted(source.infolist(), key=lambda e: e.filename):
            if not entry.filename.startswith(prefix) or entry.is_dir():
                continue
            name = entry.filename[len(prefix):]
            if not name.endswith(('.md', '.txt')) or ':' in name or '..' in name.split('/'):
                continue
            data = source.read(entry)
            git_path = 'skills/music-caption-rewriter/' + name
            if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != git_hashes[git_path]:
                raise ValueError('官方技能文本Git对象校验失败')
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 18, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            result.writestr(info, data)
            count += 1
    files[target.name] = {'url': archive_url, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'textFiles': count}
    manifest = {'version': '20261018-v1', 'checkedOn': '2026-10-18', 'files': files,
        'models': {
            'ace-xl-turbo': {'name': 'ACE-Step 1.5 XL Turbo', 'kind': 'official-skill', 'skill': 'acestep-songwriting', 'revision': ACE,
                'url': f'https://github.com/ace-step/ACE-Step-1.5/blob/{ACE}/.claude/skills/acestep-songwriting/SKILL.md'},
            'minimax-music3': {'name': 'MiniMax Music 3', 'kind': 'official-skill', 'skill': 'music-caption-rewriter', 'revision': MINIMAX,
                'url': f'https://github.com/MiniMax-AI/MiniMax-Music3/blob/{MINIMAX}/skills/music-caption-rewriter/SKILL.md'},
            'yue2': {'name': 'YuE2-3B', 'kind': 'official-skill', 'skill': 'yue2-music', 'revision': YUE,
                'url': f'https://github.com/multimodal-art-projection/YuE/blob/{YUE}/skills/yue2-music/SKILL.md'},
            'heartmula': {'name': 'HeartMuLa 3B', 'kind': 'official-docs', 'skill': None, 'revision': HEART,
                'url': f'https://github.com/HeartMuLa/heartlib/blob/{HEART}/README.md'},
        }}
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(f'官方文本已固定并校验：{len(files)}个资源，MiniMax {count}个文本文件；运行时无需联网检索')


if __name__ == '__main__':
    main()
