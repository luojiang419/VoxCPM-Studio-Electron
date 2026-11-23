"""YuE2 原谱转器乐：按音符时间转移旋律，保留和弦及不重叠的器乐填充。"""
from copy import deepcopy
import json


def transfer_score(source, notation):
    sheet = notation.read(source)
    vocal = sheet['notes']['Vocal']
    instrument = sheet['notes']['Ins']
    if not vocal and not instrument:
        raise ValueError('YuE2 规划的曲谱没有有效旋律音符，请重试')
    merged, trimmed = deepcopy(vocal), []
    for note in instrument:
        spans = [(note['start'], note['start'] + note['length'])]
        for lead in vocal:
            low, high = lead['start'], lead['start'] + lead['length']
            spans = [(a, b) for left, right in spans
                     for a, b in ((left, min(right, low)), (max(left, high), right)) if a < b]
        merged.extend({**note, 'start': left, 'length': right - left} for left, right in spans)
        if spans != [(note['start'], note['start'] + note['length'])]:
            trimmed.append({'original': note, 'retainedSpans': spans})
    target = deepcopy(sheet)
    target['notes'] = {'Vocal': [], 'Ins': sorted(merged, key=lambda n: (n['start'], n['pitch']))}
    converted = notation.write(source, target)['abc']
    checked = notation.read(converted)
    key = lambda n: (n['start'], n['length'], n['pitch'])
    if checked['notes']['Vocal'] or sorted(map(key, checked['notes']['Ins'])) != sorted(map(key, merged)):
        raise ValueError('YuE2 器乐转谱音符复核失败，已停止生成')
    if any(checked[name] != sheet[name] for name in ('bpm', 'bars', 'chords', 'total')):
        raise ValueError('YuE2 器乐转谱改变了速度、拍号、调式或和弦，已停止生成')
    return converted, {'sourceVocalNotes': len(vocal), 'sourceInsNotes': len(instrument),
        'instrumentalNotes': len(merged), 'trimmedInsNotes': trimmed, 'validated': True}


def generate_instrumental(packet, output, options):
    from yue2_comfy import notation
    from yue2_comfy.staged import YuE2Plan, YuE2RenderPlan
    style = packet['inputs']['style']
    print('YuE2：正在规划纯音乐原谱', flush=True)
    plan, source = YuE2Plan().plan(style=style, lyrics='', seed=packet['seed'], options=options)['result']
    output.with_suffix('.source.abc').write_text(source, encoding='utf8')
    converted, report = transfer_score(source, notation)
    output.with_suffix('.instrumental.abc').write_text(converted, encoding='utf8')
    output.with_suffix('.transfer.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    # 丢弃旧规划 token，始终从转换后的固定曲谱重新编码，包含原谱本来就无人声的情形。
    fixed_plan = {**plan, 'score': '', 'ids': []}
    print('YuE2：转谱验证通过，正在从固定器乐谱生成音频', flush=True)
    audio, rendered = YuE2RenderPlan().render(fixed_plan, score_abc=converted, options=options)
    if rendered['score'].strip() != converted.strip():
        raise ValueError('YuE2 未使用转换后的器乐曲谱，已停止生成')
    return audio, converted, report
