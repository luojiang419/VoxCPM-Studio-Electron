from __future__ import annotations

import json
import locale
import os
import shutil
import subprocess
import sys
import threading
import traceback
import zipfile
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# kaldifst 使用 C 运行库打开 FST；只设置字符编码，使中文安装路径可用。
if os.name == "nt":
    locale.setlocale(locale.LC_CTYPE, ".UTF8")

import importlib
import yaml
from .studio_resources import verify_model_resources


class _LazyModule:
    def __init__(self, name):
        self.name = name

    def __getattr__(self, name):
        return getattr(importlib.import_module(self.name), name)


gr = _LazyModule("gradio")
np = _LazyModule("numpy")
sf = _LazyModule("soundfile")
torch = _LazyModule("torch")


def VoxCPM(*args, **kwargs):
    from .core import VoxCPM as factory
    return factory(*args, **kwargs)


def LoRAConfig(*args, **kwargs):
    from .model.voxcpm import LoRAConfig as factory
    return factory(*args, **kwargs)


def AutoModel(*args, **kwargs):
    from funasr import AutoModel as factory
    return factory(*args, **kwargs)


def snapshot_download(*args, **kwargs):
    from huggingface_hub import snapshot_download as download
    return download(*args, **kwargs)


# 安装器/显式完整准备仍执行真实导入；正常桌面启动由主进程显式选择延迟导入。
if os.environ.get("VOXCPM_LAZY_STARTUP") != "1":
    import gradio as gr
    import numpy as np
    import soundfile as sf
    import torch
    from funasr import AutoModel
    from huggingface_hub import snapshot_download
    from .core import VoxCPM
    from .model.voxcpm import LoRAConfig


os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = PROJECT_ROOT / "assets"
DEFAULT_HF_MODEL_ID = "openbmb/VoxCPM2"
DEFAULT_ZIPENHANCER = "iic/speech_zipenhancer_ans_multiloss_16k_base"
DEFAULT_PROXY_URL = "http://127.0.0.1:7890"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"
NO_LORA_LABEL = "不使用 LoRA"
MODELS_ROOT = Path(os.environ.get("VOXCPM_MODELS_ROOT") or PROJECT_ROOT / "models")
LOCAL_VOXCPM2_DIR = MODELS_ROOT / "openbmb__VoxCPM2"
LOCAL_ZIPENHANCER_DIR = MODELS_ROOT / "iic__speech_zipenhancer_ans_multiloss_16k_base"
LOCAL_ASR_DIR = MODELS_ROOT / "iic__SenseVoiceSmall"
MODELSCOPE_REPO_MAP = {
    "openbmb/VoxCPM2": "OpenBMB/VoxCPM2",
    "openbmb/VoxCPM1.5": "OpenBMB/VoxCPM1.5",
    "openbmb/VoxCPM-0.5B": "OpenBMB/VoxCPM-0.5B",
    "OpenBMB/VoxCPM2": "OpenBMB/VoxCPM2",
    "OpenBMB/VoxCPM1.5": "OpenBMB/VoxCPM1.5",
    "OpenBMB/VoxCPM-0.5B": "OpenBMB/VoxCPM-0.5B",
}


def resolve_data_root() -> Path:
    override_root = os.environ.get("VOXCPM_DATA_ROOT", "").strip()
    if override_root:
        return Path(override_root).expanduser().resolve()
    return (PROJECT_ROOT / "data").resolve()


DATA_ROOT = resolve_data_root()
DATA_CONFIG_ROOT = DATA_ROOT / "config"
DATA_OUTPUT_ROOT = DATA_ROOT / "outputs"
DATA_LORA_ROOT = DATA_ROOT / "lora"
DATA_CACHE_ROOT = DATA_ROOT / "cache"
DEFAULT_CACHE_DIR = DATA_CACHE_ROOT / "model-hub"
CONFIG_PATH = DATA_CONFIG_ROOT / "studio_config.json"
DEFAULT_OUTPUT_DIR = DATA_OUTPUT_ROOT
LORA_ROOT = DATA_LORA_ROOT
LEGACY_CONFIG_PATH = PROJECT_ROOT / "studio_config.json"
LEGACY_OUTPUT_DIR = PROJECT_ROOT / "outputs"
LEGACY_CACHE_DIR = PROJECT_ROOT / "cache"
LEGACY_MODEL_HUB_CACHE_DIR = LEGACY_CACHE_DIR / "model-hub"

SECTION_ORDER = [
    ("workspace", "语音工作台"),
    ("overview", "项目概览"),
    ("batch", "批量生成"),
    ("training", "LoRA 微调"),
    ("system", "系统设置"),
]

GENERATION_MODES = [
    "声音设计",
    "可控克隆",
    "极致克隆",
]

def app_theme():
    return gr.themes.Base(
        primary_hue="slate",
        secondary_hue="slate",
        neutral_hue="slate",
        font=[
            gr.themes.GoogleFont("Manrope"),
            gr.themes.GoogleFont("IBM Plex Sans"),
            "Microsoft YaHei UI",
            "ui-sans-serif",
            "sans-serif",
        ],
    )


