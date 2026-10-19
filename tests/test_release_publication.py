"""发布入口的离线回归：一体版说明、旧版兼容及拒绝公网降级。"""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import release_update as release


class PublicationTests(unittest.TestCase):
    def run_publication(self, unified, previous_release="20261018235215"):
        key = Ed25519PrivateKey.generate()
        config = {"repository": "owner/repo", "manifestUrl": "https://example.com/latest"}
        package = b"verified package fixture"
        manifest = {"version": "2.0.2", "releaseId": "20261019003411", "notes": "模型选择与安装修复",
                    "package": {"name": "app.zip", "size": len(package), "sha256": hashlib.sha256(package).hexdigest()}}

        def envelope(value):
            payload = json.dumps(value, ensure_ascii=False)
            return {"payload": payload, "signature": key.sign(payload.encode()).hex()}

        signed = envelope(manifest)
        previous = envelope({**manifest, "releaseId": previous_release})
        api = MagicMock()
        api.get_model_files.return_value = [{"Path": "public/latest.json", "Type": "blob"}]
        activated = False
        content = {}

        def upload_folder(**kwargs):
            nonlocal activated
            activated = True
            content["readme"] = (Path(kwargs["folder_path"]) / "README.md").read_text("utf-8")

        def read_remote(url):
            if url == config["manifestUrl"]:
                return json.dumps(signed if activated else previous).encode()
            return package

        api.upload_folder.side_effect = upload_folder
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "app.zip").write_bytes(package)
            release.write_json(output / "manifest.json", manifest)
            release.write_json(output / "envelope.json", signed)
            release.write_json(output / "repairer-publication.json", {
                "releaseId": manifest["releaseId"], "anonymousVerification": True, "unified": unified,
                "repairUrl": "https://example.com/installer.exe", "size": 131679232,
                "sha256": "a" * 64, "autoTerminateOwnedProcesses": True})
            with patch.object(release, "keys", return_value=(key, config)), \
                    patch.object(release, "read_remote", side_effect=read_remote), \
                    patch("modelscope.hub.api.HubApi", return_value=api):
                if previous_release > manifest["releaseId"]:
                    with self.assertRaisesRegex(ValueError, "禁止回退"):
                        release.publish(output)
                    api.upload_folder.assert_not_called()
                    self.assertFalse((output / "publication.json").exists())
                else:
                    release.publish(output)
                    self.assertTrue(release.read_json(output / "publication.json")["anonymousVerification"])
        return content

    def test_unified_readme_describes_install_check_and_repair(self):
        readme = self.run_publication(True)["readme"]
        for text in ("JVOX Studio配音系统安装器", "首次运行", "正常提示", "只有需要修复", "模型选择与安装修复"):
            self.assertIn(text, readme)
        self.assertNotIn("点击“开始修复并升级”", readme)

    def test_legacy_repairer_instructions_remain_available(self):
        readme = self.run_publication(False)["readme"]
        self.assertIn("下载独立更新修复器 EXE", readme)
        self.assertIn("点击“开始修复并升级”", readme)

    def test_newer_public_release_cannot_be_replaced(self):
        self.run_publication(True, "20261020000000")


if __name__ == "__main__":
    unittest.main()
