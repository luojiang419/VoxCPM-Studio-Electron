"""本地配音项目：持久化、分角色生成和可追溯音频导出。"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import shutil
import threading
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import numpy as np
import soundfile as sf


DEFAULT_CONFIG = {"mode": "声音设计", "control": "", "referenceAudio": "", "promptText": "",
                  "selectedLora": "不使用 LoRA", "cfgValue": 2.0, "normalize": False,
                  "denoise": False, "inferenceTimesteps": 10}
COLORS = ["#f6a66d", "#a6b880", "#d6b66b", "#d59683", "#bd8d62", "#b9ae79"]


def timestamp() -> str:
    return datetime.now().isoformat(timespec="milliseconds")


def uid() -> str:
    return uuid.uuid4().hex


def valid_id(value: Any) -> str:
    value = str(value)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise ValueError("ID 只允许 1 到 80 位字母、数字、下划线和连字符。")
    return value


def media_url(path: str) -> str:
    return f"/media?path={quote(path)}" if path else ""


def bounded(value: Any, low: float, high: float, name: str) -> float:
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        raise ValueError(f"{name} 必须在 {low} 到 {high} 之间。")
    return number


def clean_config(config: dict | None) -> dict:
    result = {**DEFAULT_CONFIG, **{k: v for k, v in (config or {}).items() if k in DEFAULT_CONFIG}}
    if result["mode"] not in ("声音设计", "可控克隆", "极致克隆"):
        raise ValueError("未知的生成模式。")
    for key in ("control", "referenceAudio", "promptText", "selectedLora"):
        result[key] = str(result[key] or "").strip()
    result["cfgValue"] = bounded(result["cfgValue"], 1, 3, "CFG")
    result["inferenceTimesteps"] = int(bounded(result["inferenceTimesteps"], 1, 50, "推理步数"))
    result["normalize"], result["denoise"] = bool(result["normalize"]), bool(result["denoise"])
    return result


class WorkspaceStore:
    def __init__(self, root: Path, studio: Any):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "workspace.json"
        self.studio = studio
        self.lock = threading.RLock()
        self.db = {"projects": [], "voices": [], "history": [], "batches": []}
        if self.path.exists():
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
            self.db.update({key: loaded.get(key, []) for key in self.db})

    def _save(self):
        temp = self.path.with_suffix(f".{uid()}.tmp")
        try:
            with temp.open("w", encoding="utf-8") as handle:
                json.dump(self.db, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, self.path)
        finally:
            temp.unlink(missing_ok=True)

    def _find(self, project_id: str) -> dict:
        for project in self.db["projects"]:
            if project["id"] == project_id:
                return project
        raise KeyError("项目不存在。")

    def _fingerprint(self, segment: dict, role: dict) -> str:
        config = clean_config(role.get("config"))
        reference = Path(config["referenceAudio"]) if config["referenceAudio"] else None
        ref_stat = None
        if reference:
            try:
                stat = reference.stat()
                ref_stat = [stat.st_size, stat.st_mtime_ns]
            except OSError:
                ref_stat = "missing"
        content = {"text": segment["text"].strip(), "config": config, "reference": ref_stat}
        return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def _view(self, project: dict) -> dict:
        result = copy.deepcopy(project)
        roles = {r["id"]: r for r in result["roles"]}
        for segment in result["segments"]:
            path = segment.get("audioPath", "")
            role = roles.get(segment["roleId"])
            segment["stale"] = bool(path) and (not Path(path).is_file() or not role or
                segment.get("fingerprint") != self._fingerprint(segment, role))
            segment["previewUrl"] = media_url(path) if path and Path(path).is_file() else ""
        if result.get("lastExport"):
            export = result["lastExport"]
            export["stale"] = (export.get("fingerprint") != self._export_fingerprint(project) or
                               not Path(export.get("outputPath", "")).is_file() or
                               any(s.get("stale") or s.get("status") != "ready" for s in result["segments"]))
        return result

    def _export_fingerprint(self, project: dict) -> str:
        roles = {r["id"]: r for r in project["roles"]}
        segments = [{"id": s["id"], "roleId": s["roleId"], "text": s["text"], "pauseAfterMs": s.get("pauseAfterMs", 300),
                     "audioPath": s.get("audioPath"), "fingerprint": s.get("fingerprint"),
                     "currentFingerprint": self._fingerprint(s, roles[s["roleId"]]) if s["roleId"] in roles else None}
                    for s in project["segments"]]
        music = project.get("backgroundMusic", {})
        music_stat = None
        if music.get("path"):
            try:
                info = Path(music["path"]).stat()
                music_stat = [info.st_size, info.st_mtime_ns]
            except OSError:
                music_stat = "missing"
        content = {"segments": segments, "roles": [{"id": r["id"], "volume": r.get("volume", 1), "pan": r.get("pan", 0), "name": r["name"]} for r in project["roles"]],
                   "backgroundMusic": music, "musicStat": music_stat}
        return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def list_projects(self) -> dict:
        with self.lock:
            return {"items": [self._view(p) for p in sorted(self.db["projects"], key=lambda p: p["updatedAt"], reverse=True)]}

    def get_project(self, project_id: str) -> dict:
        with self.lock:
            return self._view(self._find(project_id))

    def create_project(self, name: str = "") -> dict:
        with self.lock:
            project = {"id": uid(), "name": str(name).strip() or "未命名配音项目", "roles": [self._role("旁白", 0)],
                       "segments": [], "backgroundMusic": {"path": "", "volume": .15},
                       "createdAt": timestamp(), "updatedAt": timestamp()}
            self.db["projects"].append(project)
            self._save()
            return self._view(project)

    @staticmethod
    def _role(name: str, index: int) -> dict:
        return {"id": uid(), "name": name, "color": COLORS[index % len(COLORS)],
                "config": dict(DEFAULT_CONFIG), "volume": 1, "pan": 0}

    def put_project(self, project_id: str, payload: dict) -> dict:
        with self.lock:
            project = self._find(project_id)
            roles = copy.deepcopy(payload.get("roles", project["roles"]))
            segments = copy.deepcopy(payload.get("segments", project["segments"]))
            if not roles or len(roles) > 100 or len(segments) > 5000:
                raise ValueError("项目需要 1 到 100 个角色，最多 5000 段台词。")
            ids = set()
            for role in roles:
                role["id"] = valid_id(role.get("id") or uid())
                if role["id"] in ids:
                    raise ValueError("角色 ID 重复。")
                ids.add(role["id"])
                role["name"] = str(role.get("name") or "未命名角色")[:100]
                role["config"] = clean_config(role.get("config"))
                role["volume"] = bounded(role.get("volume", 1), 0, 2, "角色音量")
                role["pan"] = bounded(role.get("pan", 0), -1, 1, "角色声像")
            segment_ids = set()
            old_segments = {s["id"]: s for s in project["segments"]}
            for segment in segments:
                segment["id"] = valid_id(segment.get("id") or uid())
                if segment["id"] in segment_ids or segment.get("roleId") not in ids:
                    raise ValueError("台词 ID 重复或角色不存在。")
                segment_ids.add(segment["id"])
                segment["text"] = str(segment.get("text", ""))[:50000]
                segment["pauseAfterMs"] = int(bounded(segment.get("pauseAfterMs", 300), 0, 10000, "停顿"))
                # 输出归后端管理，防止陈旧前端保存覆盖刚生成的文件。
                previous = old_segments.get(segment["id"], {})
                for key, default in (("audioPath", ""), ("duration", 0), ("status", "pending"), ("error", ""), ("fingerprint", "")):
                    segment[key] = previous.get(key, default)
                segment.pop("previewUrl", None)
                segment.pop("stale", None)
            music = copy.deepcopy(payload.get("backgroundMusic", project.get("backgroundMusic", {})))
            music = {"path": str(music.get("path", "")), "volume": bounded(music.get("volume", .15), 0, 2, "背景音乐音量")}
            project.update(name=str(payload.get("name", project["name"])).strip()[:200] or "未命名配音项目",
                           roles=roles, segments=segments, backgroundMusic=music, updatedAt=timestamp())
            self._save()
            return self._view(project)

    def delete_project(self, project_id: str) -> dict:
        with self.lock:
            self._find(project_id)
            self.db["projects"] = [p for p in self.db["projects"] if p["id"] != project_id]
            self._save()
            return {"ok": True}

    @staticmethod
    def split_text(text: str, max_chars: int) -> list[str]:
        pieces, current = [], ""
        for sentence in re.findall(r"[^。！？!?；;\n]+[。！？!?；;]?|[。！？!?；;]", text):
            sentence = sentence.strip()
            while len(sentence) > max_chars:
                if current:
                    pieces.append(current)
                    current = ""
                split = max(sentence.rfind("，", 0, max_chars + 1), sentence.rfind(",", 0, max_chars + 1), sentence.rfind(" ", 0, max_chars + 1))
                cut = split + 1 if split > max_chars // 3 else max_chars
                pieces.append(sentence[:cut].strip())
                sentence = sentence[cut:].strip()
            if len(current) + len(sentence) > max_chars and current:
                pieces.append(current)
                current = ""
            current += sentence
        if current:
            pieces.append(current)
        return pieces

    def parse(self, project_id: str, text: str, max_chars: int = 120, format: str = "auto") -> dict:
        max_chars = int(bounded(max_chars, 10, 2000, "分段字数"))
        if not text.strip() or len(text) > 500000:
            raise ValueError("请提供非空文案，最大 50 万字符。")
        project = self.get_project(project_id)
        text = text.replace("\r\n", "\n").lstrip("\ufeff")
        is_srt = format == "srt" or (format == "auto" and "-->" in text)
        if is_srt:
            lines = []
            for block in re.split(r"\n\s*\n", text):
                block_lines = block.strip().splitlines()
                timing = next((i for i, line in enumerate(block_lines) if "-->" in line), -1)
                if timing >= 0:
                    lines.append(" ".join(block_lines[timing + 1:]))
            if not lines:
                raise ValueError("未识别到 SRT 字幕。")
        else:
            lines = text.splitlines()
        roles = project["roles"]
        by_name = {r["name"]: r for r in roles}
        current = roles[0]
        segments = []
        for line in lines:
            for token in re.split(r"(\{[^{}\n]{1,100}\})", line):
                if not token.strip():
                    continue
                if token.startswith("{") and token.endswith("}"):
                    name = token[1:-1].strip()
                    if name not in by_name:
                        by_name[name] = self._role(name, len(roles))
                        roles.append(by_name[name])
                    current = by_name[name]
                    continue
                match = re.match(r"^\s*([^:：\n]{1,30})[:：]\s*(.+)$", token)
                if match and not re.match(r"https?$", match.group(1), re.I):
                    name, token = match.group(1).strip(), match.group(2)
                    if name not in by_name:
                        by_name[name] = self._role(name, len(roles))
                        roles.append(by_name[name])
                    current = by_name[name]
                for piece in self.split_text(token, max_chars):
                    segments.append({"id": uid(), "roleId": current["id"], "text": piece, "pauseAfterMs": 300})
        if not segments:
            raise ValueError("文案中没有可生成的台词。")
        project["segments"] = segments
        return self.put_project(project_id, project)

    def voices(self) -> dict:
        with self.lock:
            return {"items": [self._voice_view(voice) for voice in self.db["voices"]]}

    @staticmethod
    def _voice_view(voice: dict) -> dict:
        result = copy.deepcopy(voice)
        preview = result.get("previewAudio") or result.get("config", {}).get("referenceAudio", "")
        if preview:
            result["previewUrl"] = media_url(preview) if Path(preview).is_file() else ""
        return result

    def add_voice(self, payload: dict) -> dict:
        return self._write_voice(payload)

    def update_voice(self, voice_id: str, payload: dict) -> dict:
        with self.lock:
            previous = next((voice for voice in self.db["voices"] if voice["id"] == voice_id), None)
            if previous is None:
                raise KeyError("音色不存在。")
            return self._write_voice(payload, previous)

    def _write_voice(self, payload: dict, previous: dict | None = None) -> dict:
        config = clean_config(payload.get("config"))
        design_config = copy.deepcopy(config)
        reference = Path(config["referenceAudio"]) if config["referenceAudio"] else None
        preview = Path(str(payload.get("previewAudio") or "")) if payload.get("previewAudio") else None
        if reference and not reference.is_file():
            raise ValueError("参考音频文件不存在。")
        if preview and not preview.is_file():
            raise ValueError("试听音频文件不存在，请重新生成后保存。")
        voice_id = previous["id"] if previous else uid()
        # 更新使用新目录，保留已应用角色使用的历史参考，也避免失败时破坏旧音色。
        folder = self.root / "voices" / (uid() if previous else voice_id)
        written: list[Path] = []
        created_folder = False
        try:
            if reference or preview:
                folder.mkdir(parents=True)
                created_folder = True
            preview_target = None
            if preview:
                preview_target = folder / f"preview{preview.suffix}"
                written.append(preview_target)
                shutil.copy2(preview, preview_target)
            if reference:
                target = preview_target if preview and reference.resolve() == preview.resolve() else folder / f"reference{reference.suffix}"
                if target != preview_target:
                    written.append(target)
                    shutil.copy2(reference, target)
                config["referenceAudio"] = design_config["referenceAudio"] = str(target)
            voice = {"id": voice_id, "name": str(payload.get("name", "")).strip()[:100] or "新音色",
                     "tags": [str(t)[:40] for t in payload.get("tags", [])][:20], "config": config,
                     "createdAt": previous["createdAt"] if previous else timestamp(),
                     "sampleText": str(payload.get("sampleText") or "")[:50000]}
            if previous:
                voice["updatedAt"] = timestamp()
            if preview_target:
                voice.update(previewAudio=str(preview_target), sampleText=str(payload.get("sampleText") or "")[:50000],
                             sourceMode=design_config["mode"], designConfig=design_config)
                if config["mode"] == "声音设计":
                    # 设计出的声音成为固定参考，配音应用时不再随机重新设计音色。
                    config["mode"] = "可控克隆"
                    config["referenceAudio"] = str(preview_target)
            with self.lock:
                old_voices = self.db["voices"]
                self.db["voices"] = ([voice if item["id"] == voice_id else item for item in old_voices]
                                     if previous else [voice, *old_voices])
                try:
                    self._save()
                except BaseException:
                    self.db["voices"] = old_voices
                    raise
            return self._voice_view(voice)
        except BaseException:
            for target in written:
                target.unlink(missing_ok=True)
            if created_folder:
                folder.rmdir()
            raise

    def delete_voice(self, voice_id: str) -> dict:
        with self.lock:
            self.db["voices"] = [v for v in self.db["voices"] if v["id"] != voice_id]
            # 只删除收藏记录，已应用角色仍然可使用复制的参考音频。
            self._save()
            return {"ok": True}

    def history(self) -> dict:
        with self.lock:
            return {"items": [{**copy.deepcopy(item), "previewUrl": media_url(item.get("audioPath", ""))}
                              for item in self.db["history"]]}

    def record_single(self, result: dict, config: dict, text: str) -> None:
        """将原工作台的输出纳入历史，复制快照以免同秒生成覆盖。"""
        history_id = uid()
        folder = self.root / "audio" / "single" / history_id
        folder.mkdir(parents=True, exist_ok=True)
        audio_path = folder / "single.wav"
        shutil.copy2(result["output_path"], audio_path)
        try:
            duration = sf.info(str(audio_path)).duration
        except RuntimeError:
            duration = 0
        with self.lock:
            self.db["history"].insert(0, {"id": history_id, "kind": "single", "projectId": "", "projectName": "单条创作",
                "text": text, "config": clean_config(config), "audioPath": str(audio_path), "duration": duration, "createdAt": timestamp()})
            self._save()

    def record_batch(self, result: dict) -> None:
        """保存清单索引，保持音频与归档在用户选择的输出目录。"""
        self.index_batches([Path(result["manifest_path"])])

    def index_batches(self, manifests) -> None:
        """切换输出位置前登记旧批量，保留清单原始时间。"""
        with self.lock:
            known = {row["manifestPath"] for row in self.db["batches"]}
            changed = False
            for path in manifests:
                manifest = str(path.resolve())
                if manifest in known:
                    continue
                try:
                    created_at = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
                except FileNotFoundError:
                    continue
                self.db["batches"].append({"manifestPath": manifest, "createdAt": created_at})
                known.add(manifest)
                changed = True
            if changed:
                self._save()

    def generate(self, project_id: str, segment_ids: list[str] | None, force: bool,
                 progress: Callable[[int, int, str], None], cancelled: Callable[[], bool]) -> dict:
        project = self.get_project(project_id)
        roles = {r["id"]: r for r in project["roles"]}
        known_ids = {s["id"] for s in project["segments"]}
        if segment_ids is not None and (not segment_ids or set(segment_ids) - known_ids):
            raise ValueError("选择的台词不存在或为空。")
        candidates = [s for s in project["segments"] if segment_ids is None or s["id"] in segment_ids]
        candidates = [s for s in candidates if force or s.get("status") != "ready" or s.get("stale")]
        if not project["segments"]:
            raise ValueError("请先添加台词。")
        run_root = self.root / "audio" / project_id / uid()
        run_root.mkdir(parents=True, exist_ok=True)
        generated, failed, completed = 0, 0, 0
        progress(0, len(candidates), "等待生成" if candidates else "所有台词均已生成且有效")
        for segment in candidates:
            if cancelled():
                break
            role = roles[segment["roleId"]]
            fingerprint = self._fingerprint(segment, role)
            config = clean_config(role.get("config"))
            progress(completed, len(candidates), f"正在生成：{role['name']} · {segment['text'][:30]}")
            try:
                if not segment["text"].strip():
                    raise ValueError("台词文本不能为空。")
                result = self.studio.generate_audio_payload(mode=config["mode"], text=segment["text"], control=config["control"],
                    reference_audio=config["referenceAudio"] or None, prompt_text=config["promptText"], selected_lora=config["selectedLora"],
                    cfg_value=config["cfgValue"], normalize=config["normalize"], denoise=config["denoise"], inference_timesteps=config["inferenceTimesteps"])
                target = run_root / f"{segment['id']}.wav"
                shutil.copy2(result["output_path"], target)
                info = sf.info(str(target))
                if not info.frames:
                    raise ValueError("生成结果为空音频。")
                update = {"audioPath": str(target), "duration": info.duration, "status": "ready", "error": "", "fingerprint": fingerprint}
                history = {"id": uid(), "kind": "segment", "projectId": project_id, "projectName": project["name"],
                    "segmentId": segment["id"], "roleName": role["name"], "text": segment["text"], "config": config,
                    "audioPath": str(target), "duration": info.duration, "createdAt": timestamp()}
                generated += 1
            except Exception as exc:
                update = {"status": "failed", "error": str(exc)}
                history = None
                failed += 1
            with self.lock:
                current = self._find(project_id)
                for saved in current["segments"]:
                    if saved["id"] == segment["id"]:
                        current_role = next((r for r in current["roles"] if r["id"] == saved["roleId"]), None)
                        if current_role and self._fingerprint(saved, current_role) == fingerprint:
                            saved.update(update)
                        break
                if history:
                    self.db["history"].insert(0, history)
                current["updatedAt"] = timestamp()
                self._save()
            completed += 1
            progress(completed, len(candidates), f"已处理 {completed}/{len(candidates)} 段，失败 {failed} 段")
        was_cancelled = cancelled()
        return {"project": self.get_project(project_id), "generatedCount": generated, "failedCount": failed,
                "cancelled": was_cancelled, "status": "已取消，已完成片段已保存。" if was_cancelled else f"生成完成：成功 {generated} 段，失败 {failed} 段。"}

    @staticmethod
    def _stereo(audio: np.ndarray, volume: float = 1, pan: float = 0) -> np.ndarray:
        if audio.ndim == 1:
            audio = np.column_stack([audio, audio])
        elif audio.shape[1] == 1:
            audio = np.repeat(audio, 2, axis=1)
        elif audio.shape[1] > 2:
            audio = audio[:, :2]
        return audio * np.array([math.sqrt(1 - max(pan, 0)), math.sqrt(1 + min(pan, 0))]) * volume

    @staticmethod
    def _srt_time(seconds: float) -> str:
        ms = round(seconds * 1000)
        return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"

    def export(self, project_id: str) -> dict:
        project = self.get_project(project_id)
        if not project["segments"]:
            raise ValueError("项目没有台词。")
        invalid = [s for s in project["segments"] if s.get("status") != "ready" or s.get("stale") or not s.get("audioPath")]
        if invalid:
            raise ValueError(f"有 {len(invalid)} 段未生成、失败或已过期，请先生成有效音频。")
        roles = {r["id"]: r for r in project["roles"]}
        folder = self.root / "exports" / project_id / uid()
        (folder / "segments").mkdir(parents=True, exist_ok=True)
        (folder / "roles").mkdir(exist_ok=True)
        chunks, subtitles, manifest, role_chunks = [], [], [], {}
        sample_rate = None
        cursor = 0
        for i, segment in enumerate(project["segments"]):
            audio, rate = sf.read(segment["audioPath"], dtype="float32", always_2d=True)
            if sample_rate is not None and rate != sample_rate:
                raise ValueError("片段采样率不一致，请重新生成所有台词。")
            sample_rate = rate
            role = roles[segment["roleId"]]
            audio = self._stereo(audio, role["volume"], role["pan"])
            duration = len(audio) / rate
            name = f"{i + 1:04d}_{segment['id']}.wav"
            sf.write(str(folder / "segments" / name), np.clip(audio, -1, 1), rate, subtype="PCM_16")
            chunks.append(audio)
            role_chunks.setdefault(role["id"], []).append(audio)
            start, end = cursor / rate, (cursor + len(audio)) / rate
            subtitles.append(f"{i + 1}\n{self._srt_time(start)} --> {self._srt_time(end)}\n{segment['text']}\n")
            manifest.append({"index": i + 1, "segmentId": segment["id"], "roleId": role["id"], "roleName": role["name"],
                             "text": segment["text"], "start": start, "end": end, "duration": duration, "file": f"segments/{name}"})
            cursor += len(audio)
            if i < len(project["segments"]) - 1:
                silence = np.zeros((round(rate * segment["pauseAfterMs"] / 1000), 2), dtype=np.float32)
                chunks.append(silence)
                role_chunks[role["id"]].append(silence)
                cursor += len(silence)
        merged = np.concatenate(chunks)
        music = project.get("backgroundMusic", {})
        if music.get("path") and music.get("volume", 0) > 0:
            music_path = Path(music["path"])
            if not music_path.is_file() or music_path.suffix.lower() != ".wav":
                raise ValueError("背景音乐需要选择有效 WAV 文件。")
            bgm, bgm_rate = sf.read(str(music_path), dtype="float32", always_2d=True)
            if not len(bgm):
                raise ValueError("背景音乐为空。")
            if bgm_rate != sample_rate:
                new_length = max(1, round(len(bgm) * sample_rate / bgm_rate))
                old_x = np.arange(len(bgm))
                new_x = np.arange(new_length) * bgm_rate / sample_rate
                bgm = np.column_stack([np.interp(new_x, old_x, bgm[:, channel]) for channel in range(bgm.shape[1])])
            bgm = self._stereo(bgm, music["volume"])
            bgm = np.tile(bgm, (math.ceil(len(merged) / len(bgm)), 1))[:len(merged)]
            merged = merged + bgm
        peak = float(np.max(np.abs(merged)))
        if peak > .99:
            merged *= .99 / peak
        output = folder / "full.wav"
        sf.write(str(output), merged, sample_rate, subtype="PCM_16")
        for role_id, parts in role_chunks.items():
            safe_name = re.sub(r'[^\w\-]', '_', roles[role_id]["name"])[:60] or "role"
            sf.write(str(folder / "roles" / f"{safe_name}_{role_id[:8]}.wav"), np.clip(np.concatenate(parts), -1, 1), sample_rate, subtype="PCM_16")
        srt = folder / "subtitles.srt"
        srt.write_text("\n".join(subtitles), encoding="utf-8-sig")
        (folder / "manifest.json").write_text(json.dumps({"project": project, "segments": manifest,
            "sampleRate": sample_rate, "duration": len(merged) / sample_rate, "peakNormalized": peak > .99}, ensure_ascii=False, indent=2), encoding="utf-8")
        archive = folder.with_suffix(".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zip_out:
            for file in folder.rglob("*"):
                if file.is_file():
                    zip_out.write(file, file.relative_to(folder))
        result = {"outputPath": str(output), "archivePath": str(archive), "srtPath": str(srt),
                  "previewUrl": media_url(str(output)), "duration": len(merged) / sample_rate}
        with self.lock:
            saved = self._find(project_id)
            # 使用导出时的快照指纹；期间被编辑的项目会立即呈现 stale。
            saved["lastExport"] = {**result, "fingerprint": self._export_fingerprint(project), "createdAt": timestamp()}
            self.db["history"].insert(0, {"id": uid(), "kind": "export", "projectId": project_id,
                "projectName": project["name"], "audioPath": str(output), "duration": result["duration"], "createdAt": timestamp()})
            self._save()
        return {**result, "project": self.get_project(project_id)}