CUSTOM_CSS = """
:root {
    color-scheme: dark;
    --primary-50: #f7f4ef;
    --primary-100: #efe9e1;
    --primary-200: #ddd3c8;
    --primary-300: #c2b4a5;
    --primary-400: #9b8e81;
    --primary-500: #7a6f64;
    --primary-600: #61584f;
    --primary-700: #49423c;
    --primary-800: #312d29;
    --primary-900: #1f1c19;
    --primary-950: #11100f;
    --secondary-50: #f7f4ef;
    --secondary-100: #efe9e1;
    --secondary-200: #ddd3c8;
    --secondary-300: #c2b4a5;
    --secondary-400: #9b8e81;
    --secondary-500: #7a6f64;
    --secondary-600: #61584f;
    --secondary-700: #49423c;
    --secondary-800: #312d29;
    --secondary-900: #1f1c19;
    --secondary-950: #11100f;
    --neutral-50: #f7f4ef;
    --neutral-100: #efe9e1;
    --neutral-200: #ddd3c8;
    --neutral-300: #c2b4a5;
    --neutral-400: #9b8e81;
    --neutral-500: #7a6f64;
    --neutral-600: #61584f;
    --neutral-700: #49423c;
    --neutral-800: #312d29;
    --neutral-900: #1f1c19;
    --neutral-950: #11100f;
    --body-background-fill: transparent;
    --background-fill-primary: transparent;
    --background-fill-secondary: transparent;
    --block-background-fill: transparent;
    --block-border-color: transparent;
    --block-label-background-fill: transparent;
    --block-label-border-color: transparent;
    --panel-background-fill: transparent;
    --panel-border-color: transparent;
    --input-background-fill: rgba(255, 255, 255, 0.042);
    --input-background-fill-focus: rgba(255, 255, 255, 0.065);
    --input-background-fill-hover: rgba(255, 255, 255, 0.055);
    --input-border-color: rgba(255, 255, 255, 0.095);
    --input-border-color-focus: rgba(255, 255, 255, 0.18);
    --checkbox-label-background-fill: rgba(255, 255, 255, 0.04);
    --checkbox-label-background-fill-hover: rgba(255, 255, 255, 0.072);
    --checkbox-label-background-fill-selected: rgba(52, 49, 45, 0.98);
    --checkbox-label-border-color: rgba(255, 255, 255, 0.095);
    --checkbox-label-border-color-selected: rgba(255, 255, 255, 0.14);
    --checkbox-label-text-color-selected: #f3efe8;
    --checkbox-background-color-selected: rgba(230, 223, 213, 0.92);
    --button-primary-background-fill: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.045));
    --button-primary-background-fill-hover: linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.06));
    --button-primary-border-color: rgba(255, 255, 255, 0.18);
    --button-primary-border-color-hover: rgba(255, 255, 255, 0.22);
    --button-primary-text-color: #f3efe8;
    --button-secondary-background-fill: rgba(255, 255, 255, 0.04);
    --button-secondary-background-fill-hover: rgba(255, 255, 255, 0.072);
    --button-secondary-border-color: rgba(255, 255, 255, 0.095);
    --button-secondary-border-color-hover: rgba(255, 255, 255, 0.14);
    --button-secondary-text-color: #f3efe8;
    --studio-bg-deep: #0f0f10;
    --studio-bg: #121314;
    --studio-bg-soft: #161718;
    --studio-panel: rgba(30, 29, 27, 0.94);
    --studio-panel-elevated: rgba(41, 39, 36, 0.95);
    --studio-panel-strong: rgba(22, 21, 19, 0.97);
    --studio-panel-solid: #272522;
    --studio-panel-sheen: rgba(255, 255, 255, 0.04);
    --studio-panel-sheen-soft: rgba(255, 255, 255, 0.01);
    --studio-border: rgba(255, 255, 255, 0.08);
    --studio-border-strong: rgba(255, 255, 255, 0.14);
    --studio-text: #f3efe8;
    --studio-muted: #b5aea4;
    --studio-accent: #d6cec2;
    --studio-accent-strong: #fcf8f1;
    --studio-accent-soft: rgba(214, 206, 194, 0.12);
    --studio-chip-bg: rgba(42, 40, 37, 0.95);
    --studio-hover-bg: rgba(55, 52, 48, 0.98);
    --studio-input-bg: rgba(53, 50, 46, 0.94);
    --studio-input-bg-active: rgba(64, 60, 56, 0.98);
    --studio-input-border: rgba(255, 255, 255, 0.095);
    --studio-input-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    --studio-primary-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.045));
    --studio-primary-border: rgba(255, 255, 255, 0.18);
    --studio-primary-shadow: 0 10px 22px rgba(0, 0, 0, 0.22);
    --studio-focus-ring: 0 0 0 4px rgba(214, 206, 194, 0.12);
    --studio-disabled-bg: rgba(255, 255, 255, 0.022);
    --studio-disabled-text: rgba(243, 239, 232, 0.42);
    --studio-glow-a: rgba(255, 255, 255, 0.025);
    --studio-glow-b: rgba(141, 129, 116, 0.045);
    --studio-shadow-soft: 0 10px 24px rgba(0, 0, 0, 0.16);
    --studio-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
}

@media (prefers-color-scheme: light) {
    :root {
        color-scheme: light;
        --primary-50: #f8f5f0;
        --primary-100: #f0e9e0;
        --primary-200: #e0d5c8;
        --primary-300: #c7b8a8;
        --primary-400: #a3907e;
        --primary-500: #806f60;
        --primary-600: #66584b;
        --primary-700: #4d4339;
        --primary-800: #342d27;
        --primary-900: #221d18;
        --primary-950: #15110e;
        --secondary-50: #f8f5f0;
        --secondary-100: #f0e9e0;
        --secondary-200: #e0d5c8;
        --secondary-300: #c7b8a8;
        --secondary-400: #a3907e;
        --secondary-500: #806f60;
        --secondary-600: #66584b;
        --secondary-700: #4d4339;
        --secondary-800: #342d27;
        --secondary-900: #221d18;
        --secondary-950: #15110e;
        --neutral-50: #f8f5f0;
        --neutral-100: #f0e9e0;
        --neutral-200: #e0d5c8;
        --neutral-300: #c7b8a8;
        --neutral-400: #a3907e;
        --neutral-500: #806f60;
        --neutral-600: #66584b;
        --neutral-700: #4d4339;
        --neutral-800: #342d27;
        --neutral-900: #221d18;
        --neutral-950: #15110e;
        --body-background-fill: transparent;
        --background-fill-primary: transparent;
        --background-fill-secondary: transparent;
        --block-background-fill: transparent;
        --block-border-color: transparent;
        --block-label-background-fill: transparent;
        --block-label-border-color: transparent;
        --panel-background-fill: transparent;
        --panel-border-color: transparent;
        --input-background-fill: rgba(255, 255, 255, 0.86);
        --input-background-fill-focus: rgba(255, 255, 255, 0.98);
        --input-background-fill-hover: rgba(255, 255, 255, 0.92);
        --input-border-color: rgba(73, 62, 52, 0.13);
        --input-border-color-focus: rgba(34, 29, 24, 0.18);
        --checkbox-label-background-fill: rgba(255, 255, 255, 0.66);
        --checkbox-label-background-fill-hover: rgba(79, 71, 63, 0.06);
        --checkbox-label-background-fill-selected: rgba(225, 216, 205, 0.96);
        --checkbox-label-border-color: rgba(73, 62, 52, 0.13);
        --checkbox-label-border-color-selected: rgba(73, 62, 52, 0.18);
        --checkbox-label-text-color-selected: #181411;
        --checkbox-background-color-selected: rgba(79, 71, 63, 0.92);
        --button-primary-background-fill: linear-gradient(180deg, rgba(34, 29, 24, 0.08), rgba(34, 29, 24, 0.02));
        --button-primary-background-fill-hover: linear-gradient(180deg, rgba(34, 29, 24, 0.11), rgba(34, 29, 24, 0.035));
        --button-primary-border-color: rgba(34, 29, 24, 0.18);
        --button-primary-border-color-hover: rgba(34, 29, 24, 0.22);
        --button-primary-text-color: #181411;
        --button-secondary-background-fill: rgba(255, 255, 255, 0.66);
        --button-secondary-background-fill-hover: rgba(79, 71, 63, 0.06);
        --button-secondary-border-color: rgba(73, 62, 52, 0.13);
        --button-secondary-border-color-hover: rgba(73, 62, 52, 0.18);
        --button-secondary-text-color: #181411;
        --studio-bg-deep: #f2ece4;
        --studio-bg: #ebe2d7;
        --studio-bg-soft: #e1d7ca;
        --studio-panel: rgba(255, 251, 246, 0.92);
        --studio-panel-elevated: rgba(255, 255, 255, 0.95);
        --studio-panel-strong: rgba(247, 241, 234, 0.96);
        --studio-panel-solid: #fbf5ee;
        --studio-panel-sheen: rgba(255, 255, 255, 0.74);
        --studio-panel-sheen-soft: rgba(255, 255, 255, 0.2);
        --studio-border: rgba(73, 62, 52, 0.11);
        --studio-border-strong: rgba(73, 62, 52, 0.18);
        --studio-text: #181411;
        --studio-muted: #73695e;
        --studio-accent: #4f473f;
        --studio-accent-strong: #241e18;
        --studio-accent-soft: rgba(79, 71, 63, 0.09);
        --studio-chip-bg: rgba(255, 255, 255, 0.66);
        --studio-hover-bg: rgba(79, 71, 63, 0.06);
        --studio-input-bg: rgba(255, 255, 255, 0.86);
        --studio-input-bg-active: rgba(255, 255, 255, 0.98);
        --studio-input-border: rgba(73, 62, 52, 0.13);
        --studio-input-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
        --studio-primary-bg: linear-gradient(180deg, rgba(34, 29, 24, 0.08), rgba(34, 29, 24, 0.02));
        --studio-primary-border: rgba(34, 29, 24, 0.18);
        --studio-primary-shadow: 0 10px 22px rgba(80, 68, 52, 0.08);
        --studio-focus-ring: 0 0 0 4px rgba(79, 71, 63, 0.1);
        --studio-disabled-bg: rgba(73, 62, 52, 0.04);
        --studio-disabled-text: rgba(24, 20, 17, 0.42);
        --studio-glow-a: rgba(255, 255, 255, 0.42);
        --studio-glow-b: rgba(191, 178, 162, 0.12);
        --studio-shadow-soft: 0 8px 18px rgba(80, 68, 52, 0.05);
        --studio-shadow: 0 22px 48px rgba(80, 68, 52, 0.09);
    }
}

html:has(#studio-theme-dark:checked),
body:has(#studio-theme-dark:checked),
.gradio-container:has(#studio-theme-dark:checked) {
    color-scheme: dark;
    --primary-50: #f7f4ef;
    --primary-100: #efe9e1;
    --primary-200: #ddd3c8;
    --primary-300: #c2b4a5;
    --primary-400: #9b8e81;
    --primary-500: #7a6f64;
    --primary-600: #61584f;
    --primary-700: #49423c;
    --primary-800: #312d29;
    --primary-900: #1f1c19;
    --primary-950: #11100f;
    --secondary-50: #f7f4ef;
    --secondary-100: #efe9e1;
    --secondary-200: #ddd3c8;
    --secondary-300: #c2b4a5;
    --secondary-400: #9b8e81;
    --secondary-500: #7a6f64;
    --secondary-600: #61584f;
    --secondary-700: #49423c;
    --secondary-800: #312d29;
    --secondary-900: #1f1c19;
    --secondary-950: #11100f;
    --neutral-50: #f7f4ef;
    --neutral-100: #efe9e1;
    --neutral-200: #ddd3c8;
    --neutral-300: #c2b4a5;
    --neutral-400: #9b8e81;
    --neutral-500: #7a6f64;
    --neutral-600: #61584f;
    --neutral-700: #49423c;
    --neutral-800: #312d29;
    --neutral-900: #1f1c19;
    --neutral-950: #11100f;
    --body-background-fill: transparent;
    --background-fill-primary: transparent;
    --background-fill-secondary: transparent;
    --block-background-fill: transparent;
    --block-border-color: transparent;
    --block-label-background-fill: transparent;
    --block-label-border-color: transparent;
    --panel-background-fill: transparent;
    --panel-border-color: transparent;
    --input-background-fill: rgba(255, 255, 255, 0.042);
    --input-background-fill-focus: rgba(255, 255, 255, 0.065);
    --input-background-fill-hover: rgba(255, 255, 255, 0.055);
    --input-border-color: rgba(255, 255, 255, 0.095);
    --input-border-color-focus: rgba(255, 255, 255, 0.18);
    --checkbox-label-background-fill: rgba(255, 255, 255, 0.04);
    --checkbox-label-background-fill-hover: rgba(255, 255, 255, 0.072);
    --checkbox-label-background-fill-selected: rgba(52, 49, 45, 0.98);
    --checkbox-label-border-color: rgba(255, 255, 255, 0.095);
    --checkbox-label-border-color-selected: rgba(255, 255, 255, 0.14);
    --checkbox-label-text-color-selected: #f3efe8;
    --checkbox-background-color-selected: rgba(230, 223, 213, 0.92);
    --button-primary-background-fill: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.045));
    --button-primary-background-fill-hover: linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.06));
    --button-primary-border-color: rgba(255, 255, 255, 0.18);
    --button-primary-border-color-hover: rgba(255, 255, 255, 0.22);
    --button-primary-text-color: #f3efe8;
    --button-secondary-background-fill: rgba(255, 255, 255, 0.04);
    --button-secondary-background-fill-hover: rgba(255, 255, 255, 0.072);
    --button-secondary-border-color: rgba(255, 255, 255, 0.095);
    --button-secondary-border-color-hover: rgba(255, 255, 255, 0.14);
    --button-secondary-text-color: #f3efe8;
    --studio-bg-deep: #0f0f10;
    --studio-bg: #121314;
    --studio-bg-soft: #161718;
    --studio-panel: rgba(30, 29, 27, 0.94);
    --studio-panel-elevated: rgba(41, 39, 36, 0.95);
    --studio-panel-strong: rgba(22, 21, 19, 0.97);
    --studio-panel-solid: #272522;
    --studio-panel-sheen: rgba(255, 255, 255, 0.04);
    --studio-panel-sheen-soft: rgba(255, 255, 255, 0.01);
    --studio-border: rgba(255, 255, 255, 0.08);
    --studio-border-strong: rgba(255, 255, 255, 0.14);
    --studio-text: #f3efe8;
    --studio-muted: #b5aea4;
    --studio-accent: #d6cec2;
    --studio-accent-strong: #fcf8f1;
    --studio-accent-soft: rgba(214, 206, 194, 0.12);
    --studio-chip-bg: rgba(42, 40, 37, 0.95);
    --studio-hover-bg: rgba(55, 52, 48, 0.98);
    --studio-input-bg: rgba(53, 50, 46, 0.94);
    --studio-input-bg-active: rgba(64, 60, 56, 0.98);
    --studio-input-border: rgba(255, 255, 255, 0.095);
    --studio-input-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    --studio-primary-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.045));
    --studio-primary-border: rgba(255, 255, 255, 0.18);
    --studio-primary-shadow: 0 10px 22px rgba(0, 0, 0, 0.22);
    --studio-focus-ring: 0 0 0 4px rgba(214, 206, 194, 0.12);
    --studio-disabled-bg: rgba(255, 255, 255, 0.022);
    --studio-disabled-text: rgba(243, 239, 232, 0.42);
    --studio-glow-a: rgba(255, 255, 255, 0.025);
    --studio-glow-b: rgba(141, 129, 116, 0.045);
    --studio-shadow-soft: 0 10px 24px rgba(0, 0, 0, 0.16);
    --studio-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
}

html:has(#studio-theme-light:checked),
body:has(#studio-theme-light:checked),
.gradio-container:has(#studio-theme-light:checked) {
    color-scheme: light;
    --primary-50: #f8f5f0;
    --primary-100: #f0e9e0;
    --primary-200: #e0d5c8;
    --primary-300: #c7b8a8;
    --primary-400: #a3907e;
    --primary-500: #806f60;
    --primary-600: #66584b;
    --primary-700: #4d4339;
    --primary-800: #342d27;
    --primary-900: #221d18;
    --primary-950: #15110e;
    --secondary-50: #f8f5f0;
    --secondary-100: #f0e9e0;
    --secondary-200: #e0d5c8;
    --secondary-300: #c7b8a8;
    --secondary-400: #a3907e;
    --secondary-500: #806f60;
    --secondary-600: #66584b;
    --secondary-700: #4d4339;
    --secondary-800: #342d27;
    --secondary-900: #221d18;
    --secondary-950: #15110e;
    --neutral-50: #f8f5f0;
    --neutral-100: #f0e9e0;
    --neutral-200: #e0d5c8;
    --neutral-300: #c7b8a8;
    --neutral-400: #a3907e;
    --neutral-500: #806f60;
    --neutral-600: #66584b;
    --neutral-700: #4d4339;
    --neutral-800: #342d27;
    --neutral-900: #221d18;
    --neutral-950: #15110e;
    --body-background-fill: transparent;
    --background-fill-primary: transparent;
    --background-fill-secondary: transparent;
    --block-background-fill: transparent;
    --block-border-color: transparent;
    --block-label-background-fill: transparent;
    --block-label-border-color: transparent;
    --panel-background-fill: transparent;
    --panel-border-color: transparent;
    --input-background-fill: rgba(255, 255, 255, 0.86);
    --input-background-fill-focus: rgba(255, 255, 255, 0.98);
    --input-background-fill-hover: rgba(255, 255, 255, 0.92);
    --input-border-color: rgba(73, 62, 52, 0.13);
    --input-border-color-focus: rgba(34, 29, 24, 0.18);
    --checkbox-label-background-fill: rgba(255, 255, 255, 0.66);
    --checkbox-label-background-fill-hover: rgba(79, 71, 63, 0.06);
    --checkbox-label-background-fill-selected: rgba(225, 216, 205, 0.96);
    --checkbox-label-border-color: rgba(73, 62, 52, 0.13);
    --checkbox-label-border-color-selected: rgba(73, 62, 52, 0.18);
    --checkbox-label-text-color-selected: #181411;
    --checkbox-background-color-selected: rgba(79, 71, 63, 0.92);
    --button-primary-background-fill: linear-gradient(180deg, rgba(34, 29, 24, 0.08), rgba(34, 29, 24, 0.02));
    --button-primary-background-fill-hover: linear-gradient(180deg, rgba(34, 29, 24, 0.11), rgba(34, 29, 24, 0.035));
    --button-primary-border-color: rgba(34, 29, 24, 0.18);
    --button-primary-border-color-hover: rgba(34, 29, 24, 0.22);
    --button-primary-text-color: #181411;
    --button-secondary-background-fill: rgba(255, 255, 255, 0.66);
    --button-secondary-background-fill-hover: rgba(79, 71, 63, 0.06);
    --button-secondary-border-color: rgba(73, 62, 52, 0.13);
    --button-secondary-border-color-hover: rgba(73, 62, 52, 0.18);
    --button-secondary-text-color: #181411;
    --studio-bg-deep: #f2ece4;
    --studio-bg: #ebe2d7;
    --studio-bg-soft: #e1d7ca;
    --studio-panel: rgba(255, 251, 246, 0.92);
    --studio-panel-elevated: rgba(255, 255, 255, 0.95);
    --studio-panel-strong: rgba(247, 241, 234, 0.96);
    --studio-panel-solid: #fbf5ee;
    --studio-panel-sheen: rgba(255, 255, 255, 0.74);
    --studio-panel-sheen-soft: rgba(255, 255, 255, 0.2);
    --studio-border: rgba(73, 62, 52, 0.11);
    --studio-border-strong: rgba(73, 62, 52, 0.18);
    --studio-text: #181411;
    --studio-muted: #73695e;
    --studio-accent: #4f473f;
    --studio-accent-strong: #241e18;
    --studio-accent-soft: rgba(79, 71, 63, 0.09);
    --studio-chip-bg: rgba(255, 255, 255, 0.66);
    --studio-hover-bg: rgba(79, 71, 63, 0.06);
    --studio-input-bg: rgba(255, 255, 255, 0.86);
    --studio-input-bg-active: rgba(255, 255, 255, 0.98);
    --studio-input-border: rgba(73, 62, 52, 0.13);
    --studio-input-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
    --studio-primary-bg: linear-gradient(180deg, rgba(34, 29, 24, 0.08), rgba(34, 29, 24, 0.02));
    --studio-primary-border: rgba(34, 29, 24, 0.18);
    --studio-primary-shadow: 0 10px 22px rgba(80, 68, 52, 0.08);
    --studio-focus-ring: 0 0 0 4px rgba(79, 71, 63, 0.1);
    --studio-disabled-bg: rgba(73, 62, 52, 0.04);
    --studio-disabled-text: rgba(24, 20, 17, 0.42);
    --studio-glow-a: rgba(255, 255, 255, 0.42);
    --studio-glow-b: rgba(191, 178, 162, 0.12);
    --studio-shadow-soft: 0 8px 18px rgba(80, 68, 52, 0.05);
    --studio-shadow: 0 22px 48px rgba(80, 68, 52, 0.09);
}

html, body, .gradio-container {
    min-height: 100%;
    background:
        radial-gradient(circle at top left, var(--studio-glow-a), transparent 33%),
        radial-gradient(circle at top right, var(--studio-glow-b), transparent 30%),
        linear-gradient(145deg, var(--studio-bg-deep) 0%, var(--studio-bg) 48%, var(--studio-bg-soft) 100%);
    color: var(--studio-text);
    font-family: "Manrope", "IBM Plex Sans", "Microsoft YaHei UI", sans-serif;
    background-attachment: fixed;
}

gradio-app,
.gradio-container .main,
.gradio-container .app,
.gradio-container .fillable,
.gradio-container .wrap.svelte-zxu34v,
.gradio-container main.contain {
    background: transparent !important;
}

.gradio-container {
    padding: 20px 24px 32px 24px !important;
}

.studio-shell {
    gap: 18px;
    align-items: flex-start;
}

.glass-panel,
.glass-card,
.sidebar-panel,
.hero-panel,
.feature-panel,
.status-card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--studio-border);
    border-radius: 26px;
    box-shadow: var(--studio-shadow);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
}

.sidebar-panel::before,
.hero-panel::before,
.feature-panel::before,
.status-card::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, var(--studio-panel-sheen), var(--studio-panel-sheen-soft) 34%, transparent 100%);
    pointer-events: none;
}

.sidebar-panel {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent 40%), var(--studio-panel-strong);
    padding: 16px !important;
    position: sticky;
    top: 18px;
}

.sidebar-column {
    min-width: 236px !important;
    max-width: 252px;
}

.hero-panel {
    background: linear-gradient(180deg, var(--studio-panel-sheen), transparent 56%), var(--studio-panel-elevated);
    padding: 20px 22px;
    margin-bottom: 10px;
    box-shadow: var(--studio-shadow-soft);
}

.hero-panel h2 {
    margin: 0 0 6px 0;
    font-size: 1.36rem;
    font-weight: 720;
    letter-spacing: -0.02em;
}

.hero-panel h1,
.hero-panel h2,
.hero-panel h3,
.hero-panel p,
.feature-panel h1,
.feature-panel h2,
.feature-panel h3,
.feature-panel p,
.status-card p,
.status-card li,
.feature-panel li,
.hero-panel li,
.gr-markdown,
.gr-markdown p,
.gr-markdown li,
.gr-markdown h1,
.gr-markdown h2,
.gr-markdown h3,
.gr-markdown h4 {
    color: var(--studio-text) !important;
}

.feature-panel {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.012), transparent 34%), var(--studio-panel);
    padding: 22px !important;
}

.gr-group.feature-panel,
.gr-group.feature-panel > .styler {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.012), transparent 34%), var(--studio-panel) !important;
    border-radius: 26px !important;
}

.feature-panel [data-testid$="-radio-label"] {
    background: rgba(52, 49, 45, 0.98) !important;
    border: 1px solid var(--studio-input-border) !important;
    color: var(--studio-text) !important;
    box-shadow: var(--studio-input-shadow) !important;
}

.feature-panel [data-testid$="-radio-label"]:hover {
    background: rgba(61, 57, 52, 0.98) !important;
    border-color: var(--studio-border-strong) !important;
}

.feature-panel [data-testid$="-radio-label"].selected {
    background: rgba(68, 64, 59, 0.98) !important;
    border-color: rgba(255, 255, 255, 0.16) !important;
    box-shadow: var(--studio-primary-shadow) !important;
}

.feature-panel [data-testid$="-radio-label"] span {
    color: var(--studio-text) !important;
}

.feature-panel [data-testid$="-radio-label"] input.svelte-19qdtil {
    appearance: none !important;
    -webkit-appearance: none !important;
    width: 16px !important;
    height: 16px !important;
    min-width: 16px !important;
    border-radius: 999px !important;
    border: 1px solid var(--studio-input-border) !important;
    background: rgba(49, 45, 41, 0.98) !important;
    box-shadow: inset 0 0 0 3px rgba(25, 24, 22, 0.98) !important;
}

.feature-panel [data-testid$="-radio-label"].selected input.svelte-19qdtil {
    border-color: rgba(255, 255, 255, 0.18) !important;
    background: rgba(236, 230, 221, 0.95) !important;
    box-shadow: inset 0 0 0 3px rgba(83, 74, 64, 0.9) !important;
}

.feature-panel .block:has([aria-label="Empty value"]) {
    background: rgba(44, 41, 37, 0.98) !important;
    border: 1px solid var(--studio-input-border) !important;
}

.feature-panel [aria-label="Empty value"] {
    background: rgba(44, 41, 37, 0.98) !important;
    border: 1px solid var(--studio-input-border) !important;
    border-radius: 22px !important;
}

.feature-panel .empty.svelte-v95lt3 {
    background: rgba(44, 41, 37, 0.98) !important;
    border: 1px solid var(--studio-input-border) !important;
    border-radius: 22px !important;
    color: var(--studio-muted) !important;
}

.feature-panel .icon.svelte-v95lt3 {
    color: var(--studio-muted) !important;
}

.feature-panel .empty,
.feature-panel .empty .icon {
    background: transparent !important;
    color: var(--studio-muted) !important;
}

.feature-panel .empty svg,
.feature-panel [aria-label="Empty value"] svg {
    color: var(--studio-muted) !important;
}

.status-card {
    background: linear-gradient(180deg, var(--studio-panel-sheen), transparent 58%), var(--studio-panel-elevated);
    padding: 16px 18px;
    margin-bottom: 14px;
    box-shadow: var(--studio-shadow-soft);
}

.status-card .muted {
    color: var(--studio-muted);
    font-size: 0.94rem;
    line-height: 1.55;
}

.logo-wrap {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 18px;
}

.logo-wrap img {
    width: 54px;
    height: 54px;
    object-fit: contain;
    filter: drop-shadow(0 10px 18px var(--studio-accent-soft));
    margin-top: 2px;
}

.logo-copy {
    min-width: 0;
}

.logo-copy h1 {
    margin: 0;
    font-size: 1.26rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.16;
}

.logo-copy p {
    margin: 5px 0 0 0;
    color: var(--studio-muted);
    font-size: 0.86rem;
    line-height: 1.55;
}

.theme-switcher {
    margin-bottom: 18px;
    padding: 14px;
    border-radius: 22px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 65%), var(--studio-panel-elevated);
    border: 1px solid var(--studio-border);
    box-shadow: var(--studio-shadow-soft);
}

.theme-switcher-title {
    margin: 0 0 4px 0;
    font-size: 0.92rem;
    font-weight: 700;
    color: var(--studio-text);
}

.theme-switcher-note {
    margin: 8px 0 0 0;
    color: var(--studio-muted);
    font-size: 0.8rem;
    line-height: 1.5;
}

.theme-switcher-grid {
    display: grid;
    gap: 8px;
}

.theme-option {
    position: relative;
}

.theme-option input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
}

.theme-option label {
    display: block;
    padding: 10px 12px;
    border-radius: 16px;
    border: 1px solid var(--studio-input-border);
    background: var(--studio-input-bg);
    color: var(--studio-text);
    cursor: pointer;
    font-size: 0.88rem;
    font-weight: 620;
    box-shadow: var(--studio-input-shadow);
    transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

.theme-option label:hover {
    border-color: var(--studio-border-strong);
    background: var(--studio-input-bg-active);
}

.theme-option input:checked + label {
    background: var(--studio-primary-bg);
    border-color: var(--studio-primary-border);
    box-shadow: var(--studio-primary-shadow);
    transform: translateY(-1px);
}

.nav-button {
    margin-bottom: 10px;
}

.nav-button button {
    width: 100%;
    justify-content: flex-start !important;
    border-radius: 18px !important;
    border: 1px solid var(--studio-input-border) !important;
    background: var(--studio-chip-bg) !important;
    color: var(--studio-text) !important;
    min-height: 52px !important;
    font-size: 0.98rem !important;
    font-weight: 620 !important;
    letter-spacing: -0.01em;
    box-shadow: var(--studio-input-shadow) !important;
    transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
}

.nav-button button:hover {
    transform: translateX(3px);
    border-color: var(--studio-border-strong) !important;
    background: var(--studio-hover-bg) !important;
    box-shadow: var(--studio-shadow-soft) !important;
}

.nav-button button.primary {
    background: var(--studio-primary-bg) !important;
    border-color: var(--studio-primary-border) !important;
    box-shadow: var(--studio-primary-shadow) !important;
}

.section-title {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 12px;
}

.section-title h2 {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 720;
    line-height: 1.2;
    letter-spacing: -0.035em;
}

.section-title p {
    margin: 4px 0 0 0;
    color: var(--studio-muted);
    font-size: 0.94rem;
    line-height: 1.55;
}

.metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-top: 12px;
}

.metric-chip {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 65%), var(--studio-chip-bg);
    border: 1px solid var(--studio-input-border);
    border-radius: 18px;
    padding: 14px 16px;
    box-shadow: var(--studio-input-shadow);
}

.metric-chip strong {
    display: block;
    font-size: 1.08rem;
    margin-bottom: 6px;
    color: var(--studio-accent-strong);
    letter-spacing: -0.02em;
}

.metric-chip span {
    color: var(--studio-muted);
    font-size: 0.92rem;
    line-height: 1.5;
}

.field-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 10px 0;
}

.field-heading .field-name {
    font-size: 0.98rem;
    font-weight: 630;
    letter-spacing: -0.01em;
}

.field-heading .field-hint {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--studio-input-border);
    background: var(--studio-accent-soft);
    color: var(--studio-accent-strong);
    font-size: 0.77rem;
    font-weight: 620;
    cursor: help;
    box-shadow: var(--studio-input-shadow);
}

.field-heading .field-hint-card {
    position: absolute;
    left: 0;
    top: calc(100% + 10px);
    width: min(300px, 70vw);
    padding: 12px 14px;
    border-radius: 16px;
    background: linear-gradient(180deg, var(--studio-panel-sheen), transparent 30%), var(--studio-panel-strong);
    border: 1px solid var(--studio-border-strong);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
    color: var(--studio-text);
    opacity: 0;
    pointer-events: none;
    transform: translateY(8px);
    transition: opacity 0.18s ease, transform 0.18s ease;
    z-index: 30;
    line-height: 1.55;
}

.field-heading .field-hint:hover .field-hint-card,
.field-heading .field-hint:focus-within .field-hint-card {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
}

.section-note {
    padding: 14px 16px;
    border-radius: 18px;
    margin-bottom: 14px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 65%), var(--studio-chip-bg);
    border: 1px solid var(--studio-input-border);
    color: var(--studio-muted);
    line-height: 1.6;
    box-shadow: var(--studio-input-shadow);
}

.gr-button-primary,
.gr-button-secondary,
button.primary,
button.secondary {
    border-radius: 18px !important;
}

.gr-button-primary,
button.primary {
    background: var(--studio-primary-bg) !important;
    border: 1px solid var(--studio-primary-border) !important;
    color: var(--studio-text) !important;
    box-shadow: var(--studio-primary-shadow) !important;
    font-weight: 650 !important;
}

.gr-button-secondary,
button.secondary {
    background: var(--studio-chip-bg) !important;
    border: 1px solid var(--studio-input-border) !important;
    color: var(--studio-text) !important;
    box-shadow: var(--studio-input-shadow) !important;
    font-weight: 620 !important;
}

.gradio-container button:not([disabled]):hover {
    border-color: var(--studio-border-strong) !important;
}

.gradio-container button[disabled],
.gradio-container input[disabled],
.gradio-container textarea[disabled],
.gradio-container select[disabled] {
    background: var(--studio-disabled-bg) !important;
    color: var(--studio-disabled-text) !important;
    border-color: var(--studio-input-border) !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    opacity: 1 !important;
}

.compact-row {
    gap: 12px !important;
}

.glass-accordion {
    border-radius: 20px !important;
    overflow: hidden;
    border: 1px solid var(--studio-input-border) !important;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 72%), var(--studio-panel-elevated);
    box-shadow: var(--studio-input-shadow);
}

.glass-accordion > button,
.glass-accordion > .label-wrap {
    background: rgba(255, 255, 255, 0.02) !important;
    color: var(--studio-text) !important;
}

.gradio-container textarea,
.gradio-container input,
.gradio-container select,
.gradio-container .wrap {
    color: var(--studio-text) !important;
    accent-color: var(--studio-accent);
}

.gradio-container textarea,
.gradio-container input[type="text"],
.gradio-container input[type="number"],
.gradio-container select,
.gradio-container .wrap {
    background: var(--studio-input-bg) !important;
    border: 1px solid var(--studio-input-border) !important;
    border-radius: 18px !important;
    box-shadow: var(--studio-input-shadow);
}

.gradio-container .input-container,
.gradio-container .form > .wrap,
.gradio-container .block .wrap {
    background: transparent !important;
}

.gradio-container .block {
    border-radius: 20px !important;
}

.gradio-container .block.padded {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
}

.gradio-container .wrap,
.gradio-container .form {
    border-radius: 20px !important;
}

.gradio-container .panel,
.gradio-container .form {
    background: transparent !important;
}

.gradio-container textarea:focus,
.gradio-container input[type="text"]:focus,
.gradio-container input[type="number"]:focus,
.gradio-container select:focus,
.gradio-container .wrap:focus-within {
    background: var(--studio-input-bg-active) !important;
    border-color: var(--studio-primary-border) !important;
    box-shadow: var(--studio-focus-ring), var(--studio-input-shadow) !important;
}

.gradio-container ::placeholder {
    color: var(--studio-muted) !important;
    opacity: 0.9;
}

.gradio-container .prose strong {
    color: var(--studio-accent-strong) !important;
}

.gradio-container .prose,
.gradio-container .gr-markdown,
.gradio-container .gr-markdown p,
.gradio-container .gr-markdown li {
    line-height: 1.65;
}

.gradio-container code {
    background: var(--studio-accent-soft);
    color: var(--studio-accent-strong);
    border-radius: 8px;
    padding: 2px 6px;
}

.gradio-container .block-label,
.gradio-container label,
.gradio-container .label-wrap span {
    color: var(--studio-text) !important;
    font-weight: 600 !important;
}

.footer-tip {
    margin-top: 14px;
    color: var(--studio-muted);
    font-size: 0.88rem;
    line-height: 1.6;
    padding: 2px 2px 0 2px;
}

@media (min-width: 1280px) {
    .sidebar-column {
        flex: 0 0 248px !important;
    }
}
"""


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def tip_html(title: str, tip: str) -> str:
    return (
        '<div class="field-heading">'
        f'<span class="field-name">{title}</span>'
        '<span class="field-hint">说明'
        f'<span class="field-hint-card">{tip}</span>'
        "</span>"
        "</div>"
    )


