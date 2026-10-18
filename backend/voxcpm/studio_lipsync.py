"""本地视频对口型：任务隔离、媒体预处理及结果保存，不在TTS进程加载视频依赖。"""
from __future__ import annotations

from collections import deque
import gc
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import uuid
from urllib.parse import quote

from .lipsync_profiles import PROFILES, detect_hardware, load_manifest, select_profile


class LipSyncCancelled(Exception):
    pass


class LipSyncOutOfMemory(RuntimeError):
    pass


class LipSyncService:
    def __init__(self, data_root: Path, studio):
        self.data_root = data_root
        self.studio = studio
        self.config_path = data_root / "lipsync-settings.json"
        self.active = False
        self.lock = threading.Lock()

    def hardware(self):
        return detect_hardware()

    def root(self):
        override = os.environ.get("VOXCPM_LIPSYNC_ROOT", "").strip()
        if not override and self.config_path.is_file():
            try:
                override = json.loads(self.config_path.read_text(encoding="utf-8")).get("root", "")
            except (OSError, ValueError):
                override = ""
        if override:
            return Path(override).expanduser().resolve()
        # 源码与本机便携版可复用已安装的大体积模型，不复制权重。
        local = self.data_root / "lipsync"
        if (local / "runtime.json").is_file():
            return local.resolve()
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "data/lipsync"
            if (candidate / "runtime.json").is_file():
                return candidate
        return local.resolve()

    def configure(self, root: str):
        target = Path(root).expanduser()
        if not root.strip() or not target.is_dir():
            raise ValueError("请选择已安装视频模型的目录。")
        with self.lock:
            if self.active:
                raise ValueError("视频任务进行中，暂不能切换模型目录。")
            status = self.status(target.resolve())
            if not status["installedVersions"]:
                raise ValueError("请选择完整的 LatentSync 1.5 / 1.6 环境。缺少：" + "、".join(status["missing"]))
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.config_path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"root": str(target.resolve())}, ensure_ascii=False), encoding="utf-8")
            temporary.replace(self.config_path)
        return self.status()

    def ffmpeg(self, root=None):
        bundled = (root or self.root()) / "tools/ffmpeg.exe"
        if bundled.is_file():
            return str(bundled)
        configured = str(self.studio.runtime_summary_payload().get("ffmpeg_path", ""))
        return configured if configured and Path(configured).is_file() else shutil.which("ffmpeg") or ""

    def ffprobe(self, ffmpeg=None, root=None):
        bundled = (root or self.root()) / "tools/ffprobe.exe"
        sibling = Path(ffmpeg or self.ffmpeg()).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe") if ffmpeg or self.ffmpeg() else None
        return str(bundled) if bundled.is_file() else str(sibling) if sibling and sibling.is_file() else shutil.which("ffprobe") or ""

    def status(self, root=None, model_version="auto"):
        root = root or self.root()
        required = ["env/Scripts/python.exe", "source/checkpoints/whisper/tiny.pt",
                    "source/checkpoints/vae/config.json", "source/checkpoints/vae/diffusion_pytorch_model.safetensors",
                    "source/checkpoints/auxiliary/models/buffalo_l/det_10g.onnx",
                    "source/checkpoints/auxiliary/models/buffalo_l/2d106det.onnx"]
        common_missing = [name for name in required if not (root / name).is_file()]
        models = {}
        manifests = {}
        for version, profile in PROFILES.items():
            missing = list(common_missing)
            for name in (profile["config"], profile["checkpoint"]):
                if not (root / "source" / name).is_file():
                    missing.append("source/" + name)
            manifest = load_manifest(root, version)
            if not manifest:
                missing.append(f"LatentSync {version} 运行清单（缺失或不匹配）")
            manifests[version] = manifest
            models[version] = {"ready": not missing, "missing": missing, "resolution": profile["resolution"]}
        ffmpeg = self.ffmpeg(root)
        probe = self.ffprobe(ffmpeg, root)
        if not ffmpeg:
            common_missing.append("ffmpeg.exe")
        if not probe:
            common_missing.append("ffprobe.exe")
        installed = [v for v, m in models.items() if m["ready"] and not common_missing]
        hardware = self.hardware()
        selected, reason = select_profile(hardware, installed, model_version)
        missing = list(common_missing) + ([] if selected else [reason])
        if not installed:
            missing = list(dict.fromkeys(missing + [item for m in models.values() for item in m["missing"]]))
        profile = PROFILES.get(selected, {})
        return {"ready": bool(selected) and not missing, "engine": f"LatentSync {selected}" if selected else "LatentSync",
                "root": str(root), "selectedVersion": selected, "requestedVersion": model_version,
                "installedVersions": installed, "models": models, "hardware": hardware, "selectionReason": reason,
                "missing": missing, "ffmpeg": ffmpeg, "ffprobe": probe, "active": self.active,
                "profile": f"{profile.get('resolution', '—')}px · 16帧 · VAE分帧 · CPU人脸检测",
                "validation": manifests.get(selected, {}).get("validation"),
                "maxDuration": 120}

    def probe(self, path: Path):
        ffmpeg = self.ffmpeg()
        if not ffmpeg:
            raise ValueError("未找到 FFmpeg，请先检查运行环境。")
        executable = self.ffprobe(ffmpeg)
        if not executable:
            raise ValueError("未找到 ffprobe，无法检查媒体时长。")
        result = subprocess.run([executable, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise ValueError("无法读取媒体文件：" + path.name + "。" + result.stderr[-500:])
        return json.loads(result.stdout)

    def validate(self, payload):
        source, audio = Path(payload.source_path).expanduser().resolve(), Path(payload.audio_path).expanduser().resolve()
        extensions = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"} if payload.mode == "video" else {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
        if not source.is_file() or source.suffix.lower() not in extensions:
            raise ValueError("请选择有效的" + ("视频" if payload.mode == "video" else "照片") + "文件。")
        if not audio.is_file() or audio.suffix.lower() not in {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".wma"}:
            raise ValueError("请选择有效的配音文件，或从已生成的声音中选择。")
        if not any(s.get("codec_type") == "video" for s in self.probe(source).get("streams", [])):
            raise ValueError("素材中没有可读取的画面。")
        metadata = self.probe(audio)
        if not any(s.get("codec_type") == "audio" for s in metadata.get("streams", [])):
            raise ValueError("配音文件中没有音频轨道。")
        try:
            duration = float(metadata["format"]["duration"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("无法确定配音时长，请转为 WAV 后重试。") from exc
        if not .32 <= duration <= 120:
            raise ValueError("当前支持 0.32～120 秒的配音，请将长视频分段处理。")
        return source, audio, duration

    @staticmethod
    def _stop(process):
        if process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
        else:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def _process(self, command, work, progress, cancelled, log, timeout=7200):
        environment = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                       "PYTHONUTF8": "1", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
        environment.pop("PYTHONPATH", None)
        environment["PATH"] = str(Path(self.ffmpeg()).parent) + os.pathsep + environment.get("PATH", "")
        process = subprocess.Popen(command, cwd=work, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace",
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        lines = queue.Queue()

        def read():
            for line in process.stdout:
                lines.put(line)
            lines.put(None)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        tail = deque(maxlen=25)
        deadline = time.monotonic() + timeout
        ended = False
        try:
            while not ended or process.poll() is None:
                if cancelled():
                    raise LipSyncCancelled()
                if time.monotonic() > deadline:
                    raise RuntimeError("视频任务执行超时，请查看日志。")
                try:
                    line = lines.get(timeout=.15)
                except queue.Empty:
                    continue
                if line is None:
                    ended = True
                    continue
                log.write(line)
                log.flush()
                tail.append(line)
                if line.startswith("__VOXCPM_LIPSYNC__"):
                    event = json.loads(line[len("__VOXCPM_LIPSYNC__"):])
                    progress(int(event.get("progress", 0)), event.get("text", "推理中"))
            if process.returncode:
                detail = "".join(tail)[-3500:]
                if "cuda out of memory" in detail.lower() or "cuda error: out of memory" in detail.lower():
                    raise LipSyncOutOfMemory("显存不足。请关闭其他占用显卡的程序，再重试；详细信息见本次任务日志。")
                if "Face not detected" in detail:
                    raise ValueError("部分画面未检测到人脸。请使用单人、正面或轻微侧脸、无遮挡的连续镜头。")
                raise RuntimeError("视频处理失败：" + detail)
        finally:
            self._stop(process)
            reader.join(timeout=2)
            process.stdout.close()

    def generate(self, payload, progress, cancelled):
        with self.lock:
            if self.active:
                raise ValueError("已有视频任务进行中。")
            self.active = True
        try:
            if cancelled():
                raise LipSyncCancelled()
            training = getattr(self.studio, "training_status_payload", lambda: {})()
            if training.get("running") or getattr(self.studio, "_training_is_running", lambda: False)():
                raise ValueError("LoRA训练正在占用显卡，请先停止训练。")
            requested = getattr(payload, "model_version", "auto")
            status = self.status(model_version=requested)
            if not status["ready"]:
                raise ValueError("视频模型尚未就绪：" + "、".join(status["missing"]))
            source, audio, duration = self.validate(payload)
            # 与TTS共用单线程队列；视频子进程启动前释放主进程的语音模型。
            reset = getattr(self.studio, "reset_runtime", None)
            if reset:
                reset()
                gc.collect()
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            status = self.status(model_version=requested)
            if not status["ready"]:
                raise ValueError(status["selectionReason"])
            selected = status["selectedVersion"]
            minimum_free = (6144 if requested == "1.6" else 7168) if selected == "1.6" else 4096
            if status["hardware"]["freeMB"] < minimum_free:
                raise ValueError(f"LatentSync {selected} 当前空闲显存不足 {minimum_free // 1024} GB，任务已停止并保留模型选择。请关闭其他占用显卡的程序后重试。")
            initial_version = selected
            job_id = uuid.uuid4().hex
            work = self.data_root / "lipsync-jobs" / job_id
            work.mkdir(parents=True)
            log_path = work / "task.log"
            root = self.root()
            with log_path.open("w", encoding="utf-8") as log:
                progress(1, "准备配音与画面")
                self._process([self.ffmpeg(), "-v", "error", "-y", "-nostdin", "-i", str(audio), "-vn", "-ar", "16000", "-ac", "1", "audio.wav"], work, progress, cancelled, log, 120)
                video_args = [self.ffmpeg(), "-v", "error", "-y", "-nostdin"]
                if payload.mode == "photo":
                    video_args += ["-loop", "1"]
                elif payload.short_video == "loop":
                    video_args += ["-stream_loop", "-1"]
                video_args += ["-i", str(source), "-t", str(duration), "-an"]
                filters = "scale=w='if(gte(iw,ih),min(1920,iw),min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=25"
                if payload.mode == "video" and payload.short_video == "hold":
                    filters += ",tpad=stop_mode=clone:stop_duration=120"
                video_args += ["-vf", filters, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "input.mp4"]
                self._process(video_args, work, progress, cancelled, log, 300)
                runner = Path(__file__).with_name("lipsync_runner.py")
                def infer(version):
                    if cancelled():
                        raise LipSyncCancelled()
                    progress(2, f"使用 LatentSync {version} 低显存模式")
                    self._process([str(root / "env/Scripts/python.exe"), "-u", str(runner), "--root", str(root),
                                   "--work", str(work), "--model-version", version, "--steps", str(payload.steps),
                                   "--guidance", str(payload.guidance), "--seed", str(payload.seed)], work, progress, cancelled, log)
                try:
                    infer(selected)
                except LipSyncOutOfMemory as exc:
                    if cancelled():
                        raise LipSyncCancelled()
                    raise LipSyncOutOfMemory(f"LatentSync {selected} 显存不足，任务已停止并保留模型选择。请关闭其他占用显卡的程序后重试；详细信息见本次任务日志。") from exc
                progress(99, "合并高质量配音")
                output_dir = Path(self.studio.settings_payload()["output_dir"]) / "lipsync"
                output_dir.mkdir(parents=True, exist_ok=True)
                output = output_dir / f"{payload.mode}_{job_id[:12]}.mp4"
                temporary = work / "final.mp4"
                self._process([self.ffmpeg(), "-v", "error", "-y", "-nostdin", "-i", "synced.mp4", "-i", str(audio),
                               "-map", "0:v:0", "-map", "1:a:0", "-t", str(duration), "-c:v", "copy", "-c:a", "aac",
                               "-b:a", "192k", "-movflags", "+faststart", str(temporary)], work, progress, cancelled, log, 120)
                metadata = self.probe(temporary)
                if not {"video", "audio"}.issubset({s.get("codec_type") for s in metadata.get("streams", [])}):
                    raise RuntimeError("输出缺少画面或声音轨道。")
                if cancelled():
                    raise LipSyncCancelled()
                report = json.loads((work / "inference.json").read_text(encoding="utf-8"))
                if report.get("engine") != f"LatentSync {selected}" or report.get("resolution") != PROFILES[selected]["resolution"]:
                    raise RuntimeError("生成结果与所选 LatentSync 配置不匹配。")
                report.update({"requestedVersion": requested, "initialVersion": initial_version,
                               "selectedVersion": selected, "fallbackReason": "",
                               "selectionReason": status["selectionReason"], "hardware": status["hardware"]})
                result = {"status": "视频生成完成。", "outputPath": str(output), "previewUrl": f"/media?path={quote(str(output))}",
                          "duration": float(metadata["format"]["duration"]), "logPath": str(log_path), "report": report,
                          "mode": payload.mode, "sourcePath": str(source), "audioPath": str(audio)}
                pending = output.with_suffix(".pending.mp4")
                try:
                    shutil.copy2(temporary, pending)
                    if cancelled():
                        raise LipSyncCancelled()
                    pending.replace(output)
                    try:
                        record = work / "result.pending.json"
                        record.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                        record.replace(work / "result.json")
                    except Exception:
                        output.unlink(missing_ok=True)
                        raise
                finally:
                    pending.unlink(missing_ok=True)
                progress(100, "视频生成完成")
                return result
        except LipSyncCancelled:
            return {"cancelled": True, "status": "视频任务已取消，已释放推理进程。"}
        finally:
            with self.lock:
                self.active = False

    def results(self):
        jobs = self.data_root / "lipsync-jobs"
        if not jobs.is_dir():
            return []
        results = []
        for path in sorted(jobs.glob("*/result.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
            try:
                result = json.loads(path.read_text(encoding="utf-8"))
                if Path(result["outputPath"]).is_file():
                    results.append(result)
            except (OSError, ValueError, KeyError):
                continue
        return results
