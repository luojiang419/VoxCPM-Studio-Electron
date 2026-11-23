"""防止非零量化噪声、DC和NaN导致假成功，允许正常瞬态音效及安静环境声。"""
import numpy as np
import pytest
from voxcpm.moss_audio import validate_audio


@pytest.mark.parametrize('audio', [np.zeros(4800), np.full(4800, .25),
    np.tile(np.arange(-3, 5) / 32768, 600), np.array([0., float('nan')]),
    np.array([0., float('inf')]), np.array([])])
def test_rejects_silence_dc_quantization_noise_and_invalid_values(audio):
    with pytest.raises(ValueError):
        validate_audio(audio)


def test_short_gunshot_with_long_silence_is_audible():
    audio = np.zeros(480000)
    audio[96000:96096] = np.sin(np.arange(96) * .4) * .6
    assert validate_audio(audio)['peak'] > .5


def test_quiet_ambience_and_opposite_stereo_channels_remain_valid():
    mono = np.sin(np.arange(4800) * .05) * .002
    result = validate_audio(np.column_stack([mono, -mono]))
    assert result['acRms'] > .001