def section_header_html(title: str, desc: str) -> str:
    return (
        '<div class="section-title">'
        f"<div><h2>{title}</h2><p>{desc}</p></div>"
        "</div>"
    )


def theme_switcher_html() -> str:
    return """
    <div class="theme-switcher">
      <p class="theme-switcher-title">界面主题</p>
      <div class="theme-switcher-grid">
        <div class="theme-option">
          <input type="radio" name="studio_theme_mode" id="studio-theme-auto" checked onclick="window.__voxcpmStudioTheme?.set('auto')">
          <label for="studio-theme-auto">跟随系统</label>
        </div>
        <div class="theme-option">
          <input type="radio" name="studio_theme_mode" id="studio-theme-dark" onclick="window.__voxcpmStudioTheme?.set('dark')">
          <label for="studio-theme-dark">深灰暗黑</label>
        </div>
        <div class="theme-option">
          <input type="radio" name="studio_theme_mode" id="studio-theme-light" onclick="window.__voxcpmStudioTheme?.set('light')">
          <label for="studio-theme-light">浅色模式</label>
        </div>
      </div>
      <p class="theme-switcher-note">即时切换，无需重启。默认会跟随系统主题。</p>
      <script>
      (() => {
        const storageKey = "voxcpm-studio-theme";
        const readStoredTheme = () => {
          try {
            return localStorage.getItem(storageKey) || "auto";
          } catch (error) {
            return "auto";
          }
        };
        const writeStoredTheme = (value) => {
          try {
            localStorage.setItem(storageKey, value);
          } catch (error) {}
        };
        window.__voxcpmStudioTheme = { set: writeStoredTheme };
        const storedTheme = readStoredTheme();
        const radio = document.getElementById(`studio-theme-${storedTheme}`);
        if (radio) {
          radio.checked = true;
        }
      })();
      </script>
    </div>
    """


