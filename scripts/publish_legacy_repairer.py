"""发布单文件修复器或安装修复一体版，匿名回读后按需激活签名应用。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from release_update import FRONTEND, file_url, read_remote, publish
from updater import read_json, sha256, write_json, version
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def publish_repairer(snapshot: Path, executable: Path, activate=False):
    config = read_json(FRONTEND / "update-config.json")
    envelope = read_json(snapshot / "envelope.json")
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(config["publicKey"])).verify(
        bytes.fromhex(envelope["signature"]), envelope["payload"].encode())
    manifest = json.loads(envelope["payload"])
    if read_json(snapshot / "manifest.json") != manifest:
        raise ValueError("签名快照清单不一致")
    built = read_json(executable.parent / "构建记录.json")
    if (not re.fullmatch(r"\d{14}", built["releaseId"]) or not re.fullmatch(r"[0-9a-f]{10}", built["buildId"])
            or executable.stat().st_size != built["size"] or sha256(executable) != built["sha256"]):
        raise ValueError("修复器与构建记录不一致")
    if (version(manifest["version"]), manifest["releaseId"]) < (version(built["version"]), built["releaseId"]):
        raise ValueError("激活快照不能早于修复器内置签名版本")
    unified = built.get("unified", False)
    if unified:
        validation = read_json(Path(built["validationReport"]))
        if (not built.get("validationPassed") or not validation.get("passed")
                or Path(validation["build"]).resolve() != (executable.parent / "构建记录.json").resolve()):
            raise ValueError("一体版缺少对应最终构建的验收记录")
    from modelscope.hub.api import HubApi
    api = HubApi()
    repo = config["repository"]
    remote = (f"installers/{built['version']}/{built['releaseId']}-{built['buildId']}/JVOX-Studio-Installer.exe" if unified else
              f"repairers/{built['version']}/{built['releaseId']}-{built['buildId']}/JVOX-Studio-Update-Repairer.exe")
    url = file_url(repo, remote)
    existing = {item["Path"] for item in api.get_model_files(repo, recursive=True) if item["Type"] == "blob"}
    if remote in existing:
        if hashlib.sha256(read_remote(url)).hexdigest() != built["sha256"]:
            raise ValueError("远端同名修复器内容不同，禁止覆盖")
    else:
        api.upload_file(path_or_fileobj=str(executable), path_in_repo=remote, repo_id=repo,
                        commit_message=f"repairer: standalone legacy recovery {built['buildId']}")
    downloaded = read_remote(url)
    if len(downloaded) != built["size"] or hashlib.sha256(downloaded).hexdigest() != built["sha256"]:
        raise ValueError("修复器匿名回读不一致，未激活更新")
    report = {"version": manifest["version"], "releaseId": manifest["releaseId"], "embeddedReleaseId": built["releaseId"],
              "buildId": built["buildId"], "repository": repo, "repairUrl": url, "remotePath": remote,
              "size": len(downloaded), "sha256": built["sha256"], "anonymousVerification": True, "executable": str(executable),
              "autoTerminateOwnedProcesses": built.get("autoTerminateOwnedProcesses", False), "unified": unified}
    write_json(snapshot / "repairer-publication.json", report)
    write_json(executable.parent / "发布记录.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if activate:
        publish(snapshot)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    publish_repairer(args.snapshot.resolve(strict=True), args.executable.resolve(strict=True), args.activate)
