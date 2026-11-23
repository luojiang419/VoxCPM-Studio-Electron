"""大模型准备期间的升级健康检查：延期有界，拒绝其他进程/旧版本/停止心跳。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('updater', ROOT / 'frontend/voxcpm_studio_electron/updater.py')
updater = importlib.util.module_from_spec(spec); spec.loader.exec_module(updater)


class UpdatePreparationTests(unittest.TestCase):
    def test_heartbeat_identity_status_age_and_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Path(folder); file = session / 'healthy.json.preparing'
            manifest = {'version': '2.0.2', 'releaseId': '20261018184500'}
            deadline = time.monotonic() + 1; limit = time.monotonic() + 100
            state = {**manifest, 'pid': 123, 'status': 'working'}
            def write(value):
                file.write_text(json.dumps(value), encoding='utf8')
            self.assertEqual(updater.preparation_deadline(session, manifest, 123, deadline, limit), deadline)
            write(state)
            self.assertEqual(updater.preparation_deadline(session, manifest, 123, deadline, limit), limit)
            for patch in [{'pid': 456}, {'version': '2.0.1'}, {'releaseId': 'old'}, {'status': 'error'}, {'status': 'cancelled'}]:
                write({**state, **patch})
                self.assertEqual(updater.preparation_deadline(session, manifest, 123, deadline, limit), deadline)
            write(state); os.utime(file, (time.time() - 60, time.time() - 60))
            self.assertEqual(updater.preparation_deadline(session, manifest, 123, deadline, limit), deadline)


if __name__ == '__main__':
    unittest.main(verbosity=2)
