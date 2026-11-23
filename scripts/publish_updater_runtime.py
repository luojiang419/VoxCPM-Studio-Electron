"""发布固定哈希的独立更新运行环境，供客户端自动补齐或自修复。"""
import hashlib
import json
from pathlib import Path

from build_updater_runtime import build
from release_update import FRONTEND, read_remote


def publish():
    from modelscope.hub.api import HubApi
    _, archive, profile = build()
    config = json.loads((FRONTEND / "update-config.json").read_text("utf-8"))
    repo = config["repository"]
    remote = f"runtime/updater/{profile['id']}/VoxCPM-Updater-Runtime.zip"
    expected = profile["package"]["sha256"]
    url = profile["package"]["urls"][0]
    api = HubApi()
    files = {item["Path"] for item in api.get_model_files(repo, recursive=True) if item["Type"] == "blob"}
    if remote in files:
        if hashlib.sha256(read_remote(url)).hexdigest() != expected:
            raise ValueError("远端同名运行环境不同，禁止覆盖")
    else:
        api.upload_file(path_or_fileobj=str(archive), path_in_repo=remote, repo_id=repo, commit_message="runtime: independent updater Python")
    data = read_remote(url)
    if len(data) != profile["package"]["size"] or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("独立更新运行环境匿名回读失败")
    report = {"id": profile["id"], "repository": repo, "url": url, "size": len(data), "sha256": expected, "anonymousVerification": True}
    archive.with_suffix(".publication.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    publish()
