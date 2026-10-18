"""准备并发布固定依赖资源到魔搭；只添加不可变路径，不激活应用更新。"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend/voxcpm_studio_electron"
DEFAULT_REPO = "jiangjiang419/voxcpm-studio-updates"
DEFAULT_PREFIX = "runtime/py312-20261018-v1"


def sha256(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def file_url(repo, relative):
    return f"https://modelscope.cn/api/v1/models/{repo}/repo?" + urllib.parse.urlencode({"Revision": "master", "FilePath": relative})


def descriptor(file, repo, prefix):
    return {"name": file.name, "size": file.stat().st_size, "sha256": sha256(file), "urls": [file_url(repo, f"{prefix}/{file.name}")]}


def prepare(directory, repo=DEFAULT_REPO, prefix=DEFAULT_PREFIX):
    config = json.loads((FRONTEND / "runtime-config.json").read_text(encoding="utf-8"))
    records = {}
    for asset in [config["python"], config["pip"], *(a for p in config["profiles"].values() for a in p["wheels"] if a["name"].startswith(("torch-", "torchaudio-")))]:
        asset["urls"] = list(dict.fromkeys([file_url(repo, f"{prefix}/{asset['name']}"), *asset["urls"]]))
        records[asset["name"]] = {**copy.deepcopy(asset), "local": str((directory / "assets" / asset["name"]).resolve())}
    for profile, value in config["profiles"].items():
        file = directory / "assets" / ("sympy-1.14.0-py3-none-any.whl" if profile == "cu128" else "sympy-1.13.1-py3-none-any.whl")
        value["wheels"] = [a for a in value["wheels"] if not a["name"].startswith("sympy-")]
        asset = descriptor(file, repo, prefix)
        value["wheels"].append(asset)
        records[asset["name"]] = {**asset, "local": str(file.resolve())}
    lock = directory / "voxcpm-common-20261018.txt"
    lock.write_bytes((directory / "common-lock.txt").read_bytes())
    config["wheelhouse"] = {"requirements": descriptor(lock, repo, prefix), "files": []}
    records[lock.name] = {**config["wheelhouse"]["requirements"], "local": str(lock.resolve())}
    for file in sorted((directory / "wheels").glob("*.whl")):
        asset = descriptor(file, repo, prefix)
        config["wheelhouse"]["files"].append(asset)
        records[file.name] = {**asset, "local": str(file.resolve())}
    config["distribution"] = {"repository": repo, "prefix": prefix, "source": "modelscope"}
    (FRONTEND / "runtime-config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    plan = {"repository": repo, "prefix": prefix, "files": list(records.values())}
    (directory / "upload-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    public = {"protocol": 1, "files": [{k: a[k] for k in ("name", "size", "sha256")} for a in records.values()]}
    (directory / "manifest.json").write_text(json.dumps(public, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已准备 {len(records)} 项魔搭资源；其中固定依赖 wheel {len(config['wheelhouse']['files'])} 项")
    return plan


def publish_file(api, repo, relative, file, digest):
    existing = next((a for a in api.get_model_files(repo, recursive=True) if a["Path"] == relative), None)
    if existing:
        if existing.get("Sha256") != digest or existing.get("Size") != file.stat().st_size:
            raise ValueError(f"远端存在不同内容，禁止覆盖：{relative}")
        return
    api.upload_file(path_or_fileobj=str(file), path_in_repo=relative, repo_id=repo, commit_message="assets: immutable VoxCPM bootstrap resources")


def publish(directory):
    from modelscope.hub.api import HubApi

    plan = json.loads((directory / "upload-plan.json").read_text(encoding="utf-8"))
    repo, prefix = plan["repository"], plan["prefix"]
    api = HubApi()
    api.get_model(repo)  # 不创建或改变仓库可见性。
    existing = {a["Path"]: a for a in api.get_model_files(repo, recursive=True)}
    publication = directory / "publication"
    publication.mkdir(exist_ok=True)
    missing = []
    def stage(asset):
        file = Path(asset["local"])
        if file.stat().st_size != asset["size"] or sha256(file) != asset["sha256"]:
            raise ValueError(f"本地资源缺失或损坏：{file.name}")
        relative = f"{prefix}/{asset['name']}"
        prior = existing.get(relative)
        if prior:
            if prior.get("Sha256") != asset["sha256"] or prior.get("Size") != asset["size"]:
                raise ValueError(f"远端存在同名不同内容：{relative}")
        else:
            target = publication / asset["name"]
            if not target.exists():
                os.link(file, target)
            elif sha256(target) != asset["sha256"]:
                raise ValueError(f"发布暂存目录中存在不同内容：{target.name}")
            missing.append(asset["name"])
    # 并发校验文件；只通过 SDK 批量接口提交，避免多个 upload_file 争用远端提交锁。
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(stage, plan["files"]))
    if missing:
        api.upload_folder(repo_id=repo, folder_path=str(publication), path_in_repo=prefix, allow_patterns=missing,
                          commit_message="assets: immutable VoxCPM runtime wheelhouse", max_workers=4)
    remote = {a["Path"]: a for a in api.get_model_files(repo, recursive=True)}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for asset in plan["files"]:
        relative = f"{prefix}/{asset['name']}"
        entry = remote.get(relative, {})
        if entry.get("Sha256") != asset["sha256"] or entry.get("Size") != asset["size"]:
            raise ValueError(f"魔搭服务端哈希/大小不一致：{relative}")
        request = urllib.request.Request(file_url(repo, relative), headers={"Range": "bytes=0-31"})
        with opener.open(request, timeout=60) as response:
            received = response.read(32)
        with Path(asset["local"]).open("rb") as stream:
            if received != stream.read(32):
                raise ValueError(f"匿名访问内容不一致：{relative}")
    manifest = directory / "manifest.json"
    publish_file(api, repo, prefix + "/manifest.json", manifest, sha256(manifest))
    report = {"repository": repo, "prefix": prefix, "files": len(plan["files"]), "serverSha256Verified": True,
              "anonymousRangeVerified": True, "autoUpdateActivated": False}
    (directory / "publication.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "builds/modelscope-distribution")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if args.prepare:
        prepare(args.directory.resolve())
    if args.publish:
        publish(args.directory.resolve())
