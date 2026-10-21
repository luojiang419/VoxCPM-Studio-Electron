"""开发者语音 API：独立监听、按 Key 隔离、复用桌面推理队列与模型。"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import socket
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager, closing
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field


def protect(value: str, decrypt=False) -> str:
    if os.name != "nt":
        return value if decrypt else "plain:" + value
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]
    raw = base64.b64decode(value) if decrypt else value.encode()
    buffer = ctypes.create_string_buffer(raw)
    source, target = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), Blob()
    function = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise OSError("无法使用当前 Windows 账号保护密钥")
    try:
        result = ctypes.string_at(target.data, target.size)
        return result.decode() if decrypt else base64.b64encode(result).decode()
    finally:
        ctypes.windll.kernel32.LocalFree(target.data)


class Speech(BaseModel):
    model: str = "voxcpm-2"
    input: str = Field(min_length=1, max_length=3000)
    instructions: str = Field(default="", max_length=1200)
    voice: str = "design"
    reference_id: str = ""
    prompt_text: str = Field(default="", max_length=3000)
    mode: str = "design"
    response_format: str = "wav"
    cfg_value: float = Field(default=2, ge=1, le=5)
    inference_timesteps: int = Field(default=10, ge=4, le=50)


class AccessConfig(BaseModel):
    enabled: bool = False
    host: str = "127.0.0.1"
    port: int = Field(default=8848, ge=1024, le=65535)


class KeyName(BaseModel):
    name: str = Field(min_length=1, max_length=32)


def management(request: Request, response: Response):
    """桌面管理仅允许直连本机，并阻止网页跨站写入和 DNS rebinding。"""
    host = request.client.host if request.client else ""
    if host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "API 管理仅允许本机访问")
    if request.url.hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}:
        raise HTTPException(403, "管理地址必须为 localhost")
    origin = request.headers.get("origin")
    desktop = origin == "null" and bool(os.environ.get("VOXCPM_API_MANAGEMENT_TOKEN")) and secrets.compare_digest(request.headers.get("x-jvox-management", ""), os.environ["VOXCPM_API_MANAGEMENT_TOKEN"])
    if origin and not desktop and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "不允许跨站管理 API")
    if request.headers.get("sec-fetch-site") == "cross-site" and not desktop:
        raise HTTPException(403, "不允许跨站管理 API")
    response.headers["Cache-Control"] = "no-store"


class PublicVoiceAPI:
    def __init__(self, root, studio, queue, workspace):
        self.root, self.studio, self.queue, self.workspace = Path(root), studio, queue, workspace
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "developer-api.sqlite3"
        self.server = self.thread = None
        self.lock = threading.RLock()
        self.listener_error = ""
        with closing(self.db()) as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE,
              digest TEXT UNIQUE, prefix TEXT, secret TEXT, disabled INTEGER DEFAULT 0,
              created_at TEXT, last_used_at TEXT, calls INTEGER DEFAULT 0, calls_day TEXT, calls_today INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT, path TEXT, status TEXT, created_at TEXT);
            CREATE TABLE IF NOT EXISTS audio_references(id TEXT PRIMARY KEY, owner TEXT, path TEXT);
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            for name in ("request_key", "request_hash"):
                if name not in columns:
                    db.execute(f"ALTER TABLE jobs ADD COLUMN {name} TEXT")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS job_idempotency ON jobs(owner,request_key) WHERE request_key IS NOT NULL")
            db.execute("UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running')")
            db.commit()
        self.app = self.build_app()

    def db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        return db

    def config(self):
        with closing(self.db()) as db:
            row = db.execute("SELECT value FROM config WHERE id=1").fetchone()
        return json.loads(row[0]) if row else AccessConfig().model_dump()

    def status(self):
        cfg = self.config()
        return {**cfg, "listening": bool(self.server and self.server.started), "error": self.listener_error,
                "base_url": f"http://127.0.0.1:{cfg['port']}/v1", "authentication": "Bearer API Key"}

    def configure(self, cfg: AccessConfig):
        if cfg.host not in {"127.0.0.1", "0.0.0.0"}:
            raise HTTPException(422, "监听地址仅支持 127.0.0.1 或 0.0.0.0")
        if cfg.enabled:
            with closing(self.db()) as db:
                if not db.execute("SELECT 1 FROM keys WHERE disabled=0").fetchone():
                    raise HTTPException(409, "请先创建一个启用中的 API Key")
        with self.lock:
            old = self.config()
            self.stop()
            try:
                if cfg.enabled:
                    self.start(cfg.model_dump())
            except Exception as exc:
                if old["enabled"]:
                    try:
                        self.start(old)
                    except Exception:
                        pass
                raise HTTPException(409, f"API 启动失败：{exc}") from exc
            with closing(self.db()) as db:
                db.execute("INSERT OR REPLACE INTO config VALUES(1,?)", (json.dumps(cfg.model_dump()),))
                db.commit()
        return self.status()

    def start(self, cfg=None):
        cfg = cfg or self.config()
        if not cfg["enabled"] or self.server:
            return
        import uvicorn
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind((cfg["host"], cfg["port"]))
            self.server = uvicorn.Server(uvicorn.Config(self.app, log_level="warning", access_log=False))
            self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [sock]}, daemon=True)
            self.thread.start()
            for _ in range(100):
                if self.server.started:
                    self.listener_error = ""
                    return
                if not self.thread.is_alive():
                    break
                time.sleep(.03)
            raise RuntimeError("监听服务未就绪")
        except Exception as exc:
            self.listener_error = str(exc)
            sock.close()
            self.stop()
            raise

    def stop(self):
        if self.server:
            self.server.should_exit = True
            self.thread.join(timeout=3)
            if self.thread.is_alive():
                raise HTTPException(409, "API 仍在处理请求，请完成后重试")
        self.server = self.thread = None

    def keys(self):
        today = datetime.now().strftime("%Y-%m-%d")
        with closing(self.db()) as db:
            return [dict(row) for row in db.execute("""SELECT id,name,prefix,disabled,created_at,last_used_at,calls,
                CASE WHEN calls_day=? THEN calls_today ELSE 0 END calls_today FROM keys ORDER BY created_at DESC""", (today,))]

    def create_key(self, name):
        name = name.strip()
        if not name or any(ord(c) < 32 for c in name):
            raise HTTPException(422, "名称不能为空或包含控制字符")
        key_id, token = uuid.uuid4().hex, "sk-jvox-" + secrets.token_urlsafe(32)
        with closing(self.db()) as db:
            try:
                db.execute("INSERT INTO keys(id,name,digest,prefix,secret,created_at) VALUES(?,?,?,?,?,?)",
                           (key_id, name, hashlib.sha256(token.encode()).hexdigest(), token[:15], protect(token), datetime.now().isoformat()))
                db.commit()
            except sqlite3.IntegrityError as exc:
                raise HTTPException(409, "名称已存在") from exc
        return {"id": key_id, "api_key": token}

    def change_key(self, key_id, action):
        with closing(self.db()) as db:
            row = db.execute("SELECT * FROM keys WHERE id=?", (key_id,)).fetchone()
            if not row:
                raise HTTPException(404, "密钥不存在")
            if action == "secret":
                value = row["secret"]
                return {"api_key": value.removeprefix("plain:") if value.startswith("plain:") else protect(value, True)}
            if action == "rotate":
                if row["disabled"]:
                    raise HTTPException(409, "请为已停用的密钥创建新密钥")
                token = "sk-jvox-" + secrets.token_urlsafe(32)
                db.execute("UPDATE keys SET digest=?,prefix=?,secret=? WHERE id=?",
                           (hashlib.sha256(token.encode()).hexdigest(), token[:15], protect(token), key_id))
                result = {"api_key": token}
            elif action == "disable":
                db.execute("UPDATE keys SET disabled=1 WHERE id=?", (key_id,))
                result = {"disabled": True}
            else:
                db.execute("DELETE FROM keys WHERE id=?", (key_id,))
                result = {"deleted": True}
            db.commit()
        return result

    def principal(self, credential: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False))):
        token = credential.credentials if credential else ""
        with closing(self.db()) as db:
            row = db.execute("SELECT id FROM keys WHERE digest=? AND disabled=0", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if not row:
            raise HTTPException(401, "请提供有效的 Bearer API Key", headers={"WWW-Authenticate": "Bearer"})
        return row["id"]

    def submit(self, payload, owner, request_key=""):
        if len(request_key) > 128:
            raise HTTPException(422, "Idempotency-Key 最长 128 字符")
        request_hash = hashlib.sha256(payload.model_dump_json().encode()).hexdigest()
        if payload.model not in {"voxcpm-2", "VoxCPM2"} or payload.response_format != "wav":
            raise HTTPException(422, "支持 model=voxcpm-2 和 response_format=wav")
        if payload.mode not in {"design", "clone", "clone_prompt"} or not payload.input.strip():
            raise HTTPException(422, "请输入台词并选择 design / clone / clone_prompt")
        reference = None
        if payload.mode != "design":
            with closing(self.db()) as db:
                row = db.execute("SELECT path FROM audio_references WHERE id=? AND owner=?", (payload.reference_id, owner)).fetchone()
            if not row:
                raise HTTPException(404, "请先上传属于当前 Key 的参考 WAV")
            if payload.mode == "clone_prompt" and not payload.prompt_text.strip():
                raise HTTPException(422, "clone_prompt 必须提供参考音频逐字文案 prompt_text")
            reference = row[0]
        with self.lock:
            with closing(self.db()) as db:
                existing = db.execute("SELECT id,status,request_hash FROM jobs WHERE owner=? AND request_key=?", (owner, request_key)).fetchone() if request_key else None
                if existing:
                    if existing["request_hash"] != request_hash:
                        raise HTTPException(409, "同一 Idempotency-Key 不能提交不同的生成参数")
                    return {"id": existing["id"], "status": existing["status"], "status_url": f"/v1/audio/generations/{existing['id']}"}
                if db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0] >= 16:
                    raise HTTPException(429, "生成队列已满，请稍后重试")
                public_id = uuid.uuid4().hex
                db.execute("INSERT INTO jobs(id,owner,path,status,created_at,request_key,request_hash) VALUES(?,?,NULL,'queued',?,?,?)", (public_id, owner, datetime.now().isoformat(), request_key or None, request_hash))
                db.commit()
            def runner():
                try:
                    result = self.studio.generate_audio_payload(
                        mode={"design": "声音设计", "clone": "可控克隆", "clone_prompt": "极致克隆"}[payload.mode],
                        text=payload.input.strip(), control=payload.instructions, reference_audio=reference,
                        prompt_text=payload.prompt_text, selected_lora="不使用 LoRA", cfg_value=payload.cfg_value,
                        normalize=False, denoise=False, inference_timesteps=payload.inference_timesteps)
                    result.pop("audio_tuple", None)
                    self.workspace.record_single(result, {"mode": result.get("mode"), "control": payload.instructions}, payload.input)
                    with closing(self.db()) as db:
                        db.execute("UPDATE jobs SET path=?,status='completed' WHERE id=?", (result["output_path"], public_id))
                        db.commit()
                    return {"id": public_id, "audio_url": f"/v1/audio/generations/{public_id}/content", "sample_rate": result.get("sample_rate")}
                except Exception:
                    with closing(self.db()) as db:
                        db.execute("UPDATE jobs SET status='failed' WHERE id=?", (public_id,))
                        db.commit()
                    raise
            task = self.queue.submit("public-speech", "开发者语音生成", runner)
            self.tasks[public_id] = task["taskId"]
            today = datetime.now().strftime("%Y-%m-%d")
            with closing(self.db()) as db:
                db.execute("UPDATE keys SET last_used_at=?,calls=calls+1,calls_today=CASE WHEN calls_day=? THEN calls_today+1 ELSE 1 END,calls_day=? WHERE id=?",
                           (datetime.now().isoformat(), today, today, owner))
                db.commit()
        return {"id": public_id, "status": "queued", "status_url": f"/v1/audio/generations/{public_id}"}

    def owned(self, job_id, owner):
        with closing(self.db()) as db:
            row = db.execute("SELECT * FROM jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
        if not row:
            raise HTTPException(404, "任务不存在")
        return row

    def job(self, job_id, owner):
        row = self.owned(job_id, owner)
        task_id = self.tasks.get(job_id)
        task = self.queue.get(task_id) if task_id else {}
        status = task.get("status", row["status"])
        if status == "succeeded":
            status = "completed"
        return {"id": job_id, "status": status, "error": "语音生成失败，请在桌面运行日志中查看原因" if status == "failed" else "",
                "audio_url": f"/v1/audio/generations/{job_id}/content" if status == "completed" else None}

    def content(self, job_id, owner):
        row = self.owned(job_id, owner)
        if row["status"] != "completed":
            raise HTTPException(409, "音频尚未生成完成")
        if not row["path"] or not Path(row["path"]).is_file():
            raise HTTPException(410, "结果文件已移走或删除")
        return FileResponse(row["path"], media_type="audio/wav", filename="speech.wav", headers={"Cache-Control": "no-store"})

    def build_app(self):
        self.tasks = {}
        app = FastAPI(title="JVOX 开发者语音 API", version="1.0.0")
        app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"],
                           allow_headers=["Authorization", "Content-Type", "Idempotency-Key"], allow_credentials=False)
        owner = Depends(self.principal)

        @app.get("/health")
        def health():
            return {"ok": True, "service": "jvox-voice-api"}

        @app.get("/v1/models")
        def models(key=owner):
            return {"object": "list", "data": [{"id": "voxcpm-2", "object": "model", "owned_by": "local", "type": "tts"}]}

        @app.post("/v1/audio/generations", status_code=202)
        def generate(payload: Speech, request: Request, key=owner):
            return self.submit(payload, key, request.headers.get("idempotency-key", ""))

        @app.get("/v1/audio/generations/{job_id}")
        def job(job_id: str, key=owner):
            return self.job(job_id, key)

        @app.get("/v1/audio/generations/{job_id}/content")
        def content(job_id: str, key=owner):
            return self.content(job_id, key)

        @app.post("/v1/audio/speech")
        def speech(payload: Speech, request: Request, key=owner):
            job = self.submit(payload, key, request.headers.get("idempotency-key", ""))
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                status = self.job(job["id"], key)["status"]
                if status == "completed":
                    return self.content(job["id"], key)
                if status in {"failed", "cancelled", "interrupted"}:
                    raise HTTPException(502, "语音生成失败，请检查桌面日志")
                time.sleep(.15)
            raise HTTPException(504, f"等待超时，可查询任务 {job['id']}")

        @app.post("/v1/audio/references", status_code=201)
        async def reference(request: Request, key=owner):
            import io
            import soundfile as sf
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > 20 * 1024 * 1024:
                    raise HTTPException(413, "参考 WAV 不得超过 20MB")
            try:
                info = sf.info(io.BytesIO(data))
                if info.format != "WAV" or not 1 <= info.duration <= 30 or info.channels not in {1, 2}:
                    raise ValueError()
            except Exception as exc:
                raise HTTPException(422, "请上传 1～30 秒的有效 WAV 音频二进制") from exc
            ref_id = uuid.uuid4().hex
            path = self.root / "references" / f"{ref_id}.wav"
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
            with closing(self.db()) as db:
                db.execute("INSERT INTO audio_references VALUES(?,?,?)", (ref_id, key, str(path)))
                db.commit()
            return {"id": ref_id, "duration": info.duration}

        return app


def install_public_api(app, root, studio, queue, workspace):
    service = PublicVoiceAPI(Path(root) / "developer-api", studio, queue, workspace)
    app.state.public_api = service
    dependency = [Depends(management)]

    @app.get("/api/access", dependencies=dependency)
    def access():
        return service.status()

    @app.put("/api/access", dependencies=dependency)
    def configure(payload: AccessConfig):
        return service.configure(payload)

    @app.get("/api/access/keys", dependencies=dependency)
    def keys():
        return {"keys": service.keys()}

    @app.post("/api/access/keys", dependencies=dependency, status_code=201)
    def create(payload: KeyName):
        return service.create_key(payload.name)

    @app.get("/api/access/keys/{key_id}/secret", dependencies=dependency)
    def reveal(key_id: str):
        return service.change_key(key_id, "secret")

    @app.post("/api/access/keys/{key_id}/{action}", dependencies=dependency)
    def change(key_id: str, action: str):
        if action not in {"rotate", "disable"}:
            raise HTTPException(404)
        return service.change_key(key_id, action)

    @app.delete("/api/access/keys/{key_id}", dependencies=dependency)
    def delete(key_id: str):
        return service.change_key(key_id, "delete")

    previous_lifespan = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        async with previous_lifespan(application):
            try:
                service.start()
            except Exception as exc:
                service.listener_error = str(exc)
            try:
                yield
            finally:
                service.stop()
    app.router.lifespan_context = lifespan
    return service
