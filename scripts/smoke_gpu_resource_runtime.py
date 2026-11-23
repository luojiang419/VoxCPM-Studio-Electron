"""只读复用安装资源，实际执行 GPU 自检和当前源码配音，不下载或复制模型。"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types

ROOT = Path(__file__).resolve().parents[1]
if os.environ.get('VOXCPM_INSTALLED_RESOURCES_READONLY') != '1':
    raise RuntimeError('请通过 validate_local.ps1 -Script scripts/smoke_gpu_resource_runtime.py 运行')
output = ROOT / 'builds/gpu-resource-validation'
output.mkdir(parents=True, exist_ok=True)
source = (ROOT / 'frontend/voxcpm_studio_electron/runtime-service.js').read_text(encoding='utf8')
probe = re.search(r'const PROBE = String.raw`(.*?)`;', source, re.S)[1]
result = subprocess.run([sys.executable, '-c', probe, 'existing-gpu'], capture_output=True, text=True,
                        encoding='utf8', timeout=180, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
if result.returncode:
    raise RuntimeError(result.stdout + result.stderr)

# 与发布器一致：先使用 backend 覆盖文件，其他源文件读取基础项目。
package = types.ModuleType('voxcpm')
package.__path__ = [str(ROOT / 'backend/voxcpm'), str(ROOT.parent / 'src/voxcpm')]
sys.modules['voxcpm'] = package
model_package = types.ModuleType('voxcpm.model')
model_package.__path__ = [str(ROOT / 'backend/voxcpm/model'), str(ROOT.parent / 'src/voxcpm/model')]
sys.modules['voxcpm.model'] = model_package
os.environ['VOXCPM_LAZY_STARTUP'] = '1'
os.environ['VOXCPM_RUNTIME_CONFIG'] = str(ROOT / 'frontend/voxcpm_studio_electron/runtime-config.json')
os.environ['VOXCPM_DATA_ROOT'] = str(output)
from voxcpm.studio_resources import ensure_model_resources
from voxcpm.model.utils import get_dtype
from voxcpm.core import VoxCPM
import numpy as np
import soundfile as sf
import torch

model_dir = os.environ['VOXCPM_MODEL_DIR']
ensure_model_resources(0, model_dir)
pipeline = VoxCPM(voxcpm_model_path=model_dir, enable_denoiser=False, optimize=False)
audio = pipeline.generate(text='运行环境检查完成，欢迎使用。', inference_timesteps=4, max_len=256)
assert np.isfinite(audio).all() and audio.size > 1000 and np.max(np.abs(audio)) > 0
rate = pipeline.tts_model.sample_rate
sf.write(output / 'runtime-check.wav', audio, rate)
report = {'passed': True, 'gpu': torch.cuda.get_device_name(), 'capability': torch.cuda.get_device_capability(),
          'torch': torch.__version__, 'cuda': torch.version.cuda, 'architectures': torch.cuda.get_arch_list(),
          'dtype': str(get_dtype('bfloat16')), 'audioSeconds': round(audio.size / rate, 3), 'sampleRate': rate,
          'probe': result.stdout.splitlines()[-1], 'otherGenerations': '未进行实体显卡测试'}
music_python = Path(os.environ['VOXCPM_MUSIC_ENGINE_ROOT']) / 'python/python.exe'
if music_python.is_file():
    music = subprocess.run([str(music_python), '-c', 'import json,torch; print(json.dumps(dict(torch=torch.__version__,cuda=torch.version.cuda,architectures=torch.cuda.get_arch_list())))'],
                           capture_output=True, text=True, timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if music.returncode:
        raise RuntimeError(music.stderr)
    report['musicRuntime'] = json.loads(music.stdout.splitlines()[-1])
(output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(report, ensure_ascii=False))
