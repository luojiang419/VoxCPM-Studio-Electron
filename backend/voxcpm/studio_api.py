from __future__ import annotations

import mimetypes
import os
import queue
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional, Literal
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .studio_workspace import WorkspaceStore
from .studio_works import collect_works
from .studio_lipsync import LipSyncService
from .studio_music import MusicService
from .studio_assistant import AssistantError
from .music_prompts import MusicBrief, compile_packet

if TYPE_CHECKING:
    from .studio_app import VoxCPMStudio


DEFAULT_NO_LORA_LABEL = "不使用 LoRA"


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def create_default_studio(model_dir: Optional[str]) -> "VoxCPMStudio":
    from .studio_app import VoxCPMStudio

    return VoxCPMStudio(model_dir=model_dir)


def _iso_now() -> str:
    return datetime.now().isoformat()


class StudioSettingsModel(BaseModel):
    model_dir: str = ""
    hf_repo_id: str = ""
    cache_dir: str = ""
    zipenhancer_path: str = ""
    output_dir: str = ""
    proxy_url: str = ""
    disable_denoiser: bool = False
    disable_optimize: bool = False


class AudioRecognizeRequest(BaseModel):
    audio_path: str = Field(alias="audioPath")


class SingleGenerateRequest(BaseModel):
    mode: str
    text: str
    control: str = ""
    reference_audio: str = Field(default="", alias="referenceAudio")
    prompt_text: str = Field(default="", alias="promptText")
    selected_lora: str = Field(default=DEFAULT_NO_LORA_LABEL, alias="selectedLora")
    cfg_value: float = Field(default=2.0, alias="cfgValue")
    normalize: bool = False
    denoise: bool = False
    inference_timesteps: int = Field(default=10, alias="inferenceTimesteps")


class BatchGenerateRequest(BaseModel):
    mode: str
    batch_text: str = Field(default="", alias="batchText")
    batch_file: str = Field(default="", alias="batchFile")
    control: str = ""
    reference_audio: str = Field(default="", alias="referenceAudio")
    prompt_text: str = Field(default="", alias="promptText")
    selected_lora: str = Field(default=DEFAULT_NO_LORA_LABEL, alias="selectedLora")
    cfg_value: float = Field(default=2.0, alias="cfgValue")
    normalize: bool = False
    denoise: bool = False
    inference_timesteps: int = Field(default=10, alias="inferenceTimesteps")
    output_prefix: str = Field(default="batch", alias="outputPrefix")


class SaveAsRequest(BaseModel):
    source_path: str = Field(alias="sourcePath")
    target_path: str = Field(alias="targetPath")


class LipSyncRequest(BaseModel):
    mode: Literal["video", "photo"] = "video"
    model_version: Literal["auto", "1.5", "1.6"] = Field(default="auto", alias="modelVersion")
    source_path: str = Field(alias="sourcePath", min_length=1)
    audio_path: str = Field(alias="audioPath", min_length=1)
    steps: int = Field(default=20, ge=20, le=50)
    guidance: float = Field(default=1.5, ge=1.0, le=3.0)
    seed: int = Field(default=1247, ge=0, le=2147483647)
    short_video: Literal["loop", "hold"] = Field(default="loop", alias="shortVideo")


class LipSyncPrepareRequest(BaseModel):
    model_version: Literal["auto", "1.5", "1.6"] = Field(default="auto", alias="modelVersion")


class MusicGenerateRequest(BaseModel):
    brief: MusicBrief
    draft: dict[str, Any] | None = None
    auto_optimize: bool = Field(default=True, alias='autoOptimize')
    prompt_id: str = Field(default='', alias='promptId', max_length=32)


