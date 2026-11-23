"""复用安装包的真实 ABC 解析/重写接口，验收转谱保留关系，无需加载 GPU。"""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend/voxcpm'), os.environ['VOXCPM_MUSIC_ENGINE_ROOT']]
from music_instrumental import transfer_score, generate_instrumental
from yue2_comfy import notation

source = '''X:1
T:
M:4/4
L:1/16
Q:1/4=72
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:Dm
V: Vocal
"Dm"z4^C4-C8|"A7"=C4D4E4z4|
V: Ins
A,16|A,4B,4C4D4|
'''
converted, report = transfer_score(source, notation)
before, after = notation.read(source), notation.read(converted)
assert not after['notes']['Vocal']
assert all(note in after['notes']['Ins'] for note in before['notes']['Vocal'])
assert before['chords'] == after['chords'] and before['bars'] == after['bars']
assert after['notes']['Ins'][-1] == before['notes']['Ins'][-1]
folder = ROOT / 'builds/music-instrumental-score'
folder.mkdir(parents=True, exist_ok=True)
(folder / 'source.abc').write_text(source, encoding='utf8')
(folder / 'instrumental.abc').write_text(converted, encoding='utf8')
print('PASS 真实 YuE2 曲谱接口：连音、变音、和弦、速度、拍号、填充和旋律转移', report['instrumentalNotes'])

# 复用真实 Render Plan 的分支选择，仅替代 GPU 数值阶段，核对旧 token 绝不进入生成。
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch
from yue2_comfy import staged, generate
from yue2_comfy.constants import DEFAULT_OPTIONS

def sing(models, style, lyrics, seed, settings, **kwargs):
    assert kwargs['abc_ids'] is None, '不能复用原谱 token'
    assert kwargs['abc'].strip() == converted.strip(), '实际生成必须使用转谱'
    assert lyrics == '' and style == 'Instrumental piano'
    return SimpleNamespace(cpu=lambda: None), {'seconds_of_audio': 10}, None

with patch.object(staged.YuE2Plan, 'plan', return_value={'result': ({'score': source, 'ids': [123, 456],
        'style': 'Instrumental piano', 'lyrics': '', 'seed': 1247, 'settings': DEFAULT_OPTIONS}, source)}), \
     patch.object(staged, 'session', side_effect=lambda *a: nullcontext(None)), \
     patch.object(generate, 'sing', side_effect=sing), \
     patch.object(generate, 'decode', return_value=(None, {})), \
     patch.object(staged.songs, 'keep'):
    generate_instrumental({'inputs': {'style': 'Instrumental piano'}, 'seed': 1247}, folder / 'contract.wav', DEFAULT_OPTIONS)
print('PASS 真实 Render Plan 固定曲谱及重新编码契约（GPU 数值阶段使用夹具）')
