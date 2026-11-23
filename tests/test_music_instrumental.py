import pytest

from voxcpm.music_instrumental import transfer_score


def test_transfer_preserves_lead_and_trims_only_overlapping_instrument_notes():
    from copy import deepcopy
    source = {'notes': {'Vocal': [{'start': 4, 'length': 4, 'pitch': 60}],
                        'Ins': [{'start': 0, 'length': 12, 'pitch': 55}, {'start': 12, 'length': 4, 'pitch': 67}]},
              'bpm': 72, 'bars': [{'start': 0, 'length': 16, 'key': 'Dm', 'meter': '4/4'}],
              'chords': [{'start': 0, 'name': 'Dm'}], 'total': 16}
    class Notation:
        read = staticmethod(deepcopy)
        write = staticmethod(lambda text, sheet: {'abc': deepcopy(sheet)})
    result, report = transfer_score(source, Notation)
    assert result['notes']['Vocal'] == []
    assert result['notes']['Ins'] == [{'start': 0, 'length': 4, 'pitch': 55}, {'start': 4, 'length': 4, 'pitch': 60},
                                    {'start': 8, 'length': 4, 'pitch': 55}, {'start': 12, 'length': 4, 'pitch': 67}]
    assert result['chords'] == source['chords'] and source['notes']['Vocal']
    assert report['validated'] and len(report['trimmedInsNotes']) == 1


def test_empty_plan_fails_before_audio():
    class Notation:
        read = staticmethod(lambda _: {'notes': {'Vocal': [], 'Ins': []}})
    with pytest.raises(ValueError, match='没有有效旋律'):
        transfer_score('empty', Notation)