class TrainingStartRequest(BaseModel):
    pretrained_path: str = Field(alias="pretrainedPath")
    train_manifest: str = Field(alias="trainManifest")
    val_manifest: str = Field(default="", alias="valManifest")
    learning_rate: float = Field(default=1e-4, alias="learningRate")
    num_iters: int = Field(default=3000, alias="numIters")
    batch_size: int = Field(default=1, alias="batchSize")
    lora_rank: int = Field(default=32, alias="loraRank")
    lora_alpha: int = Field(default=16, alias="loraAlpha")
    save_interval: int = Field(default=500, alias="saveInterval")
    output_name: str = Field(default_factory=now_stamp, alias="outputName")
    grad_accum_steps: int = Field(default=1, alias="gradAccumSteps")
    num_workers: int = Field(default=2, alias="numWorkers")
    log_interval: int = Field(default=10, alias="logInterval")
    valid_interval: int = Field(default=500, alias="validInterval")
    weight_decay: float = Field(default=0.0, alias="weightDecay")
    warmup_steps: int = Field(default=0, alias="warmupSteps")
    max_steps: int = Field(default=0, alias="maxSteps")
    sample_rate: int = Field(default=24000, alias="sampleRate")
    max_grad_norm: float = Field(default=1.0, alias="maxGradNorm")
    enable_lm: bool = Field(default=True, alias="enableLm")
    enable_dit: bool = Field(default=True, alias="enableDit")
    enable_proj: bool = Field(default=False, alias="enableProj")
    dropout: float = 0.0
    tensorboard_path: str = Field(default="", alias="tensorboardPath")
    hf_model_id: str = Field(default="", alias="hfModelId")
    distribute: bool = False


@dataclass
class TaskRecord:
    task_id: str
    kind: str
    title: str
    status: str = "queued"
    status_text: str = "任务已加入队列。"
    progress_text: str = ""
    error: str = ""
    created_at: str = field(default_factory=_iso_now)
    started_at: str = ""
    finished_at: str = ""
    result: dict[str, Any] | None = None
    completed: int = 0
    total: int = 0
    cancel_requested: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "kind": self.kind,
            "title": self.title,
            "status": self.status,
            "statusText": self.status_text,
            "progressText": self.progress_text,
            "error": self.error,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "result": self.result,
            "completed": self.completed,
            "total": self.total,
            "cancelRequested": self.cancel_requested,
        }


