"""验证实际交流信号，避免量化噪声、直流或无效数值被当作生成成功。"""
from __future__ import annotations

import numpy as np


def validate_audio(waveform) -> dict:
    audio = np.asarray(waveform, dtype=np.float64)
    if audio.ndim not in (1, 2) or not audio.size or audio.shape[0] == 0:
        raise ValueError('模型未生成有效音频。')
    if not np.isfinite(audio).all():
        raise ValueError('模型输出包含无效数值，未保存为作品，请重新生成。')
    centered = audio - audio.mean(axis=0)
    rms = float(np.sqrt(np.mean(audio * audio)))
    ac_rms = float(np.sqrt(np.mean(centered * centered)))
    ac_peak = float(np.max(np.abs(centered)))
    if ac_rms < 1e-7 or (ac_peak < 1e-3 and ac_rms < 1e-4):
        raise ValueError('模型输出近乎静音，未保存为作品。请重新生成，或更换随机种子后重试。')
    return {'rms': rms, 'acRms': ac_rms, 'peak': float(np.max(np.abs(audio))),
            'acPeak': ac_peak, 'acDbfs': float(20 * np.log10(ac_rms))}
