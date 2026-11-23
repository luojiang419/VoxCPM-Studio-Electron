"""对口型模型配置与保守的硬件选择；安装器和独立推理进程共用。"""
from __future__ import annotations

import json
import shutil
import subprocess

PROFILES = {
    "1.5": {"resolution": 256, "config": "configs/unet/stage2.yaml",
            "checkpoint": "checkpoints/latentsync-1.5/latentsync_unet.pt",
            "revision": "32a20d29aead0498e3e885e90dbbe8027da1b61b"},
    "1.6": {"resolution": 512, "config": "configs/unet/stage2_512.yaml",
            "checkpoint": "checkpoints/latentsync_unet.pt",
            "revision": "c42c7e6c8e9c213626389fa7d9a3c444b8536353"},
}


def load_manifest(root, version):
    profile = PROFILES[version]
    for filename in (f"runtime-{version}.json", "runtime.json"):
        try:
            candidate = json.loads((root / filename).read_text(encoding="utf-8"))
            valid = candidate.get("version") == version and candidate.get("resolution") == profile["resolution"]
            legacy = version == "1.6" and not candidate.get("version") and candidate.get("modelRevision") == profile["revision"] and candidate.get("sourceRevision") == "a229c3948406bc2cf6eaf4873e662e70c6a04746"
            if (valid or legacy) and candidate.get("config", profile["config"]) == profile["config"] and candidate.get("checkpoint", profile["checkpoint"]) == profile["checkpoint"]:
                return candidate
        except (OSError, ValueError, AttributeError):
            continue
    return {}


def detect_hardware():
    # 与 runner 一致使用当前 CUDA 可见设备 0，尊重 CUDA_VISIBLE_DEVICES。
    # 不使用系统共享显存，也不把第二块显卡的显存加到第一块上。
    try:
        import torch
        if not torch.cuda.is_available() or torch.version.hip:
            return {"cuda": False, "name": "未检测到可用 NVIDIA CUDA 显卡", "totalMB": 0, "freeMB": 0}
        free, total = torch.cuda.mem_get_info(0)
        free_mb = round(free / 1024 ** 2)
        driver_free = None
        # Windows WDDM 的 cudaMemGetInfo 可能不包含其他进程的物理显存占用。
        # 按 UUID 匹配实际 CUDA 设备，取驱动与 CUDA 的较小值，不累加多卡。
        device_uuid = str(getattr(torch.cuda.get_device_properties(0), "uuid", "")).lower().removeprefix("gpu-")
        executable = shutil.which("nvidia-smi")
        if executable and device_uuid:
            try:
                result = subprocess.run([executable, "--query-gpu=uuid,memory.free", "--format=csv,noheader,nounits"],
                                        capture_output=True, text=True, timeout=5,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if result.returncode == 0:
                    for line in result.stdout.splitlines():
                        uuid, available = (part.strip() for part in line.split(",", 1))
                        if uuid.lower().removeprefix("gpu-") == device_uuid:
                            driver_free = int(available)
                            free_mb = min(free_mb, driver_free)
                            break
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        return {"cuda": True, "name": torch.cuda.get_device_name(0), "deviceUUID": device_uuid,
                "totalMB": round(total / 1024 ** 2), "freeMB": free_mb,
                "cudaFreeMB": round(free / 1024 ** 2), "driverFreeMB": driver_free}
    except Exception:
        return {"cuda": False, "name": "CUDA 硬件检测失败，请检查驱动和运行环境", "totalMB": 0, "freeMB": 0}


def select_profile(hardware, installed, requested="auto"):
    if requested not in {"auto", *PROFILES}:
        raise ValueError("模型选项必须为 auto、1.5 或 1.6。")
    total, free = hardware.get("totalMB", 0), hardware.get("freeMB", 0)
    if not hardware.get("cuda"):
        return "", "需要 NVIDIA CUDA 显卡；当前不启用 CPU 或集成显卡推理。"
    if total < 7680:
        return "", "显存不足 8 GB，暂不启用自动生成；建议使用至少 8 GB 的 NVIDIA 显卡。"
    recommended = "1.6" if total >= 15360 else "1.5"
    if requested != "auto":
        if requested == "1.6" and total < 15360:
            return "", "1.6 高清低显存模式建议至少 16 GB；当前请选择 1.5。"
        if requested not in installed:
            return "", f"尚未安装 LatentSync {requested}，请选择完整模型环境。"
        return requested, f"手动使用 {requested} 低显存模式；生成前将重新检查可用显存。"
    # 空闲显存只决定是否能启动，不改变按总容量选定的模型版本。
    if recommended == "1.6" and free < 7168:
        reason = "已选择 1.6；生成前释放语音模型并复检，空闲显存仍不足 7 GB 时停止，保留 1.6。"
    else:
        reason = "16 GB 及以上优先使用 1.6 高清低显存模式。" if recommended == "1.6" else "8～不足 16 GB 显存优先使用 1.5 低显存模式。"
    if recommended in installed:
        return recommended, reason
    if recommended == "1.6" and "1.5" in installed:
        return "1.5", "硬件适合 1.6，但尚未安装该权重，先使用已安装的 1.5。"
    return "", f"当前适合 LatentSync {recommended}，但尚未安装对应模型。"