class StudioTaskQueue:
    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[str, Callable[[], dict[str, Any]]]] = queue.Queue()
        self._tasks: dict[str, TaskRecord] = {}
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def submit(self, kind: str, title: str, runner: Callable[..., dict[str, Any]], contextual: bool = False) -> dict[str, Any]:
        task_id = uuid.uuid4().hex
        record = TaskRecord(task_id=task_id, kind=kind, title=title)
        with self._lock:
            self._tasks[task_id] = record
        self._queue.put((task_id, (lambda: runner(task_id)) if contextual else runner))
        return record.to_payload()

    def progress(self, task_id: str, completed: int, total: int, text: str) -> None:
        with self._lock:
            record = self._tasks[task_id]
            record.completed, record.total = completed, total
            record.progress_text = text
            record.status_text = text

    def cancelled(self, task_id: str) -> bool:
        with self._lock:
            return self._tasks[task_id].cancel_requested

    def cancel(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._tasks.get(task_id)
            if record is None:
                raise KeyError(task_id)
            if record.kind not in {"generate-project", "generate-lipsync", "prepare-lipsync", "generate-music", "compose-music"}:
                raise ValueError("当前任务不支持安全取消。")
            if record.status in {"queued", "running"}:
                record.cancel_requested = True
                record.status_text = "正在暂停视频组件补齐。" if record.kind == "prepare-lipsync" else "正在停止视频推理进程。" if record.kind == "generate-lipsync" else "已请求取消，当前片段结束后停止。"
            return record.to_payload()

    def get(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._tasks.get(task_id)
            if record is None:
                raise KeyError(task_id)
            return record.to_payload()

    def _run(self) -> None:
        while True:
            task_id, runner = self._queue.get()
            with self._lock:
                record = self._tasks[task_id]
                if record.cancel_requested and record.kind not in {"prepare-lipsync", "generate-music"}:
                    record.status = "cancelled"
                    record.status_text = "任务已取消。"
                    record.finished_at = _iso_now()
                    continue
                record.status = "running"
                record.status_text = "任务执行中。"
                record.started_at = _iso_now()
            try:
                result = runner()
                with self._lock:
                    record.status = "cancelled" if result.get("cancelled") else "succeeded"
                    record.status_text = result.get("status") or result.get("message") or "任务执行完成。"
                    record.progress_text = result.get("log", "")
                    record.result = result
                    record.finished_at = _iso_now()
            except Exception as exc:
                traceback.print_exc()
                with self._lock:
                    record.status = "failed"
                    record.status_text = "任务执行失败。"
                    record.error = str(exc)
                    record.result = getattr(exc, 'partial_result', None)
                    record.finished_at = _iso_now()


def _media_url(path_value: str) -> str:
    return f"/media?path={quote(path_value)}"


def create_api_app(studio: Optional[Any] = None, model_dir: Optional[str] = None) -> FastAPI:
    studio_service = studio or create_default_studio(model_dir=model_dir)
    task_queue = StudioTaskQueue()
    explicit_root = os.environ.get("VOXCPM_DATA_ROOT", "").strip()
    runtime_root = studio_service.runtime_summary_payload().get("data_root", "")
    fallback_root = Path(studio_service.settings_payload()["output_dir"]).parent
    workspace = WorkspaceStore(Path(explicit_root or runtime_root or fallback_root) / "workspace", studio_service)
    lipsync = LipSyncService(Path(explicit_root or runtime_root or fallback_root), studio_service)
    music = MusicService(Path(explicit_root or runtime_root or fallback_root), studio_service)
    prompt_queue = StudioTaskQueue()
    app = FastAPI(title="JVOX Studio配音系统 Local API", version="0.1.0")
    app.state.studio = studio_service
    app.state.task_queue = task_queue
    app.state.workspace = workspace
    app.state.lipsync = lipsync
    app.state.music = music
    app.state.prompt_queue = prompt_queue

    def workspace_call(operation: Callable, *args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc).strip("'")) from exc
        except (ValueError, FileNotFoundError, TypeError, AssistantError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get('/api/assistant/settings')
    def assistant_settings():
        return workspace_call(music.assistants.public)

    @app.put('/api/assistant/settings')
    def save_assistant_settings(payload: dict):
        return workspace_call(music.assistants.save, payload)

    @app.post('/api/assistant/import')
    def import_assistants(payload: dict):
        return workspace_call(music.assistants.import_file, str(payload.get('path') or ''))

    @app.post('/api/assistant/test')
    def test_assistant(payload: dict):
        return workspace_call(music.assistants.test, str(payload.get('providerId') or ''))

    @app.post('/api/assistant/models')
    def assistant_models(payload: dict):
        return workspace_call(music.assistants.models, payload)

    @app.post('/api/assistant/reveal-key')
    def reveal_assistant_key(payload: dict):
        from fastapi.responses import JSONResponse
        return JSONResponse(workspace_call(music.assistants.reveal_key, str(payload.get('providerId') or '')),
                            headers={'Cache-Control': 'no-store'})

    @app.get('/api/music/status')
    def music_status():
        return workspace_call(music.status)

    @app.put('/api/music/settings')
    def music_settings(payload: dict):
        return workspace_call(music.configure, payload)

    @app.get('/api/music/results')
    def music_results():
        return {'items': music.results()}

    @app.post('/api/music/compose')
    def compose_music(payload: MusicBrief):
        return prompt_queue.submit('compose-music', 'AI音乐创作与提示词优化',
            lambda task_id: music.compose(payload, lambda n, text: prompt_queue.progress(task_id, n, 100, text),
                lambda: prompt_queue.cancelled(task_id)), contextual=True)

    @app.get('/api/music/prompt-tasks/{task_id}')
    def music_prompt_task(task_id: str):
        return workspace_call(prompt_queue.get, task_id)

    @app.post('/api/music/prompt-tasks/{task_id}/cancel')
    def cancel_music_prompt_task(task_id: str):
        return workspace_call(prompt_queue.cancel, task_id)

    @app.post('/api/music/compile')
    def compile_music(payload: MusicGenerateRequest):
        return workspace_call(compile_packet, payload.brief, payload.draft or {'caption': payload.brief.caption, 'lyrics': payload.brief.lyrics})

    @app.post('/api/music/generate')
    def generate_music(payload: MusicGenerateRequest):
        with lipsync.lock:
            if lipsync.active or lipsync.preparing or studio_service.training_status_payload().get('running'):
                raise HTTPException(status_code=409, detail='请先完成视频任务或停止训练，再生成音乐')
            workspace_call(music.reserve, payload.brief.model_id)
        try:
            return task_queue.submit('generate-music', '音乐生成', lambda task_id: music.generate(payload,
                lambda n, text: task_queue.progress(task_id, n, 100, text), lambda: task_queue.cancelled(task_id)), contextual=True)
        except Exception:
            with music.lock:
                music.active = False
            raise

    @app.get("/api/lipsync/status")
    def lipsync_status(modelVersion: Literal["auto", "1.5", "1.6"] = "auto"):
        return lipsync.status(model_version=modelVersion)

    @app.put("/api/lipsync/settings")
    def lipsync_settings(payload: dict):
        return workspace_call(lipsync.configure, str(payload.get("root", "")))

    @app.get("/api/lipsync/results")
    def lipsync_results():
        return {"items": lipsync.results()}

    @app.post("/api/lipsync/prepare")
    def prepare_lipsync(payload: LipSyncPrepareRequest):
        with lipsync.lock:
            if lipsync.preparation_task_id:
                previous = task_queue.get(lipsync.preparation_task_id)
                if previous["status"] in {"queued", "running"}:
                    return previous
            if lipsync.active:
                raise HTTPException(status_code=409, detail="视频生成中，请等待完成后补齐。")
            status = lipsync.status(model_version=payload.model_version)
            if not status["preferredVersion"]:
                raise HTTPException(status_code=400, detail=status["preparationReason"])
            lipsync.preparing = True
            task = task_queue.submit("prepare-lipsync", "视频组件自动补齐", lambda task_id: lipsync.prepare(payload.model_version,
                lambda percent, text: task_queue.progress(task_id, percent, 100, text), lambda: task_queue.cancelled(task_id)), contextual=True)
            lipsync.preparation_task_id = task["taskId"]
            return task

    @app.post("/api/lipsync/generate")
    def generate_lipsync(payload: LipSyncRequest):
        status = lipsync.status(model_version=payload.model_version)
        if not status["ready"] or status.get("needsPreparation", False):
            raise HTTPException(status_code=400, detail="视频模型尚未就绪：" + "、".join(status["missing"]))
        if getattr(studio_service, "_training_is_running", lambda: False)():
            raise HTTPException(status_code=409, detail="请先停止 LoRA 训练，再生成视频。")
        workspace_call(lipsync.validate, payload)
        return task_queue.submit("generate-lipsync", "视频对口型" if payload.mode == "video" else "照片说话",
            lambda task_id: lipsync.generate(payload,
                lambda percent, text: task_queue.progress(task_id, percent, 100, text),
                lambda: task_queue.cancelled(task_id)), contextual=True)

    @app.get("/api/workspace/projects")
    def list_projects():
        return workspace.list_projects()

    @app.post("/api/workspace/projects")
    def create_project(payload: dict = {}):
        return workspace_call(workspace.create_project, payload.get("name", ""))

    @app.get("/api/workspace/projects/{project_id}")
    def get_project(project_id: str):
        return workspace_call(workspace.get_project, project_id)

    @app.put("/api/workspace/projects/{project_id}")
    def put_project(project_id: str, payload: dict):
        return workspace_call(workspace.put_project, project_id, payload)

    @app.delete("/api/workspace/projects/{project_id}")
    def delete_project(project_id: str):
        return workspace_call(workspace.delete_project, project_id)

    @app.post("/api/workspace/projects/{project_id}/parse")
    def parse_project(project_id: str, payload: dict):
        return workspace_call(workspace.parse, project_id, str(payload.get("text", "")), payload.get("maxChars", 120), payload.get("format", "auto"))

    @app.post("/api/workspace/projects/{project_id}/generate")
    def generate_project(project_id: str, payload: dict = {}):
        workspace_call(workspace.get_project, project_id)
        return task_queue.submit("generate-project", "项目配音生成", lambda task_id: workspace.generate(
            project_id, payload.get("segmentIds"), bool(payload.get("force", False)),
            lambda completed, total, text: task_queue.progress(task_id, completed, total, text),
            lambda: task_queue.cancelled(task_id)), contextual=True)

    @app.post("/api/workspace/projects/{project_id}/export")
    def export_project(project_id: str):
        return workspace_call(workspace.export, project_id)

    @app.get("/api/workspace/voices")
    def list_voices():
        return workspace.voices()

    @app.post("/api/workspace/voices")
    def add_voice(payload: dict):
        return workspace_call(workspace.add_voice, payload)

    @app.put("/api/workspace/voices/{voice_id}")
    def update_voice(voice_id: str, payload: dict):
        return workspace_call(workspace.update_voice, voice_id, payload)

    @app.delete("/api/workspace/voices/{voice_id}")
    def delete_voice(voice_id: str):
        return workspace.delete_voice(voice_id)

    @app.get("/api/workspace/history")
    def workspace_history():
        return workspace.history()

    @app.get("/api/workspace/works")
    def workspace_works():
        return collect_works(workspace, music, lipsync, studio_service.settings_payload()["output_dir"])

    @app.post("/api/tasks/{task_id}/cancel")
    def cancel_task(task_id: str):
        return workspace_call(task_queue.cancel, task_id)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True}

    @app.get("/api/runtime/summary")
    def runtime_summary() -> dict[str, Any]:
        return studio_service.runtime_summary_payload()

    @app.get("/api/settings")
    def get_settings() -> dict[str, Any]:
        return {
            "settings": studio_service.settings_payload(),
            "runtime": studio_service.runtime_summary_payload(),
        }

    @app.put("/api/settings")
    def put_settings(payload: StudioSettingsModel) -> dict[str, Any]:
        old_output = Path(studio_service.settings_payload()["output_dir"])
        workspace.index_batches((old_output / "batch").glob("*/manifest.json"))
        message, _runtime_markdown = studio_service.persist_settings(
            model_dir=payload.model_dir,
            hf_repo_id=payload.hf_repo_id,
            cache_dir=payload.cache_dir,
            zipenhancer_path=payload.zipenhancer_path,
            output_dir=payload.output_dir,
            proxy_url=payload.proxy_url,
            disable_denoiser=payload.disable_denoiser,
            disable_optimize=payload.disable_optimize,
        )
        return {
            "message": message,
            "settings": studio_service.settings_payload(),
            "runtime": studio_service.runtime_summary_payload(),
        }

    @app.get("/api/lora")
    def get_lora_entries() -> dict[str, Any]:
        return {
            "items": studio_service.lora_entries_payload(),
            "defaultValue": DEFAULT_NO_LORA_LABEL,
        }

    @app.post("/api/asr/recognize")
    def recognize_audio(payload: AudioRecognizeRequest) -> dict[str, Any]:
        with lipsync.lock:
            if lipsync.active or lipsync.preparing:
                raise HTTPException(status_code=409, detail="视频正在使用显卡，请等待完成后再识别参考音频。")
            text = workspace_call(studio_service.recognize_audio, payload.audio_path)
            return {"text": text}

    @app.post("/api/tasks/warmup")
    def warmup_task() -> dict[str, Any]:
        return task_queue.submit(
            kind="warmup",
            title="模型预热",
            runner=studio_service.warmup_model_payload,
        )

    @app.post("/api/tasks/generate-single")
    def single_generate_task(payload: SingleGenerateRequest) -> dict[str, Any]:
        def runner() -> dict[str, Any]:
            result = studio_service.generate_audio_payload(
                mode=payload.mode,
                text=payload.text,
                control=payload.control,
                reference_audio=payload.reference_audio or None,
                prompt_text=payload.prompt_text,
                selected_lora=payload.selected_lora,
                cfg_value=payload.cfg_value,
                normalize=payload.normalize,
                denoise=payload.denoise,
                inference_timesteps=payload.inference_timesteps,
            )
            audio_tuple = result.pop("audio_tuple", None)
            if audio_tuple is not None:
                result["sample_rate"] = audio_tuple[0]
            result["previewUrl"] = _media_url(result["output_path"])
            workspace.record_single(result, {
                "mode": payload.mode, "control": payload.control, "referenceAudio": payload.reference_audio,
                "promptText": payload.prompt_text, "selectedLora": payload.selected_lora,
                "cfgValue": payload.cfg_value, "normalize": payload.normalize, "denoise": payload.denoise,
                "inferenceTimesteps": payload.inference_timesteps,
            }, payload.text)
            return result

        return task_queue.submit(
            kind="generate-single",
            title="单条语音生成",
            runner=runner,
        )

    @app.post("/api/tasks/generate-batch")
    def batch_generate_task(payload: BatchGenerateRequest) -> dict[str, Any]:
        def runner() -> dict[str, Any]:
            result = studio_service.batch_generate_payload(
                mode=payload.mode,
                batch_text=payload.batch_text,
                batch_file=payload.batch_file or None,
                control=payload.control,
                reference_audio=payload.reference_audio or None,
                prompt_text=payload.prompt_text,
                selected_lora=payload.selected_lora,
                cfg_value=payload.cfg_value,
                normalize=payload.normalize,
                denoise=payload.denoise,
                inference_timesteps=payload.inference_timesteps,
                output_prefix=payload.output_prefix,
            )
            result["archivePath"] = result["archive_path"]
            result["outputDir"] = result["output_dir"]
            workspace.record_batch(result)
            return result

        return task_queue.submit(
            kind="generate-batch",
            title="批量语音生成",
            runner=runner,
        )

    @app.get("/api/tasks/{task_id}")
    def get_task(task_id: str) -> dict[str, Any]:
        try:
            return task_queue.get(task_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="任务不存在。") from exc

    @app.post("/api/files/save-as")
    def save_as(payload: SaveAsRequest) -> dict[str, Any]:
        return studio_service.save_generated_file_to(payload.source_path, payload.target_path)

    @app.post("/api/training/start")
    def start_training(payload: TrainingStartRequest) -> dict[str, Any]:
        with lipsync.lock:
            if lipsync.active or lipsync.preparing or music.active:
                raise HTTPException(status_code=409, detail="视频正在使用显卡，请等待完成或取消视频任务后再训练。")
            return start_training_impl(payload)

    def start_training_impl(payload: TrainingStartRequest) -> dict[str, Any]:
        message, log_text = studio_service.start_training(
            pretrained_path=payload.pretrained_path,
            train_manifest=payload.train_manifest,
            val_manifest=payload.val_manifest,
            learning_rate=payload.learning_rate,
            num_iters=payload.num_iters,
            batch_size=payload.batch_size,
            lora_rank=payload.lora_rank,
            lora_alpha=payload.lora_alpha,
            save_interval=payload.save_interval,
            output_name=payload.output_name,
            grad_accum_steps=payload.grad_accum_steps,
            num_workers=payload.num_workers,
            log_interval=payload.log_interval,
            valid_interval=payload.valid_interval,
            weight_decay=payload.weight_decay,
            warmup_steps=payload.warmup_steps,
            max_steps=payload.max_steps,
            sample_rate=payload.sample_rate,
            max_grad_norm=payload.max_grad_norm,
            enable_lm=payload.enable_lm,
            enable_dit=payload.enable_dit,
            enable_proj=payload.enable_proj,
            dropout=payload.dropout,
            tensorboard_path=payload.tensorboard_path,
            hf_model_id=payload.hf_model_id,
            distribute=payload.distribute,
        )
        status = studio_service.training_status_payload()
        if not status["running"] and "已启动" not in message:
            raise HTTPException(status_code=400, detail=message)
        return {"message": message, "log": log_text, "status": status}

    @app.post("/api/training/stop")
    def stop_training() -> dict[str, Any]:
        message, log_text = studio_service.stop_training()
        return {"message": message, "log": log_text, "status": studio_service.training_status_payload()}

    @app.get("/api/training/status")
    def get_training_status() -> dict[str, Any]:
        return studio_service.training_status_payload()

    @app.get("/api/training/log")
    def get_training_log(offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
        return studio_service.training_log_payload(offset)

    @app.get("/media")
    def media(path: str) -> FileResponse:
        target = Path(path).expanduser()
        if not target.is_file():
            raise HTTPException(status_code=404, detail="媒体文件不存在。")
        media_type, _ = mimetypes.guess_type(target.name)
        return FileResponse(target, media_type=media_type or "application/octet-stream")

    return app
