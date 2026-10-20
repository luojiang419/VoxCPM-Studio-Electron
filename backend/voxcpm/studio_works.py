"""只读汇总各创作入口的作品，兼容已有作品与批量清单。"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


def file_date(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        return ""


def collect_works(workspace, music, lipsync, output_dir: str) -> dict:
    items, warnings = [], []

    def media_item(category, record_id, title, subtitle, path, created_at, duration=0, **extra):
        path = str(path or "")
        return {"id": f"{category}:{record_id}", "category": category, "title": title,
                "subtitle": subtitle, "outputPath": path, "createdAt": created_at or (file_date(Path(path)) if path else ""),
                "duration": duration, "available": bool(path) and Path(path).is_file(),
                "previewUrl": "/media?path=" + quote(path) if path else "", **extra}

    for record in workspace.history()["items"]:
        category = "voice" if record.get("kind") == "single" else "dubbing"
        config = record.get("config") or {}
        title = (record.get("text", "").strip().split("\n")[0][:32] or "声音作品") if category == "voice" else record.get("projectName") or "配音作品"
        items.append(media_item(category, record["id"], title,
            record.get("text") or Path(record.get("audioPath", "")).name, record.get("audioPath"),
            record.get("createdAt"), record.get("duration", 0), projectId=record.get("projectId", ""),
            label=config.get("mode", "声音创作") if category == "voice" else "分段音频" if record.get("segmentId") else "完整作品",
            config=config if category == "voice" and config else None))

    for category, service, label in [("music", music, "音乐创作"), ("video", lipsync, "视频对口型")]:
        try:
            for record in service.results(limit=None):
                path = record["outputPath"]
                items.append(media_item(category, path, record.get("title") or Path(record.get("sourcePath") or path).stem,
                    (record.get("packet", {}).get("draft", {}).get("captionZh") or record.get("modelId", ""))
                    if category == "music" else Path(record.get("sourcePath", "")).name,
                    path, record.get("createdAt") or file_date(Path(path).parent / "result.json"), record.get("duration", 0),
                    label=(record.get("modelId") or label) if category == "music" else "照片说话" if record.get("mode") == "photo" else label,
                    modelId=record.get("modelId", "")))
        except (OSError, ValueError, KeyError, TypeError):
            warnings.append(f"{label}记录读取失败，请刷新重试。")

    # 历史批量未写入数据库，通过原清单自动发现；新批量保存索引，输出目录切换后仍可找到。
    with workspace.lock:
        indexed = list(workspace.db.get("batches", []))
    manifests = {str(Path(row["manifestPath"]).resolve()): row for row in indexed}
    for path in (Path(output_dir) / "batch").glob("*/manifest.json"):
        manifests.setdefault(str(path.resolve()), {"manifestPath": str(path)})
    for key, record in manifests.items():
        manifest = Path(key)
        try:
            rows = json.loads(manifest.read_text(encoding="utf-8"))
            if not isinstance(rows, list):
                raise ValueError("无效批量清单")
            for row in rows:
                output = (manifest.parent / row["output_file"]).resolve()
                if output.parent != manifest.parent:
                    raise ValueError("批量文件超出作品目录")
                item = media_item("batch", str(output), manifest.parent.name, row.get("text", ""), output,
                    record.get("createdAt") or file_date(manifest), label=f"第 {row.get('index', 1)} 条 · 共 {len(rows)} 条",
                    archivePath=str(manifest.parent.with_suffix(".zip")),
                    archiveAvailable=manifest.parent.with_suffix(".zip").is_file(), duration=None)
                items.append(item)
        except (OSError, ValueError, KeyError, TypeError):
            warnings.append(f"批量作品「{manifest.parent.name}」清单缺失或损坏。")

    def order(item):
        try:
            date = datetime.fromisoformat(item["createdAt"].replace("Z", "+00:00"))
            return date.timestamp()
        except (ValueError, TypeError):
            return 0

    items.sort(key=order, reverse=True)
    # 使用短且稳定的标识，文件路径仍保留在 outputPath。
    for item in items:
        item["id"] = hashlib.sha256(item["id"].encode("utf-8")).hexdigest()[:24]
    return {"items": items, "warnings": warnings}
