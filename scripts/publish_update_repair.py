"""发布已签名快照的独立修复包，匿名回读后按需激活正式更新。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

from release_update import FRONTEND, file_url, read_remote, publish

sys.path.insert(0, str(FRONTEND))
from updater import read_json, sha256, write_json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def publish_repair(snapshot: Path, archive: Path, activate=False):
    config = read_json(FRONTEND / "update-config.json")
    envelope = read_json(snapshot / "envelope.json")
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(config["publicKey"])).verify(
        bytes.fromhex(envelope["signature"]), envelope["payload"].encode())
    manifest = json.loads(envelope["payload"])
    with zipfile.ZipFile(archive) as z:
        prefixes = {Path(name).parts[0] for name in z.namelist()}
        if len(prefixes) != 1:
            raise ValueError("修复包顶层目录不唯一")
        prefix = prefixes.pop() + "/"
        if json.loads(z.read(prefix + "envelope.json").decode("utf-8-sig")) != envelope:
            raise ValueError("修复包与待发布签名快照不一致")
        package = z.read(prefix + manifest["package"]["name"])
        if len(package) != manifest["package"]["size"] or hashlib.sha256(package).hexdigest() != manifest["package"]["sha256"]:
            raise ValueError("修复包内应用ZIP校验失败")
        record = next(item for item in manifest["files"] if item["path"] == "resources/app/updater.py")
        if hashlib.sha256(z.read(prefix + "updater.py")).hexdigest() != record["sha256"]:
            raise ValueError("修复工具的事务脚本与签名快照不一致")
        for name in ("repair_update.py", "repair_update.ps1", "修复更新.cmd", "使用说明.txt"):
            if not z.read(prefix + name):
                raise ValueError("修复包缺少必要入口")
    from modelscope.hub.api import HubApi
    api = HubApi()
    repo = config["repository"]
    remote = f"repairs/{manifest['version']}/{manifest['releaseId']}/VoxCPM-Studio-{manifest['version']}-Update-Repair-{manifest['releaseId']}.zip"
    url = file_url(repo, remote)
    expected = sha256(archive)
    existing = {item["Path"] for item in api.get_model_files(repo, recursive=True) if item["Type"] == "blob"}
    if remote in existing:
        if hashlib.sha256(read_remote(url)).hexdigest() != expected:
            raise ValueError("远端同名修复包内容不同，禁止覆盖")
    else:
        api.upload_file(path_or_fileobj=str(archive), path_in_repo=remote, repo_id=repo,
                        commit_message=f"repair: VoxCPM Studio {manifest['releaseId']}")
    downloaded = read_remote(url)
    if len(downloaded) != archive.stat().st_size or hashlib.sha256(downloaded).hexdigest() != expected:
        raise ValueError("修复包匿名回读不一致，未激活更新")
    report = {"version": manifest["version"], "releaseId": manifest["releaseId"], "repository": repo,
              "repairUrl": url, "remotePath": remote, "size": len(downloaded), "sha256": expected,
              "anonymousVerification": True, "archive": str(archive)}
    write_json(snapshot / "repair-publication.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if activate:
        publish(snapshot)
    return report


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--activate", action="store_true", help="修复包回读通过后发布并激活同一签名快照")
    args = parser.parse_args()
    publish_repair(args.snapshot.resolve(strict=True), args.archive.resolve(strict=True), args.activate)
