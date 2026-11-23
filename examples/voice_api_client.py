"""独立开发者客户端，仅用 Python 标准库；密钥读取 JVOX_API_KEY，不写日志。"""
import argparse
import json
import os
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class VoiceClient:
    def __init__(self, base_url, api_key, timeout=660):
        self.base = base_url.rstrip("/")
        if not self.base.endswith("/v1"):
            self.base += "/v1"
        self.api_key, self.timeout = api_key, timeout

    def request(self, path, data=None, content_type="application/json", request_key=""):
        headers = {"Authorization": "Bearer " + self.api_key}
        if data is not None:
            headers["Content-Type"] = content_type
        if request_key:
            headers["Idempotency-Key"] = request_key
        try:
            with urlopen(Request(self.base + path, data=data, headers=headers), timeout=self.timeout) as response:
                body = response.read()
                return json.loads(body) if "application/json" in response.headers.get("Content-Type", "") else body
        except HTTPError as error:
            raise RuntimeError(f"HTTP {error.code}: {error.read().decode('utf-8', errors='replace')}") from error

    def upload(self, file):
        return self.request("/audio/references", Path(file).read_bytes(), "audio/wav")

    def generate(self, payload, output, request_key, sync=False):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if sync:
            audio = self.request("/audio/speech", raw, request_key=request_key)
            job = {"mode": payload.get("mode", "design"), "request_key": request_key, "sync": True}
        else:
            submitted = self.request("/audio/generations", raw, request_key=request_key)
            deadline = time.monotonic() + self.timeout
            while True:
                job = self.request("/audio/generations/" + submitted["id"])
                if job["status"] == "completed":
                    audio = self.request("/audio/generations/" + submitted["id"] + "/content")
                    break
                if job["status"] in {"failed", "interrupted", "cancelled"}:
                    raise RuntimeError(json.dumps(job, ensure_ascii=False))
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"等待超时：任务 {submitted['id']}；保留请求标识 {request_key} 后重试")
                time.sleep(1)
            job["request_key"] = request_key
        if not isinstance(audio, bytes) or audio[:4] != b"RIFF":
            raise RuntimeError("服务未返回 WAV")
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(audio)
        return {**job, "output": str(output.resolve()), "bytes": len(audio)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.getenv("JVOX_BASE_URL", "http://127.0.0.1:8848/v1"))
    parser.add_argument("--timeout", type=float, default=660)
    commands = parser.add_subparsers(dest="command", required=True)
    upload = commands.add_parser("upload", help="上传一次参考音；保存返回的 id 用于重试")
    upload.add_argument("file", type=Path)
    generate = commands.add_parser("generate", help="生成并保存 WAV，默认使用异步接口")
    generate.add_argument("--input", required=True)
    generate.add_argument("--instructions", default="")
    generate.add_argument("--mode", choices=["design", "clone", "clone_prompt"], default="design")
    generate.add_argument("--reference-id", default="")
    generate.add_argument("--prompt-text", default="")
    generate.add_argument("--request-key", default="")
    generate.add_argument("--sync", action="store_true")
    generate.add_argument("--output", type=Path, default=Path("speech.wav"))
    args = parser.parse_args()
    key = os.getenv("JVOX_API_KEY", "")
    if not key:
        parser.error("请先设置 JVOX_API_KEY 环境变量")
    client = VoiceClient(args.base_url, key, args.timeout)
    if args.command == "upload":
        result = client.upload(args.file)
    else:
        if args.mode != "design" and not args.reference_id:
            parser.error("克隆模式需要 --reference-id（先执行 upload）")
        if args.mode == "clone_prompt" and not args.prompt_text.strip():
            parser.error("极致克隆需要 --prompt-text，逐字对应参考音")
        if args.mode == "clone_prompt" and args.instructions:
            parser.error("极致克隆不应用 --instructions，请移除此参数")
        request_key = args.request_key or uuid.uuid4().hex
        print("请求标识：" + request_key, flush=True)
        result = client.generate({"input": args.input, "instructions": args.instructions, "mode": args.mode,
                                  "reference_id": args.reference_id, "prompt_text": args.prompt_text}, args.output, request_key, args.sync)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
