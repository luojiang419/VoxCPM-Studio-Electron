"""LatentSync 独立进程入口；仅在专用环境内导入视频模型依赖。"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lipsync_profiles import PROFILES, load_manifest

EVENT_PREFIX = "__VOXCPM_LIPSYNC__"


def emit(**payload):
    print(EVENT_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def run(args):
    root = Path(args.root).resolve()
    work = Path(args.work).resolve()
    source = root / "source"
    version = args.model_version
    profile = PROFILES[version]
    resolution = profile["resolution"]
    if not load_manifest(root, version):
        raise RuntimeError(f"请选择已安装的 LatentSync {version} 低显存环境。")
    sys.path.insert(0, str(source))
    os.chdir(work)
    # 不继承主程序的模型搜索路径，所有权重明确指向本地文件。
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import locale
    if os.name == "nt":
        locale.setlocale(locale.LC_CTYPE, ".UTF8")
    import cv2
    import numpy as np
    import torch
    import torchvision.transforms.functional as transforms
    import soundfile as sf
    from omegaconf import OmegaConf
    from diffusers import AutoencoderKL, DDIMScheduler
    from accelerate.utils import set_seed
    from insightface.app import FaceAnalysis
    from latentsync.models.unet import UNet3DConditionModel
    from latentsync.whisper.audio2feature import Audio2Feature
    from latentsync.utils.face_detector import FaceDetector
    import latentsync.pipelines.lipsync_pipeline as pipeline_module
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("视频对口型需要可用的 NVIDIA CUDA 显卡。")
    torch.cuda.set_device(0)
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    torch.cuda.reset_peak_memory_stats()
    started = time.monotonic()
    emit(stage="loading", progress=3, text=f"加载 LatentSync {version} · {resolution}px 低显存")

    def init_detector(self, device="cuda"):
        # 检测和106点定位放在CPU，给扩散模型保留显存；不改变官方人脸对齐算法。
        self.app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "landmark_2d_106"],
                                root=str(source / "checkpoints/auxiliary"), providers=["CPUExecutionProvider"])
        self.app.prepare(ctx_id=-1, det_size=(512, 512))

    FaceDetector.__init__ = init_detector
    # 输入已由父进程转换为25fps / 16kHz；避开上游shell命令和全局temp目录。
    pipeline_module.read_video = lambda path, **kwargs: __import__(
        "latentsync.utils.util", fromlist=["read_video_cv2"]).read_video_cv2(path)
    pipeline_module.read_audio = lambda path, **kwargs: torch.from_numpy(sf.read(path, dtype="float32")[0])

    def read_mask(resolution, mask_image_path):
        image = cv2.imdecode(np.fromfile(mask_image_path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("无法读取人脸遮罩文件。")
        image = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2RGB), (resolution, resolution), interpolation=cv2.INTER_LANCZOS4) / 255.0
        return torch.from_numpy(image).permute(2, 0, 1)

    pipeline_module.load_fixed_mask = read_mask

    class LowMemoryPipeline(LipsyncPipeline):
        @staticmethod
        def paste_surrounding_pixels_back(decoded_latents, pixel_values, masks, device, weight_dtype):
            result = LipsyncPipeline.paste_surrounding_pixels_back(
                decoded_latents, pixel_values, masks, device, weight_dtype)
            return result.cpu()

        def restore_video(self, faces, video_frames, boxes, affine_matrices):
            emit(stage="restoring", progress=94, text="还原原视频画面")
            frames = []
            for index in range(len(faces)):
                x1, y1, x2, y2 = boxes[index]
                face = transforms.resize(faces[index].to("cuda"), (int(y2 - y1), int(x2 - x1)),
                                         interpolation=transforms.InterpolationMode.BICUBIC, antialias=True)
                frames.append(self.image_processor.restorer.restore_img(video_frames[index], face, affine_matrices[index]))
            return np.stack(frames)

    config = OmegaConf.load(source / profile["config"])
    scheduler = DDIMScheduler.from_pretrained(str(source / "configs"), local_files_only=True)
    audio_encoder = Audio2Feature(model_path=str(source / "checkpoints/whisper/tiny.pt"), device="cuda",
                                  num_frames=16, audio_feat_length=config.data.audio_feat_length)
    duration = sf.info(work / "audio.wav").duration
    original_chunks = audio_encoder.feature2chunks
    # 上游循环额外产生尾帧；按真实配音长度截取，避免结果多出静音和误报进度。
    audio_encoder.feature2chunks = lambda feature_array, fps: original_chunks(feature_array, fps)[:math.ceil(duration * fps)]
    vae = AutoencoderKL.from_pretrained(str(source / "checkpoints/vae"), torch_dtype=torch.float16,
                                       local_files_only=True)
    vae.config.scaling_factor, vae.config.shift_factor = 0.18215, 0
    unet = UNet3DConditionModel.from_config(OmegaConf.to_container(config.model))
    checkpoint = torch.load(source / profile["checkpoint"], map_location="cpu", weights_only=True)
    unet.load_state_dict(checkpoint["state_dict"], strict=True)
    del checkpoint
    pipeline = LowMemoryPipeline(vae=vae, audio_encoder=audio_encoder,
                                 unet=unet.to(dtype=torch.float16), scheduler=scheduler).to("cuda")
    pipeline.enable_vae_slicing()
    pipeline.set_progress_bar_config(disable=True)
    set_seed(args.seed)
    total_steps = math.ceil(math.ceil(duration * 25) / 16) * args.steps
    completed = 0

    def callback(step, timestep, latents):
        nonlocal completed
        completed += 1
        emit(stage="inference", progress=min(93, 10 + int(83 * completed / max(1, total_steps))),
             text=f"生成口型 · 扩散步骤 {completed}/{total_steps}")

    emit(stage="aligning", progress=8, text="分析人脸与声音时序")
    pipeline(video_path="input.mp4", audio_path="audio.wav", video_out_path="synced.mp4",
             num_frames=16, num_inference_steps=args.steps, guidance_scale=args.guidance,
             weight_dtype=torch.float16, width=resolution, height=resolution,
             mask_image_path=str(source / "latentsync/utils/mask.png"), temp_dir="render", callback=callback)
    output = work / "synced.mp4"
    if not output.is_file() or output.stat().st_size < 1024:
        raise RuntimeError("模型没有产生有效视频，请检查 FFmpeg 日志。")
    report = {"engine": f"LatentSync {version}", "resolution": resolution, "numFrames": 16,
              "steps": args.steps, "guidance": args.guidance, "seed": args.seed,
              "duration": duration, "elapsedSeconds": round(time.monotonic() - started, 2),
              "peakAllocatedMB": round(torch.cuda.max_memory_allocated() / 1024 ** 2),
              "peakReservedMB": round(torch.cuda.max_memory_reserved() / 1024 ** 2),
              "gpu": torch.cuda.get_device_name()}
    (work / "inference.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    emit(stage="done", progress=98, text="模型推理完成", report=report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--model-version", choices=list(PROFILES), default="1.5")
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--guidance", type=float, default=1.5)
    parser.add_argument("--seed", type=int, default=1247)
    try:
        run(parser.parse_args())
    except Exception as exc:
        emit(stage="error", text=str(exc))
        raise