@dataclass
class StudioSettings:
    model_dir: str = ""
    hf_repo_id: str = DEFAULT_HF_MODEL_ID
    cache_dir: str = str(DEFAULT_CACHE_DIR)
    zipenhancer_path: str = ""
    output_dir: str = str(DEFAULT_OUTPUT_DIR)
    proxy_url: str = DEFAULT_PROXY_URL
    disable_denoiser: bool = False
    disable_optimize: bool = False


class VoxCPMStudio:
    def __init__(self, model_dir: Optional[str] = None) -> None:
        self.settings = self._load_settings(model_dir)
        self.device = "按需检测" if os.environ.get("VOXCPM_LAZY_STARTUP") == "1" else "cuda" if torch.cuda.is_available() else "cpu"
        self.voxcpm_model: Optional[VoxCPM] = None
        self.asr_model: Optional[AutoModel] = None
        self.loaded_model_key: Optional[str] = None
        self.loaded_model_dir: str = ""
        self.loaded_lora: Optional[str] = None
        self.training_process: Optional[subprocess.Popen[str]] = None
        self.training_log = ""
        self.training_log_base_offset = 0
        self.training_output_dir = ""
        self.training_config_path = ""
        self.training_command: list[str] = []
        self.training_last_exit_code: Optional[int] = None

        for directory in (
            DATA_ROOT,
            DATA_CONFIG_ROOT,
            DATA_OUTPUT_ROOT,
            DATA_LORA_ROOT,
            DATA_CACHE_ROOT,
            DEFAULT_CACHE_DIR,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        Path(self.settings.output_dir).mkdir(parents=True, exist_ok=True)

    def _load_settings(self, model_dir: Optional[str]) -> StudioSettings:
        payload = {}
        should_persist_data_config = False
        if CONFIG_PATH.exists():
            payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        elif LEGACY_CONFIG_PATH.exists():
            payload = json.loads(LEGACY_CONFIG_PATH.read_text(encoding="utf-8-sig"))
            should_persist_data_config = True

        settings = StudioSettings(**{k: payload.get(k, v) for k, v in asdict(StudioSettings()).items()})

        env_model_dir = os.environ.get("VOXCPM_MODEL_DIR", "").strip()
        env_repo_id = os.environ.get("HF_REPO_ID", "").strip()
        env_zip = os.environ.get("ZIPENHANCER_MODEL_PATH", "").strip()

        if model_dir:
            settings.model_dir = model_dir
        elif env_model_dir and (not settings.model_dir or os.environ.get('VOXCPM_INSTALLED_RESOURCES_READONLY') == '1'):
            settings.model_dir = env_model_dir
        elif not settings.model_dir and (LOCAL_VOXCPM2_DIR / "config.json").is_file():
            settings.model_dir = str(LOCAL_VOXCPM2_DIR)

        if not settings.hf_repo_id and env_repo_id:
            settings.hf_repo_id = env_repo_id
        if env_zip and (not settings.zipenhancer_path or os.environ.get('VOXCPM_INSTALLED_RESOURCES_READONLY') == '1'):
            settings.zipenhancer_path = env_zip
        elif not settings.zipenhancer_path and LOCAL_ZIPENHANCER_DIR.is_dir():
            settings.zipenhancer_path = str(LOCAL_ZIPENHANCER_DIR)

        if not settings.output_dir:
            settings.output_dir = str(DEFAULT_OUTPUT_DIR)
            should_persist_data_config = True
        elif self._path_matches(
            settings.output_dir,
            str(LEGACY_OUTPUT_DIR),
            "outputs",
            "./outputs",
            ".\\outputs",
        ):
            settings.output_dir = str(DEFAULT_OUTPUT_DIR)
            should_persist_data_config = True
        if not settings.cache_dir:
            settings.cache_dir = str(DEFAULT_CACHE_DIR)
            should_persist_data_config = True
        elif self._path_matches(
            settings.cache_dir,
            str(LEGACY_CACHE_DIR),
            str(LEGACY_MODEL_HUB_CACHE_DIR),
            "cache",
            "cache/model-hub",
            "cache\\model-hub",
            "./cache",
            ".\\cache",
        ):
            settings.cache_dir = str(DEFAULT_CACHE_DIR)
            should_persist_data_config = True

        if should_persist_data_config:
            DATA_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
            CONFIG_PATH.write_text(
                json.dumps(asdict(settings), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        return settings

    def _path_matches(self, value: str, *candidates: str) -> bool:
        clean_value = (value or "").strip()
        if not clean_value:
            return False
        normalized_value = os.path.normcase(os.path.normpath(clean_value))
        return any(
            normalized_value == os.path.normcase(os.path.normpath(candidate))
            for candidate in candidates
            if candidate
        )

    def persist_settings(
        self,
        model_dir: str,
        hf_repo_id: str,
        cache_dir: str,
        zipenhancer_path: str,
        output_dir: str,
        proxy_url: str,
        disable_denoiser: bool,
        disable_optimize: bool,
    ) -> tuple[str, str]:
        self.settings = StudioSettings(
            model_dir=(model_dir or "").strip(),
            hf_repo_id=(hf_repo_id or "").strip() or DEFAULT_HF_MODEL_ID,
            cache_dir=(cache_dir or "").strip() or str(DEFAULT_CACHE_DIR),
            zipenhancer_path=(zipenhancer_path or "").strip(),
            output_dir=(output_dir or "").strip() or str(DEFAULT_OUTPUT_DIR),
            proxy_url=(proxy_url or "").strip() or DEFAULT_PROXY_URL,
            disable_denoiser=bool(disable_denoiser),
            disable_optimize=bool(disable_optimize),
        )
        DATA_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
        Path(self.settings.cache_dir).mkdir(parents=True, exist_ok=True)
        Path(self.settings.output_dir).mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(asdict(self.settings), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.reset_runtime()
        message = f"已保存设置到 `{CONFIG_PATH.name}`，运行时已重置，新的模型参数会在下一次调用时生效。"
        return message, self.runtime_markdown()

    def settings_payload(self) -> dict[str, Any]:
        return asdict(self.settings)

    def reset_runtime(self) -> None:
        self.voxcpm_model = None
        self.asr_model = None
        self.loaded_model_key = None
        self.loaded_model_dir = ""
        self.loaded_lora = None

    def _append_training_log(self, chunk: str) -> None:
        self.training_log += chunk
        max_log_chars = 120000
        overflow = len(self.training_log) - max_log_chars
        if overflow > 0:
            self.training_log = self.training_log[overflow:]
            self.training_log_base_offset += overflow

    def _training_is_running(self) -> bool:
        return self.training_process is not None and self.training_process.poll() is None

    def detect_sample_rate(self, pretrained_path: str) -> Optional[int]:
        config_file = Path(pretrained_path) / "config.json"
        if not config_file.is_file():
            return None
        try:
            payload = json.loads(config_file.read_text(encoding="utf-8"))
            return int(payload["audio_vae_config"]["sample_rate"])
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            return None

    def scan_lora_checkpoints(self) -> list[str]:
        checkpoints: list[str] = []
        if not LORA_ROOT.exists():
            return checkpoints

        for root, _, files in os.walk(LORA_ROOT):
            if "lora_weights.safetensors" in files or "lora_weights.ckpt" in files:
                rel_path = os.path.relpath(root, LORA_ROOT)
                checkpoints.append(rel_path)
        return sorted(set(checkpoints), reverse=True)

    def lora_entries_payload(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for rel_path in self.scan_lora_checkpoints():
            lora_dir = LORA_ROOT / rel_path
            lora_config, base_model = self.read_lora_config_from_checkpoint(rel_path)
            config_path = lora_dir / "lora_config.json"
            weights_path = lora_dir / "lora_weights.safetensors"
            ckpt_path = lora_dir / "lora_weights.ckpt"
            updated_at = None
            for candidate in (weights_path, ckpt_path, config_path):
                if candidate.exists():
                    updated_at = datetime.fromtimestamp(candidate.stat().st_mtime).isoformat()
                    break
            entries.append(
                {
                    "id": rel_path,
                    "label": rel_path,
                    "base_model": base_model or "",
                    "config_path": str(config_path) if config_path.exists() else "",
                    "weights_path": str(weights_path if weights_path.exists() else ckpt_path if ckpt_path.exists() else ""),
                    "updated_at": updated_at or "",
                    "loaded": self.loaded_lora == rel_path,
                    "config": lora_config or None,
                }
            )
        return entries

    def read_lora_config_from_checkpoint(self, rel_path: str) -> tuple[dict | None, str | None]:
        config_file = LORA_ROOT / rel_path / "lora_config.json"
        if not config_file.exists():
            return None, None
        try:
            payload = json.loads(config_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None, None

        lora_payload = payload.get("lora_config")
        if not lora_payload:
            return None, payload.get("base_model")
        return lora_payload, payload.get("base_model")

    def load_lora_config_from_checkpoint(self, rel_path: str) -> tuple[LoRAConfig | None, str | None]:
        payload, base_model = self.read_lora_config_from_checkpoint(rel_path)
        return (LoRAConfig(**payload) if payload else None), base_model

    def default_lora_config(self) -> LoRAConfig:
        return LoRAConfig(
            enable_lm=True,
            enable_dit=True,
            enable_proj=False,
            r=32,
            alpha=16,
            dropout=0.0,
            target_modules_lm=["q_proj", "v_proj", "k_proj", "o_proj"],
            target_modules_dit=["q_proj", "v_proj", "k_proj", "o_proj"],
        )

    def resolve_model_source(self, preferred_lora: str | None = None) -> str:
        if self.settings.model_dir and Path(self.settings.model_dir).is_dir():
            return self.settings.model_dir

        if preferred_lora and preferred_lora != NO_LORA_LABEL:
            _, base_model = self.load_lora_config_from_checkpoint(preferred_lora)
            if base_model and Path(base_model).is_dir():
                return base_model

        repo_id = (self.settings.hf_repo_id or DEFAULT_HF_MODEL_ID).strip()
        local_cache_dir = PROJECT_ROOT / "models" / repo_id.replace("/", "__")
        if local_cache_dir.is_dir():
            return str(local_cache_dir)
        return repo_id

    @contextmanager
    def temporary_env(self, overrides: dict[str, str]) -> None:
        previous = {key: os.environ.get(key) for key in overrides}
        try:
            for key, value in overrides.items():
                if value:
                    os.environ[key] = value
                elif key in os.environ:
                    del os.environ[key]
            yield
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def try_modelscope_download(self, repo_id: str) -> str:
        mapped_repo_id = MODELSCOPE_REPO_MAP.get(repo_id)
        if not mapped_repo_id:
            raise RuntimeError(f"当前仓库 `{repo_id}` 没有配置 ModelScope 镜像映射。")

        from modelscope.hub.snapshot_download import snapshot_download as ms_snapshot_download

        return ms_snapshot_download(mapped_repo_id, cache_dir=self.settings.cache_dir or None)

    def try_huggingface_download(
        self,
        repo_id: str,
        target_dir: Path,
        *,
        endpoint: str = "",
        proxy_url: str = "",
    ) -> str:
        env = {
            "HF_ENDPOINT": endpoint,
            "HTTP_PROXY": proxy_url,
            "HTTPS_PROXY": proxy_url,
            "ALL_PROXY": proxy_url,
            "http_proxy": proxy_url,
            "https_proxy": proxy_url,
            "all_proxy": proxy_url,
        }
        with self.temporary_env(env):
            snapshot_download(
                repo_id=repo_id,
                local_dir=str(target_dir),
                local_dir_use_symlinks=False,
                cache_dir=self.settings.cache_dir or None,
            )
        return str(target_dir)

    def ensure_model_directory(self, model_source: str) -> str:
        source_path = Path(model_source)
        if source_path.is_dir():
            return str(source_path)

        target_dir = PROJECT_ROOT / "models" / model_source.replace("/", "__")
        if (target_dir / "config.json").is_file():
            return str(target_dir)
        if os.environ.get('VOXCPM_INSTALLED_RESOURCES_READONLY') == '1' or os.environ.get('VOXCPM_OFFLINE') == '1':
            raise RuntimeError(f'本地复用模式未找到模型：{model_source}。未创建新模型目录或发起下载，请检查已安装资源路径。')
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        errors: list[str] = []

        try:
            local_path = self.try_modelscope_download(model_source)
            return local_path
        except Exception as exc:
            errors.append(f"ModelScope 失败：{exc}")

        try:
            return self.try_huggingface_download(
                model_source,
                target_dir,
                endpoint=HF_MIRROR_ENDPOINT,
            )
        except Exception as exc:
            errors.append(f"Hugging Face 镜像失败：{exc}")

        try:
            return self.try_huggingface_download(
                model_source,
                target_dir,
                proxy_url=self.settings.proxy_url or DEFAULT_PROXY_URL,
            )
        except Exception as exc:
            errors.append(f"代理下载失败：{exc}")

        raise RuntimeError(
            "模型下载失败，已按顺序尝试：ModelScope、Hugging Face 镜像、代理下载。\n"
            + "\n".join(errors)
        )

    def lora_signature(self, lora_config: LoRAConfig) -> str:
        payload = lora_config.model_dump()
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)

    def get_or_load_voxcpm(self, selected_lora: str | None = None, load_denoiser: bool | None = None) -> VoxCPM:
        selected_lora = selected_lora or NO_LORA_LABEL
        model_source = self.resolve_model_source(selected_lora)
        resolved_model_dir = self.ensure_model_directory(model_source)
        verify_model_resources(0, resolved_model_dir)

        lora_config, _ = self.load_lora_config_from_checkpoint(selected_lora) if selected_lora != NO_LORA_LABEL else (None, None)
        lora_config = lora_config or self.default_lora_config()

        # 预热保留设置默认行为，实际生成仅在请求参考音频增强时加载。
        enable_denoiser = not self.settings.disable_denoiser and load_denoiser is not False
        zipenhancer_path = (self.settings.zipenhancer_path or DEFAULT_ZIPENHANCER) if enable_denoiser else None

        runtime_key = json.dumps(
            {
                "model_dir": resolved_model_dir,
                "zipenhancer": zipenhancer_path,
                "enable_denoiser": enable_denoiser,
                "disable_optimize": self.settings.disable_optimize,
                "lora": self.lora_signature(lora_config),
            },
            ensure_ascii=False,
            sort_keys=True,
        )

        if self.voxcpm_model is not None and self.loaded_model_key == runtime_key:
            return self.voxcpm_model

        optimize = not self.settings.disable_optimize

        if enable_denoiser:
            verify_model_resources(2, zipenhancer_path if Path(zipenhancer_path).is_dir() else None)
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.voxcpm_model = VoxCPM(
            voxcpm_model_path=resolved_model_dir,
            zipenhancer_model_path=zipenhancer_path if enable_denoiser else None,
            enable_denoiser=enable_denoiser,
            optimize=optimize,
            lora_config=lora_config,
        )
        self.loaded_model_key = runtime_key
        self.loaded_model_dir = resolved_model_dir
        self.loaded_lora = None
        return self.voxcpm_model

    def get_or_load_asr(self) -> AutoModel:
        verify_model_resources(1)
        if self.asr_model is not None:
            return self.asr_model
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        asr_model_source = str(LOCAL_ASR_DIR) if LOCAL_ASR_DIR.is_dir() else "iic/SenseVoiceSmall"
        self.asr_model = AutoModel(
            model=asr_model_source,
            disable_update=True,
            log_level="ERROR",
            device=device,
        )
        return self.asr_model

    def recognize_audio(self, audio_path: Optional[str]) -> str:
        if not audio_path:
            return ""
        model = self.get_or_load_asr()
        result = model.generate(input=audio_path, language="auto", use_itn=True)
        return result[0]["text"].split("|>")[-1].strip()

    def apply_lora_selection(self, model: VoxCPM, selected_lora: str | None) -> None:
        selected_lora = selected_lora or NO_LORA_LABEL
        if selected_lora == NO_LORA_LABEL:
            if self.loaded_lora:
                model.unload_lora()
                model.set_lora_enabled(False)
                self.loaded_lora = None
            return

        if self.loaded_lora == selected_lora:
            model.set_lora_enabled(True)
            return

        lora_path = LORA_ROOT / selected_lora
        if not lora_path.exists():
            raise FileNotFoundError(f"LoRA 检查点不存在：{lora_path}")
        model.load_lora(str(lora_path))
        model.set_lora_enabled(True)
        self.loaded_lora = selected_lora

    def output_file(self, category: str, stem: str, suffix: str) -> Path:
        safe_stem = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in stem).strip("_") or "output"
        category_dir = Path(self.settings.output_dir) / category / now_stamp()
        category_dir.mkdir(parents=True, exist_ok=True)
        return category_dir / f"{safe_stem}{suffix}"

    def prepare_prompt_text(self, mode: str, reference_audio: Optional[str], prompt_text: str) -> Optional[str]:
        clean_prompt = (prompt_text or "").strip()
        if mode != "极致克隆":
            return None
        if not reference_audio:
            raise ValueError("极致克隆模式需要先提供参考音频。")
        if clean_prompt:
            return clean_prompt
        return self.recognize_audio(reference_audio)

    def build_generation_kwargs(
        self,
        mode: str,
        text: str,
        control: str,
        reference_audio: Optional[str],
        prompt_text: Optional[str],
        cfg_value: float,
        normalize: bool,
        denoise: bool,
        inference_timesteps: int,
    ) -> dict:
        clean_text = (text or "").strip()
        if not clean_text:
            raise ValueError("目标文本不能为空。")

        if mode == "可控克隆" and not reference_audio:
            raise ValueError("可控克隆模式需要上传参考音频。")
        if mode == "极致克隆" and not reference_audio:
            raise ValueError("极致克隆模式需要上传参考音频。")

        use_denoiser = bool(denoise and reference_audio and mode in {"可控克隆", "极致克隆"})
        if use_denoiser and self.settings.disable_denoiser:
            raise ValueError("当前已在系统设置中禁用参考音频增强，请先启用增强模型，或关闭本次生成的参考音频增强。")

        final_text = clean_text
        if mode != "极致克隆":
            clean_control = (control or "").strip()
            if clean_control:
                final_text = f"({clean_control}){clean_text}"

        kwargs = {
            "text": final_text,
            "cfg_value": float(cfg_value),
            "inference_timesteps": int(inference_timesteps),
            "normalize": bool(normalize),
            "denoise": use_denoiser,
        }

        if mode == "可控克隆":
            kwargs["reference_wav_path"] = reference_audio
        elif mode == "极致克隆":
            kwargs["reference_wav_path"] = reference_audio
            kwargs["prompt_wav_path"] = reference_audio
            kwargs["prompt_text"] = prompt_text

        return kwargs

    def choose_save_destination(self, source_path: Path) -> str | None:
        try:
            import tkinter as tk
            from tkinter import filedialog
        except Exception as exc:
            raise RuntimeError("当前环境无法打开本机保存对话框。") from exc

        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        try:
            root.lift()
            root.update()
            suffix = source_path.suffix
            filetypes = [("所有文件", "*.*")]
            if suffix:
                suffix_label = suffix.lstrip(".").upper()
                filetypes.insert(0, (f"{suffix_label} 文件", f"*{suffix}"))
            selected_path = filedialog.asksaveasfilename(
                title="另存为生成结果",
                initialdir=str(source_path.parent),
                initialfile=source_path.name,
                defaultextension=suffix,
                filetypes=filetypes,
            )
            return selected_path or None
        finally:
            root.destroy()

    def save_generated_file_to(self, source_path: str, target_path: str) -> dict[str, Any]:
        clean_source = (source_path or "").strip()
        clean_target = (target_path or "").strip()
        if not clean_source:
            raise ValueError("当前还没有可导出的生成文件，请先执行一次音频生成。")
        if not clean_target:
            raise ValueError("目标保存路径不能为空。")

        source = Path(clean_source)
        if not source.is_file():
            raise FileNotFoundError(f"导出失败，源文件不存在：{source}")

        target = Path(clean_target)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.resolve() != source.resolve():
            shutil.copy2(source, target)
        return {
            "source_path": str(source),
            "target_path": str(target),
            "message": f"音频已保存到：`{target}`。",
        }

    def save_generated_file(self, source_path: str) -> str:
        clean_source = (source_path or "").strip()
        if not clean_source:
            return "当前还没有可导出的生成文件，请先执行一次音频生成。"

        source = Path(clean_source)
        if not source.is_file():
            return f"导出失败，源文件不存在：`{source}`。"

        try:
            selected_path = self.choose_save_destination(source)
            if not selected_path:
                return "已取消另存为操作。"
            payload = self.save_generated_file_to(str(source), selected_path)
            return payload["message"]
        except Exception as exc:
            traceback.print_exc()
            return f"另存为失败：{exc}"

    def generate_audio_payload(
        self,
        mode: str,
        text: str,
        control: str,
        reference_audio: Optional[str],
        prompt_text: str,
        selected_lora: str,
        cfg_value: float,
        normalize: bool,
        denoise: bool,
        inference_timesteps: int,
    ) -> dict[str, Any]:
        prepared_prompt = self.prepare_prompt_text(mode, reference_audio, prompt_text)
        kwargs = self.build_generation_kwargs(
            mode=mode,
            text=text,
            control=control,
            reference_audio=reference_audio,
            prompt_text=prepared_prompt,
            cfg_value=cfg_value,
            normalize=normalize,
            denoise=denoise,
            inference_timesteps=inference_timesteps,
        )

        model = self.get_or_load_voxcpm(selected_lora, load_denoiser=kwargs["denoise"])
        self.apply_lora_selection(model, selected_lora)

        wav = model.generate(**kwargs)
        output_path = self.output_file("single", "voxcpm_result", ".wav")
        sf.write(str(output_path), wav, model.tts_model.sample_rate)

        status = (
            f"生成完成，模式：`{mode}`，输出文件：`{output_path}`，"
            f"采样率：`{model.tts_model.sample_rate} Hz`。"
            " 如需保存到任意目录，请点击下方“另存为音频...”按钮。"
        )
        return {
            "audio_tuple": (model.tts_model.sample_rate, wav),
            "output_path": str(output_path),
            "sample_rate": int(model.tts_model.sample_rate),
            "status": status,
            "runtime": self.runtime_summary_payload(),
            "mode": mode,
        }

    def generate_audio(
        self,
        mode: str,
        text: str,
        control: str,
        reference_audio: Optional[str],
        prompt_text: str,
        selected_lora: str,
        cfg_value: float,
        normalize: bool,
        denoise: bool,
        inference_timesteps: int,
    ) -> tuple[tuple[int, np.ndarray] | None, str, object, str, str]:
        try:
            payload = self.generate_audio_payload(
                mode=mode,
                text=text,
                control=control,
                reference_audio=reference_audio,
                prompt_text=prompt_text,
                selected_lora=selected_lora,
                cfg_value=cfg_value,
                normalize=normalize,
                denoise=denoise,
                inference_timesteps=inference_timesteps,
            )
            return (
                payload["audio_tuple"],
                payload["output_path"],
                gr.update(interactive=True),
                payload["status"],
                self.runtime_markdown(),
            )
        except Exception as exc:
            traceback.print_exc()
            return (
                None,
                "",
                gr.update(interactive=False),
                f"生成失败：{exc}",
                self.runtime_markdown(),
            )

    def read_batch_items(self, batch_text: str, batch_file: Optional[str]) -> list[str]:
        lines: list[str] = []
        if batch_file:
            file_text = Path(batch_file).read_text(encoding="utf-8")
            lines.extend(file_text.splitlines())
        if batch_text:
            lines.extend(batch_text.splitlines())
        normalized = [line.strip() for line in lines if line.strip()]
        if not normalized:
            raise ValueError("请先在批量文本框中填写内容，或上传 UTF-8 编码文本文件。")
        return normalized

    def batch_generate(
        self,
        mode: str,
        batch_text: str,
        batch_file: Optional[str],
        control: str,
        reference_audio: Optional[str],
        prompt_text: str,
        selected_lora: str,
        cfg_value: float,
        normalize: bool,
        denoise: bool,
        inference_timesteps: int,
        output_prefix: str,
    ) -> tuple[str | None, str, str]:
        try:
            payload = self.batch_generate_payload(
                mode=mode,
                batch_text=batch_text,
                batch_file=batch_file,
                control=control,
                reference_audio=reference_audio,
                prompt_text=prompt_text,
                selected_lora=selected_lora,
                cfg_value=cfg_value,
                normalize=normalize,
                denoise=denoise,
                inference_timesteps=inference_timesteps,
                output_prefix=output_prefix,
            )
            return payload["archive_path"], payload["log"], payload["status"]
        except Exception as exc:
            traceback.print_exc()
            return None, "", f"批量生成失败：{exc}"

    def batch_generate_payload(
        self,
        mode: str,
        batch_text: str,
        batch_file: Optional[str],
        control: str,
        reference_audio: Optional[str],
        prompt_text: str,
        selected_lora: str,
        cfg_value: float,
        normalize: bool,
        denoise: bool,
        inference_timesteps: int,
        output_prefix: str,
    ) -> dict[str, Any]:
        items = self.read_batch_items(batch_text, batch_file)
        prepared_prompt = self.prepare_prompt_text(mode, reference_audio, prompt_text)
        # 提前校验增强请求，避免无关的旧增强模型路径阻塞普通生成。
        first_kwargs = self.build_generation_kwargs(
            mode=mode, text=items[0], control=control, reference_audio=reference_audio,
            prompt_text=prepared_prompt, cfg_value=cfg_value, normalize=normalize,
            denoise=denoise, inference_timesteps=inference_timesteps,
        )
        model = self.get_or_load_voxcpm(selected_lora, load_denoiser=first_kwargs["denoise"])
        self.apply_lora_selection(model, selected_lora)

        prefix = (output_prefix or "batch").strip() or "batch"
        batch_dir = Path(self.settings.output_dir) / "batch" / f"{now_stamp()}_{prefix}"
        batch_dir.mkdir(parents=True, exist_ok=True)

        manifest: list[dict[str, Any]] = []
        log_lines = [f"批量任务启动，共 {len(items)} 条。"]

        for index, item in enumerate(items, start=1):
            kwargs = self.build_generation_kwargs(
                mode=mode,
                text=item,
                control=control,
                reference_audio=reference_audio,
                prompt_text=prepared_prompt,
                cfg_value=cfg_value,
                normalize=normalize,
                denoise=denoise,
                inference_timesteps=inference_timesteps,
            )
            wav = model.generate(**kwargs)
            output_file = batch_dir / f"{index:03d}.wav"
            sf.write(str(output_file), wav, model.tts_model.sample_rate)
            manifest.append(
                {
                    "index": index,
                    "text": item,
                    "output_file": output_file.name,
                }
            )
            log_lines.append(f"[{index}/{len(items)}] 已生成 {output_file.name}")

        manifest_path = batch_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        archive_path = batch_dir.with_suffix(".zip")
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for file_path in sorted(batch_dir.rglob("*")):
                if file_path.is_file():
                    zf.write(file_path, arcname=file_path.relative_to(batch_dir.parent))

        status = f"批量生成完成，输出目录：`{batch_dir}`，归档文件：`{archive_path}`。"
        return {
            "archive_path": str(archive_path),
            "output_dir": str(batch_dir),
            "manifest_path": str(manifest_path),
            "log": "\n".join(log_lines),
            "status": status,
            "count": len(items),
            "runtime": self.runtime_summary_payload(),
        }

    def runtime_summary_payload(self) -> dict[str, Any]:
        lora_count = len(self.scan_lora_checkpoints())
        ffmpeg_path = shutil.which("ffmpeg") or ""
        repo_fallback = self.settings.hf_repo_id or DEFAULT_HF_MODEL_ID
        model_hint = self.loaded_model_dir or self.resolve_model_source()
        loaded_torch = sys.modules.get("torch")
        torch_version = getattr(loaded_torch, "__version__", "按需加载")
        torch_cuda_build = getattr(getattr(loaded_torch, "version", None), "cuda", None) or "none"
        cuda_available = bool(loaded_torch and loaded_torch.cuda.is_available())
        gpu_names = [
            torch.cuda.get_device_name(index)
            for index in range(torch.cuda.device_count())
        ] if cuda_available else []
        training_status = self.training_status_payload()
        return {
            "device": self.device,
            "torch_version": torch_version,
            "torch_cuda_build": torch_cuda_build,
            "cuda_available": cuda_available,
            "runtime_pending": loaded_torch is None,
            "gpu_names": gpu_names,
            "data_root": str(DATA_ROOT),
            "config_path": str(CONFIG_PATH),
            "lora_root": str(LORA_ROOT),
            "cache_dir": self.settings.cache_dir,
            "current_model_source": model_hint,
            "loaded_lora": self.loaded_lora or "",
            "lora_count": lora_count,
            "output_dir": self.settings.output_dir,
            "hf_repo_id": repo_fallback,
            "proxy_url": self.settings.proxy_url or DEFAULT_PROXY_URL,
            "download_strategy": f"ModelScope -> HF 镜像 -> 代理 {self.settings.proxy_url or DEFAULT_PROXY_URL}",
            "ffmpeg_path": ffmpeg_path,
            "training": training_status,
        }

    def runtime_markdown(self) -> str:
        runtime = self.runtime_summary_payload()
        if runtime["cuda_available"]:
            gpu_names = ", ".join(runtime["gpu_names"])
            cuda_status = f"可用，{len(runtime['gpu_names'])} 张 GPU：{gpu_names}"
        else:
            cuda_status = "不可用"
        return (
            "### 运行时状态\n"
            f"- 设备：`{runtime['device']}`\n"
            f"- Torch 版本：`{runtime['torch_version']}`\n"
            f"- Torch CUDA 构建：`{runtime['torch_cuda_build']}`\n"
            f"- CUDA 运行状态：`{cuda_status}`\n"
            f"- 数据目录：`{runtime['data_root']}`\n"
            f"- 配置文件：`{runtime['config_path']}`\n"
            f"- 当前模型来源：`{runtime['current_model_source']}`\n"
            f"- 已加载 LoRA：`{runtime['loaded_lora'] or '无'}`\n"
            f"- LoRA 检查点数量：`{runtime['lora_count']}`\n"
            f"- 输出目录：`{runtime['output_dir']}`\n"
            f"- LoRA 目录：`{runtime['lora_root']}`\n"
            f"- 缓存目录：`{runtime['cache_dir']}`\n"
            f"- 兜底 Hugging Face 仓库：`{runtime['hf_repo_id']}`\n"
            f"- 下载策略：`{runtime['download_strategy']}`\n"
            f"- FFmpeg：`{runtime['ffmpeg_path'] or '未检测到'}`\n"
            f"- 训练任务状态：`{'运行中' if runtime['training']['running'] else '空闲'}`\n"
        )

    def analysis_markdown(self) -> str:
        return (
            "### 当前项目分析\n"
            "- 核心库位于 `src/voxcpm`，已经提供推理、克隆、批量和 LoRA 相关能力。\n"
            "- 原有入口分散为 `app.py` 与 `lora_ft_webui.py` 两个页面，交互与视觉风格不统一。\n"
            "- 当前仓库采用 `src` 布局，源码直跑时需要显式把 `src` 放入 `sys.path`。\n"
            "- 原推理页面在启动阶段会尽早拉起 ASR 或模型资源，局部场景下会拖慢首屏启动。\n"
            "- 模型下载链路已改成优先走国内源，再回退到代理，减少跨境下载失败率。\n"
            "- Windows 便携打包链路已经补齐，可选 Python 桌面壳或 Flutter 原生 EXE 壳。\n"
            "- 当前控制台会显示 Torch/CUDA 状态，方便直接确认是否启用了显卡加速。\n"
            "- 这次改造目标是把推理、批量、LoRA 微调整合进一个本地控制台，并提供更清晰的部署路径。"
        )

    def dashboard_hero_html(self) -> str:
        lora_count = len(self.scan_lora_checkpoints())
        return (
            '<div class="hero-panel">'
            "<h2>运行概览</h2>"
            "<p>当前设备、LoRA 状态、输出目录和交互提示都集中在这里。</p>"
            '<div class="metric-grid">'
            f'<div class="metric-chip"><strong>{self.device.upper()}</strong><span>当前推理设备</span></div>'
            f'<div class="metric-chip"><strong>{lora_count}</strong><span>已发现 LoRA 检查点</span></div>'
            f'<div class="metric-chip"><strong>{Path(self.settings.output_dir).name}</strong><span>默认输出目录</span></div>'
            '<div class="metric-chip"><strong>Hover Tips</strong><span>关键控件均带悬停说明</span></div>'
            "</div>"
            "</div>"
        )

    def overview_summary_html(self) -> str:
        return (
            '<div class="status-card">'
            f"<p><strong>当前设备：</strong>{self.device.upper()}</p>"
            f"<p><strong>输出目录：</strong>{self.settings.output_dir}</p>"
            '<p class="muted">左侧切换功能区，右侧为深灰磨砂玻璃工作台。</p>'
            "</div>"
        )

    def overview_payload(self) -> tuple[str, str]:
        return self.overview_summary_html(), self.runtime_markdown()

    def warmup_model_payload(self) -> dict[str, Any]:
        model = self.get_or_load_voxcpm(NO_LORA_LABEL)
        message = (
            f"模型预热完成，当前模型目录：`{self.loaded_model_dir}`，"
            f"采样率：`{model.tts_model.sample_rate} Hz`。"
        )
        return {
            "message": message,
            "sample_rate": int(model.tts_model.sample_rate),
            "model_dir": self.loaded_model_dir,
            "runtime": self.runtime_summary_payload(),
        }

    def warmup_model(self) -> tuple[str, str]:
        try:
            payload = self.warmup_model_payload()
            return payload["message"], self.runtime_markdown()
        except Exception as exc:
            traceback.print_exc()
            return f"模型预热失败：{exc}", self.runtime_markdown()

    def refresh_lora_dropdown(self) -> object:
        return gr.update(choices=[NO_LORA_LABEL, *self.scan_lora_checkpoints()], value=NO_LORA_LABEL)

    def start_training(
        self,
        pretrained_path: str,
        train_manifest: str,
        val_manifest: str,
        learning_rate: float,
        num_iters: int,
        batch_size: int,
        lora_rank: int,
        lora_alpha: int,
        save_interval: int,
        output_name: str,
        grad_accum_steps: int,
        num_workers: int,
        log_interval: int,
        valid_interval: int,
        weight_decay: float,
        warmup_steps: int,
        max_steps: int,
        sample_rate: int,
        max_grad_norm: float,
        enable_lm: bool,
        enable_dit: bool,
        enable_proj: bool,
        dropout: float,
        tensorboard_path: str,
        hf_model_id: str,
        distribute: bool,
    ) -> tuple[str, str]:
        if self._training_is_running():
            return "训练任务已经在运行中。", self.training_log

        if not pretrained_path or not Path(pretrained_path).exists():
            return "预训练模型路径无效，请填写本地模型目录。", self.training_log
        if not train_manifest or not Path(train_manifest).exists():
            return "训练数据清单不存在，请检查路径。", self.training_log
        if val_manifest and not Path(val_manifest).exists():
            return "验证数据清单不存在，请检查路径。", self.training_log

        run_name = (output_name or "").strip() or now_stamp()
        save_dir = LORA_ROOT / run_name
        checkpoints_dir = save_dir / "checkpoints"
        logs_dir = save_dir / "logs"
        checkpoints_dir.mkdir(parents=True, exist_ok=True)
        logs_dir.mkdir(parents=True, exist_ok=True)

        detected_sample_rate = self.detect_sample_rate(pretrained_path)
        if detected_sample_rate is not None:
            sample_rate = detected_sample_rate

        config = {
            "pretrained_path": pretrained_path,
            "train_manifest": train_manifest,
            "val_manifest": val_manifest or "",
            "sample_rate": int(sample_rate),
            "batch_size": int(batch_size),
            "grad_accum_steps": int(grad_accum_steps),
            "num_workers": int(num_workers),
            "num_iters": int(num_iters),
            "log_interval": int(log_interval),
            "valid_interval": int(valid_interval),
            "save_interval": int(save_interval),
            "learning_rate": float(learning_rate),
            "weight_decay": float(weight_decay),
            "warmup_steps": int(warmup_steps),
            "max_steps": int(max_steps or num_iters),
            "max_grad_norm": float(max_grad_norm),
            "save_path": str(checkpoints_dir),
            "tensorboard": tensorboard_path or str(logs_dir),
            "lambdas": {"loss/diff": 1.0, "loss/stop": 1.0},
            "lora": {
                "enable_lm": bool(enable_lm),
                "enable_dit": bool(enable_dit),
                "enable_proj": bool(enable_proj),
                "r": int(lora_rank),
                "alpha": int(lora_alpha),
                "dropout": float(dropout),
                "target_modules_lm": ["q_proj", "v_proj", "k_proj", "o_proj"],
                "target_modules_dit": ["q_proj", "v_proj", "k_proj", "o_proj"],
            },
        }

        if hf_model_id.strip():
            config["hf_model_id"] = hf_model_id.strip()
        if distribute:
            config["distribute"] = True

        config_path = save_dir / "train_config.yaml"
        config_path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")

        command = [
            sys.executable,
            str(PROJECT_ROOT / "scripts" / "train_voxcpm_finetune.py"),
            "--config_path",
            str(config_path),
        ]

        self.training_process = None
        self.training_last_exit_code = None
        self.training_log_base_offset = 0
        self.training_output_dir = str(save_dir)
        self.training_config_path = str(config_path)
        self.training_command = command
        self.training_log = (
            "训练任务已启动。\n"
            f"输出目录：{save_dir}\n"
            f"配置文件：{config_path}\n"
            f"执行命令：{' '.join(command)}\n"
        )

        def _run() -> None:
            self.training_process = subprocess.Popen(
                command,
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert self.training_process.stdout is not None
            for line in self.training_process.stdout:
                self._append_training_log(line)
            self.training_process.wait()
            self.training_last_exit_code = self.training_process.returncode
            self._append_training_log(f"\n训练结束，退出码：{self.training_process.returncode}\n")

        threading.Thread(target=_run, daemon=True).start()
        return f"LoRA 训练已启动，输出目录：`{save_dir}`。", self.training_log

    def stop_training(self) -> tuple[str, str]:
        if self.training_process is None or self.training_process.poll() is not None:
            return "当前没有正在运行的训练任务。", self.training_log
        self.training_process.terminate()
        self._append_training_log("\n训练任务已被手动终止。\n")
        return "训练终止信号已发送。", self.training_log

    def get_training_log(self) -> str:
        return self.training_log or "暂无训练日志。"

    def training_status_payload(self) -> dict[str, Any]:
        running = self._training_is_running()
        process = self.training_process
        exit_code = self.training_last_exit_code
        if process is not None and process.poll() is not None:
            exit_code = process.returncode
        return {
            "running": running,
            "pid": process.pid if process is not None else None,
            "exit_code": exit_code,
            "output_dir": self.training_output_dir,
            "config_path": self.training_config_path,
            "command": self.training_command,
            "log_length": len(self.training_log),
            "log_base_offset": self.training_log_base_offset,
        }

    def training_log_payload(self, offset: int = 0) -> dict[str, Any]:
        safe_offset = max(0, int(offset))
        base_offset = self.training_log_base_offset
        if safe_offset < base_offset:
            safe_offset = base_offset
        local_start = min(len(self.training_log), safe_offset - base_offset)
        chunk = self.training_log[local_start:]
        next_offset = base_offset + len(self.training_log)
        return {
            "offset": safe_offset,
            "base_offset": base_offset,
            "next_offset": next_offset,
            "chunk": chunk,
            "full_log": self.training_log,
            "status": self.training_status_payload(),
        }


def mode_visibility_updates(mode: str) -> tuple[object, object, object, str]:
    show_reference = mode in {"可控克隆", "极致克隆"}
    show_control = mode in {"声音设计", "可控克隆"}
    show_prompt = mode == "极致克隆"

    descriptions = {
        "声音设计": "无需参考音频，适合用文字直接设计新的音色与表达风格。",
        "可控克隆": "需要参考音频，可叠加控制指令，在保留音色的同时调整语气和节奏。",
        "极致克隆": "需要参考音频和参考文本，会按“音频续写”思路最大化还原原声细节。",
    }

    return (
        gr.update(visible=show_reference),
        gr.update(visible=show_control),
        gr.update(visible=show_prompt),
        descriptions[mode],
    )


def build_interface(studio: VoxCPMStudio) -> gr.Blocks:
    gr.set_static_paths(paths=[ASSET_ROOT])

    def nav_updates(active_section: str) -> list[object]:
        button_updates = []
        panel_updates = []
        for key, _ in SECTION_ORDER:
            button_updates.append(gr.update(variant="primary" if key == active_section else "secondary"))
        for key, _ in SECTION_ORDER:
            panel_updates.append(gr.update(visible=key == active_section))
        return [*button_updates, *panel_updates]

    def toggle_project_description(is_visible: bool) -> tuple[bool, object, object]:
        next_visible = not is_visible
        return (
            next_visible,
            gr.update(visible=next_visible),
            gr.update(value="收起说明" if next_visible else "项目说明"),
        )

    with gr.Blocks(theme=app_theme(), css=CUSTOM_CSS, title="JVOX Studio配音系统") as app:
        with gr.Row(elem_classes=["studio-shell"]):
            with gr.Column(scale=1, min_width=236, elem_classes=["sidebar-panel", "sidebar-column"]):
                gr.HTML(
                    '<div class="logo-wrap">'
                    '<img src="/gradio_api/file=assets/voxcpm_logo.png" alt="VoxCPM logo">'
                    '<div class="logo-copy">'
                    "<h1>JVOX Studio配音系统</h1>"
                    "<p>统一管理推理、批量任务与 LoRA 微调</p>"
                    "</div>"
                    "</div>"
                )

                gr.HTML(theme_switcher_html())

                nav_buttons = []
                for index, (key, label) in enumerate(SECTION_ORDER):
                    nav_buttons.append(
                        gr.Button(
                            label,
                            variant="primary" if index == 0 else "secondary",
                            elem_classes=["nav-button"],
                        )
                    )

                gr.Markdown(
                    "悬停每个“说明”徽标即可查看使用提示。首次运行建议先到“系统设置”确认模型目录，再执行模型预热。",
                    elem_classes=["footer-tip"],
                )

            with gr.Column(scale=4, min_width=820):
                section_panels = []

                with gr.Group(visible=True, elem_classes=["feature-panel"]) as workspace_panel:
                    section_panels.append(workspace_panel)
                    gr.HTML(section_header_html("语音工作台", "统一承载声音设计、可控克隆和极致克隆。"))
                    workspace_mode_note = gr.Markdown("无需参考音频，适合用文字直接设计新的音色与表达风格。")
                    gr.HTML(tip_html("生成模式", "声音设计适合从零创建音色，可控克隆需要参考音频，极致克隆需要参考音频和对应文本。"))
                    workspace_mode = gr.Radio(GENERATION_MODES, value="声音设计", show_label=False)

                    with gr.Column(visible=False) as workspace_reference_wrap:
                        gr.HTML(tip_html("参考音频", "上传用于克隆的原始音频，建议使用清晰的人声短句，长度控制在 3 到 15 秒更稳妥。"))
                        workspace_reference_audio = gr.Audio(
                            sources=["upload", "microphone"],
                            type="filepath",
                            show_label=False,
                        )

                    with gr.Column(visible=True) as workspace_control_wrap:
                        gr.HTML(tip_html("控制指令", "这里可以描述性别、年龄、情绪、语速、风格等，例如“温柔、略带笑意的青年女声”。"))
                        workspace_control = gr.Textbox(
                            placeholder="例如：成熟男声，沉稳，播音腔，节奏略慢",
                            lines=2,
                            show_label=False,
                        )

                    with gr.Column(visible=False) as workspace_prompt_wrap:
                        gr.HTML(tip_html("参考文本", "极致克隆模式下需要提供参考音频对应的文字内容；如果留空，系统会尝试自动识别。"))
                        workspace_prompt_text = gr.Textbox(
                            placeholder="可手动填写参考音频的文本，留空则生成时自动识别",
                            lines=3,
                            show_label=False,
                        )
                        recognize_btn = gr.Button("识别参考音频文本", variant="secondary")

                    gr.HTML(tip_html("目标文本", "这里填写要最终合成出来的内容。方言生成时，请直接填写方言文本而不是普通话原文。"))
                    workspace_text = gr.Textbox(
                        value="欢迎来到 JVOX Studio配音系统，本地控制台已经准备就绪。",
                        lines=4,
                        show_label=False,
                    )

                    with gr.Row(elem_classes=["compact-row"]):
                        with gr.Column():
                            gr.HTML(tip_html("LoRA 检查点", "如果你已经训练过 LoRA，可以在这里加载。未选择时使用基础模型。"))
                            workspace_lora = gr.Dropdown(
                                choices=[NO_LORA_LABEL, *studio.scan_lora_checkpoints()],
                                value=NO_LORA_LABEL,
                                show_label=False,
                            )
                        with gr.Column(scale=0):
                            refresh_workspace_lora = gr.Button("刷新 LoRA", variant="secondary")

                    with gr.Accordion("高级参数", open=False, elem_classes=["glass-accordion"]):
                        gr.HTML(tip_html("CFG 引导强度", "数值越高，生成更贴近控制指令或参考音频；越低则更自由。"))
                        workspace_cfg = gr.Slider(1.0, 3.0, value=2.0, step=0.1, show_label=False)
                        gr.HTML(tip_html("推理步数", "步数越高通常质量更稳，但速度会下降。一般 8 到 20 是比较均衡的区间。"))
                        workspace_steps = gr.Slider(1, 50, value=10, step=1, show_label=False)
                        gr.HTML(tip_html("文本规范化", "会自动处理数字、日期和缩写；处理新闻稿、数字类内容时很有帮助。"))
                        workspace_normalize = gr.Checkbox(label="启用文本规范化", value=False)
                        gr.HTML(tip_html("参考音频增强", "只有在参考音频质量一般时再开启，系统会在克隆前做降噪增强。"))
                        workspace_denoise = gr.Checkbox(label="启用参考音频增强", value=False)

                    with gr.Row(elem_classes=["compact-row"]):
                        workspace_generate_btn = gr.Button("开始生成", variant="primary")
                        workspace_reset_status = gr.Button("刷新运行状态", variant="secondary")

                    workspace_status = gr.Markdown("等待生成。")
                    workspace_audio = gr.Audio(label="生成结果预听")
                    workspace_output_path = gr.Textbox(label="输出文件路径", interactive=False)
                    workspace_save_btn = gr.Button("另存为音频...", variant="secondary", interactive=False)

                with gr.Group(visible=False, elem_classes=["feature-panel"]) as overview_panel:
                    section_panels.append(overview_panel)
                    gr.HTML(section_header_html("项目概览", "运行状态与项目说明单独在这里查看。"))
                    gr.HTML(studio.dashboard_hero_html())
                    overview_summary = gr.HTML(studio.overview_summary_html())
                    overview_runtime = gr.Markdown(studio.runtime_markdown())
                    with gr.Row(elem_classes=["compact-row"]):
                        refresh_runtime_btn = gr.Button("刷新运行状态", variant="secondary")
                        warmup_btn = gr.Button("模型预热", variant="secondary")
                        toggle_analysis_btn = gr.Button("项目说明", variant="secondary")
                    overview_status = gr.Markdown("准备就绪，可以开始本地化控制台操作。")
                    overview_analysis_state = gr.State(False)
                    overview_analysis = gr.Markdown(
                        studio.analysis_markdown(),
                        visible=False,
                    )

                with gr.Group(visible=False, elem_classes=["feature-panel"]) as batch_panel:
                    section_panels.append(batch_panel)
                    gr.HTML(section_header_html("批量生成", "适合一次性处理多条文本，自动导出目录和压缩包。"))
                    batch_mode_note = gr.Markdown("无需参考音频，适合批量做声音设计。")
                    gr.HTML(tip_html("批量模式", "和语音工作台类似，这里也支持声音设计、可控克隆和极致克隆三种模式。"))
                    batch_mode = gr.Radio(GENERATION_MODES, value="声音设计", show_label=False)

                    with gr.Column(visible=False) as batch_reference_wrap:
                        gr.HTML(tip_html("批量参考音频", "当你需要批量做克隆时，所有文本都会使用同一段参考音频。"))
                        batch_reference_audio = gr.Audio(
                            sources=["upload", "microphone"],
                            type="filepath",
                            show_label=False,
                        )

                    with gr.Column(visible=True) as batch_control_wrap:
                        gr.HTML(tip_html("批量控制指令", "会作用到本次任务中的每一条文本。适合统一人设、统一主播风格。"))
                        batch_control = gr.Textbox(
                            placeholder="例如：冷静、专业、适合知识解说的中性声线",
                            lines=2,
                            show_label=False,
                        )

                    with gr.Column(visible=False) as batch_prompt_wrap:
                        gr.HTML(tip_html("批量参考文本", "极致克隆模式下会给整批任务共用同一份参考文本。"))
                        batch_prompt_text = gr.Textbox(
                            placeholder="如果留空，系统会在生成前自动识别参考音频文本",
                            lines=3,
                            show_label=False,
                        )

                    gr.HTML(tip_html("批量文本", "一行一条文本，也可以上传 UTF-8 编码的 txt 文件。两者会合并处理。"))
                    batch_text = gr.Textbox(
                        lines=8,
                        placeholder="第一行文本\n第二行文本\n第三行文本",
                        show_label=False,
                    )
                    batch_file = gr.File(label="可选：上传 UTF-8 文本文件", type="filepath")

                    with gr.Row(elem_classes=["compact-row"]):
                        with gr.Column():
                            gr.HTML(tip_html("批量 LoRA", "需要让整批文本复用某个 LoRA 时，在这里指定。"))
                            batch_lora = gr.Dropdown(
                                choices=[NO_LORA_LABEL, *studio.scan_lora_checkpoints()],
                                value=NO_LORA_LABEL,
                                show_label=False,
                            )
                        with gr.Column(scale=0):
                            refresh_batch_lora = gr.Button("刷新 LoRA", variant="secondary")

                    gr.HTML(tip_html("输出前缀", "用于区分这次任务的输出目录名，方便后续回看。"))
                    batch_prefix = gr.Textbox(value="marketing_batch", show_label=False)

                    with gr.Accordion("批量高级参数", open=False, elem_classes=["glass-accordion"]):
                        batch_cfg = gr.Slider(1.0, 3.0, value=2.0, step=0.1, label="CFG 引导强度")
                        batch_steps = gr.Slider(1, 50, value=10, step=1, label="推理步数")
                        batch_normalize = gr.Checkbox(label="启用文本规范化", value=False)
                        batch_denoise = gr.Checkbox(label="启用参考音频增强", value=False)

                    batch_run_btn = gr.Button("执行批量生成", variant="primary")
                    batch_status = gr.Markdown("等待批量任务。")
                    batch_log = gr.Textbox(label="批量任务日志", lines=10)
                    batch_archive = gr.File(label="批量导出压缩包")

                with gr.Group(visible=False, elem_classes=["feature-panel"]) as training_panel:
                    section_panels.append(training_panel)
                    gr.HTML(section_header_html("LoRA 微调", "直接在控制台里发起训练、查看日志并刷新已产出的 LoRA。"))
                    gr.Markdown(
                        "这里复用了项目自带的 LoRA 训练脚本，但界面改成了更统一的控制台风格。建议先确认基础模型路径和数据清单路径都正确。"
                    )

                    gr.HTML(tip_html("预训练模型路径", "填写已经下载好的 VoxCPM 模型目录；训练前建议使用本地磁盘路径，避免训练阶段再触发远程下载。"))
                    train_pretrained_path = gr.Textbox(
                        value=studio.settings.model_dir,
                        placeholder="/path/to/VoxCPM2",
                        show_label=False,
                    )
                    gr.HTML(tip_html("训练数据清单", "填写 jsonl 清单文件路径。每一条记录的格式请参考仓库 `examples/train_data_example.jsonl`。"))
                    train_manifest = gr.Textbox(
                        placeholder=str(PROJECT_ROOT / "examples" / "train_data_example.jsonl"),
                        show_label=False,
                    )
                    gr.HTML(tip_html("验证数据清单", "可选。若不填，则只跑训练不单独做验证。"))
                    val_manifest = gr.Textbox(placeholder="可选：/path/to/val.jsonl", show_label=False)

                    with gr.Row(elem_classes=["compact-row"]):
                        lr = gr.Number(value=1e-4, label="学习率")
                        num_iters = gr.Number(value=2000, label="最大迭代次数", precision=0)
                        batch_size = gr.Number(value=4, label="批次大小", precision=0)

                    with gr.Row(elem_classes=["compact-row"]):
                        lora_rank = gr.Number(value=32, label="LoRA Rank", precision=0)
                        lora_alpha = gr.Number(value=16, label="LoRA Alpha", precision=0)
                        save_interval = gr.Number(value=500, label="保存间隔", precision=0)

                    gr.HTML(tip_html("输出名称", "如果你想继续已有训练目录，可以填写同名目录；留空则自动使用时间戳。"))
                    output_name = gr.Textbox(placeholder="例如：news_anchor_lora", show_label=False)

                    with gr.Accordion("训练高级参数", open=False, elem_classes=["glass-accordion"]):
                        with gr.Row(elem_classes=["compact-row"]):
                            grad_accum_steps = gr.Number(value=1, label="梯度累计步数", precision=0)
                            num_workers = gr.Number(value=2, label="DataLoader 线程数", precision=0)
                            log_interval = gr.Number(value=10, label="日志间隔", precision=0)
                        with gr.Row(elem_classes=["compact-row"]):
                            valid_interval = gr.Number(value=1000, label="验证间隔", precision=0)
                            weight_decay = gr.Number(value=0.01, label="权重衰减")
                            warmup_steps = gr.Number(value=100, label="Warmup Steps", precision=0)
                        with gr.Row(elem_classes=["compact-row"]):
                            max_steps = gr.Number(value=2000, label="Max Steps", precision=0)
                            sample_rate = gr.Number(value=44100, label="采样率", precision=0)
                            max_grad_norm = gr.Number(value=1.0, label="梯度裁剪")
                        tensorboard_path = gr.Textbox(placeholder="可选：TensorBoard 日志目录")
                        hf_model_id = gr.Textbox(placeholder="可选：Hugging Face 模型 ID，例如 openbmb/VoxCPM2")
                        with gr.Row(elem_classes=["compact-row"]):
                            enable_lm = gr.Checkbox(label="启用 LM LoRA", value=True)
                            enable_dit = gr.Checkbox(label="启用 DIT LoRA", value=True)
                            enable_proj = gr.Checkbox(label="启用投影层 LoRA", value=False)
                            distribute = gr.Checkbox(label="分布式模式", value=False)
                        dropout = gr.Slider(0.0, 0.5, value=0.0, step=0.01, label="LoRA Dropout")

                    with gr.Row(elem_classes=["compact-row"]):
                        start_train_btn = gr.Button("开始训练", variant="primary")
                        stop_train_btn = gr.Button("停止训练", variant="secondary")
                        refresh_train_log_btn = gr.Button("刷新日志", variant="secondary")
                        refresh_training_lora = gr.Button("刷新 LoRA 列表", variant="secondary")

                    training_status = gr.Markdown("等待训练任务。")
                    training_log = gr.Textbox(label="训练日志", lines=14, value="暂无训练日志。")

                with gr.Group(visible=False, elem_classes=["feature-panel"]) as system_panel:
                    section_panels.append(system_panel)
                    gr.HTML(section_header_html("系统设置", "管理模型来源、缓存路径、输出目录和运行策略。"))
                    gr.Markdown(
                        "这一区域主要解决本地部署和源码直跑体验。保存设置后，运行时会自动重置，下次调用会按新的参数重新加载。"
                    )

                    gr.HTML(tip_html("本地模型目录", "如果你已经手动下载了模型，优先填写这里。为空时，系统会回退到 Hugging Face 仓库 ID。"))
                    model_dir_input = gr.Textbox(value=studio.settings.model_dir, show_label=False)
                    gr.HTML(tip_html("Hugging Face 仓库 ID", "当本地模型目录为空时，将按这里的仓库 ID 自动下载到 `models/` 目录。"))
                    hf_repo_id_input = gr.Textbox(value=studio.settings.hf_repo_id, show_label=False)
                    gr.HTML(tip_html("缓存目录", "可选。用于指定 Hugging Face 下载缓存位置，不填时使用默认缓存。"))
                    cache_dir_input = gr.Textbox(value=studio.settings.cache_dir, show_label=False)
                    gr.HTML(tip_html("ZipEnhancer 路径", "可填本地路径，也可以直接填模型 ID。为空时默认使用项目推荐的降噪模型。"))
                    zipenhancer_input = gr.Textbox(value=studio.settings.zipenhancer_path, show_label=False)
                    gr.HTML(tip_html("输出目录", "生成音频、批量压缩包和训练日志都会默认写到这里。"))
                    output_dir_input = gr.Textbox(value=studio.settings.output_dir, show_label=False)
                    gr.HTML(tip_html("代理地址", "当国内镜像仍不可用时，会自动用这里的代理地址继续下载。默认值是 http://127.0.0.1:7890，你也可以改成自己的本地 IP:7890。"))
                    proxy_url_input = gr.Textbox(value=studio.settings.proxy_url, show_label=False)

                    with gr.Row(elem_classes=["compact-row"]):
                        disable_denoiser_input = gr.Checkbox(
                            label="禁用启动时降噪器支持",
                            value=studio.settings.disable_denoiser,
                        )
                        disable_optimize_input = gr.Checkbox(
                            label="禁用模型优化预热",
                            value=studio.settings.disable_optimize,
                        )

                    with gr.Row(elem_classes=["compact-row"]):
                        save_system_btn = gr.Button("保存设置", variant="primary")
                        system_warmup_btn = gr.Button("立即预热模型", variant="secondary")
                        system_refresh_btn = gr.Button("刷新运行状态", variant="secondary")

                    system_status = gr.Markdown("系统设置尚未修改。")
                    system_runtime = gr.Markdown(studio.runtime_markdown())

        all_outputs = [*nav_buttons, *section_panels]
        for (key, _), button in zip(SECTION_ORDER, nav_buttons):
            button.click(lambda active=key: nav_updates(active), outputs=all_outputs)

        refresh_runtime_btn.click(studio.overview_payload, outputs=[overview_summary, overview_runtime])
        workspace_reset_status.click(studio.overview_payload, outputs=[overview_summary, overview_runtime])
        system_refresh_btn.click(
            lambda: (studio.runtime_markdown(), *studio.overview_payload()),
            outputs=[system_runtime, overview_summary, overview_runtime],
        )

        warmup_btn.click(studio.warmup_model, outputs=[overview_status, overview_runtime])
        system_warmup_btn.click(studio.warmup_model, outputs=[system_status, system_runtime])
        toggle_analysis_btn.click(
            toggle_project_description,
            inputs=[overview_analysis_state],
            outputs=[overview_analysis_state, overview_analysis, toggle_analysis_btn],
        )

        workspace_mode.change(
            mode_visibility_updates,
            inputs=[workspace_mode],
            outputs=[workspace_reference_wrap, workspace_control_wrap, workspace_prompt_wrap, workspace_mode_note],
        )
        batch_mode.change(
            mode_visibility_updates,
            inputs=[batch_mode],
            outputs=[batch_reference_wrap, batch_control_wrap, batch_prompt_wrap, batch_mode_note],
        )

        recognize_btn.click(
            lambda audio_path: studio.recognize_audio(audio_path) if audio_path else "",
            inputs=[workspace_reference_audio],
            outputs=[workspace_prompt_text],
        )

        refresh_workspace_lora.click(studio.refresh_lora_dropdown, outputs=[workspace_lora])
        refresh_batch_lora.click(studio.refresh_lora_dropdown, outputs=[batch_lora])
        refresh_training_lora.click(
            lambda: (
                studio.refresh_lora_dropdown(),
                studio.refresh_lora_dropdown(),
                studio.runtime_markdown(),
            ),
            outputs=[workspace_lora, batch_lora, overview_runtime],
        )

        workspace_generate_btn.click(
            studio.generate_audio,
            inputs=[
                workspace_mode,
                workspace_text,
                workspace_control,
                workspace_reference_audio,
                workspace_prompt_text,
                workspace_lora,
                workspace_cfg,
                workspace_normalize,
                workspace_denoise,
                workspace_steps,
            ],
            outputs=[workspace_audio, workspace_output_path, workspace_save_btn, workspace_status, overview_runtime],
            show_progress=True,
        )
        workspace_save_btn.click(
            studio.save_generated_file,
            inputs=[workspace_output_path],
            outputs=[workspace_status],
        )

        batch_run_btn.click(
            studio.batch_generate,
            inputs=[
                batch_mode,
                batch_text,
                batch_file,
                batch_control,
                batch_reference_audio,
                batch_prompt_text,
                batch_lora,
                batch_cfg,
                batch_normalize,
                batch_denoise,
                batch_steps,
                batch_prefix,
            ],
            outputs=[batch_archive, batch_log, batch_status],
            show_progress=True,
        )

        start_train_btn.click(
            studio.start_training,
            inputs=[
                train_pretrained_path,
                train_manifest,
                val_manifest,
                lr,
                num_iters,
                batch_size,
                lora_rank,
                lora_alpha,
                save_interval,
                output_name,
                grad_accum_steps,
                num_workers,
                log_interval,
                valid_interval,
                weight_decay,
                warmup_steps,
                max_steps,
                sample_rate,
                max_grad_norm,
                enable_lm,
                enable_dit,
                enable_proj,
                dropout,
                tensorboard_path,
                hf_model_id,
                distribute,
            ],
            outputs=[training_status, training_log],
            show_progress=True,
        )
        stop_train_btn.click(studio.stop_training, outputs=[training_status, training_log])
        refresh_train_log_btn.click(studio.get_training_log, outputs=[training_log])

        save_system_btn.click(
            studio.persist_settings,
            inputs=[
                model_dir_input,
                hf_repo_id_input,
                cache_dir_input,
                zipenhancer_input,
                output_dir_input,
                proxy_url_input,
                disable_denoiser_input,
                disable_optimize_input,
            ],
            outputs=[system_status, system_runtime],
            show_progress=True,
        )
        save_system_btn.click(studio.overview_payload, outputs=[overview_summary, overview_runtime])

    return app


def run_studio(
    server_name: str = "0.0.0.0",
    server_port: int = 8808,
    model_dir: Optional[str] = None,
) -> None:
    studio = VoxCPMStudio(model_dir=model_dir)
    demo = build_interface(studio)
    demo.queue(max_size=12, default_concurrency_limit=1).launch(
        server_name=server_name,
        server_port=server_port,
        show_error=True,
    )
