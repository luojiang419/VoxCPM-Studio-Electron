"""验证独立音乐环境的损坏拦截、路径保护与中断恢复。"""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
module = importlib.util.spec_from_file_location('music_install', ROOT / 'backend/voxcpm/music_install.py')
installer = importlib.util.module_from_spec(module)
module.loader.exec_module(installer)
sha = lambda data: hashlib.sha256(data).hexdigest()


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vox-music-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.target = self.root / 'runtime'

    def bundle(self, extra=None, version='test-v1'):
        files = {'python/python.exe': b'python', **(extra or {})}
        info = {'version': version, 'files': {p: len(v) for p, v in files.items()}}
        files['runtime-info.json'] = json.dumps(info).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for path, data in files.items():
                archive.writestr(path, data)
        raw = output.getvalue()
        middle = len(raw) // 2
        parts = []
        for index, data in enumerate((raw[:middle], raw[middle:])):
            name = f'runtime.part{index:02d}'
            (self.cache / name).write_bytes(data)
            parts.append({'name': name, 'size': len(data), 'sha256': sha(data)})
        return {'version': 'test-v1', 'size': len(raw), 'sha256': sha(raw), 'parts': parts,
                'required': ['python/python.exe'], 'installed_size': sum(len(v) for v in files.values())}

    def test_install_and_interrupted_switch_recovery(self):
        spec = self.bundle()
        installer.install(self.cache, self.target, spec)
        old = self.target.with_name('runtime.previous')
        self.target.rename(old)  # 模拟原目录已移走、新目录尚未切换时退出。
        staging = self.target.with_name('runtime.installing')
        staging.mkdir(); (staging / 'partial').write_bytes(b'partial')
        installer.install(self.cache, self.target, spec)
        self.assertTrue((self.target / 'ready.json').is_file())
        self.assertFalse(old.exists()); self.assertFalse(staging.exists())
        self.assertFalse((self.cache / 'music-runtime.zip.part').exists())

    def test_corrupt_part_preserves_previous_runtime(self):
        spec = self.bundle(); installer.install(self.cache, self.target, spec)
        file = self.cache / spec['parts'][0]['name']
        file.write_bytes(b'x' * file.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            installer.install(self.cache, self.target, spec)
        self.assertEqual((self.target / 'python/python.exe').read_bytes(), b'python')
        self.assertFalse((self.cache / 'music-runtime.zip.part').exists())

    def test_zip_path_traversal_rejected(self):
        spec = self.bundle({'../escape': b'bad'})
        with self.assertRaisesRegex(ValueError, '非法路径'):
            installer.install(self.cache, self.target, spec)
        self.assertFalse((self.root / 'escape').exists())
        self.assertFalse((self.target / 'ready.json').exists())

    def test_wrong_version_and_missing_required_rejected(self):
        spec = self.bundle(version='other-version')
        with self.assertRaisesRegex(ValueError, '版本不匹配'):
            installer.install(self.cache, self.target, spec)
        spec = self.bundle(); spec['required'].append('missing.dll')
        with self.assertRaisesRegex(ValueError, '缺少必要文件'):
            installer.install(self.cache, self.target, spec)
        self.assertFalse((self.target / 'ready.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
