"""实际调用用户配置的AI助手，为四模型创作/适配同一首原创中文歌曲。"""
import argparse
import json
import re
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType('voxcpm'); package.__path__ = [str(ROOT / 'backend/voxcpm'), str(ROOT.parent / 'src/voxcpm')]
sys.modules['voxcpm'] = package
from voxcpm.music_prompts import MusicBrief, MusicPromptService, structured_caption
from voxcpm.studio_assistant import AssistantStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assistant-config', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'builds/music-ai-live-validation')
    args = parser.parse_args()
    store = AssistantStore(args.output / 'data')
    if args.assistant_config:
        store.import_file(str(args.assistant_config))
    service = MusicPromptService(store)
    lyrics = ''
    idea = '创作一首中文史诗歌曲，讲述人类五十万年从石器、青铜、铁骑到工业战争的漫长历程。苍凉、壮阔，最后走向对和平的希望。'
    requirements = '男中音，咬字清楚，不要说唱，不要嘶吼；铜管、弦乐、战鼓渐进，旋律清晰，最后有完整的和声收束。只写适合一分钟演唱的篇幅。'
    for model in ('ace-xl-turbo', 'minimax-music3', 'yue2', 'heartmula'):
        brief = MusicBrief(modelId=model, idea=idea, requirements=requirements, lyrics=lyrics, preserveLyrics=True,
                           duration=60, bpm=92, keyScale='D minor', timeSignature='4/4', language='zh')
        packet = service.compose(brief, lambda n, text: print(model, n, text, flush=True))
        assert re.search('[\u3400-\u9fff]', packet['draft']['captionZh']), '缺少中文展示稿'
        assert not re.search('[\u3400-\u9fff]', packet['draft']['caption']), '英文生成稿混入中文'
        assert 'captionZh' not in packet['inputs'], '中文展示字段进入模型输入'
        if lyrics:
            assert packet['draft']['lyrics'] == lyrics, '模型切换后歌词被改变'
        lyrics = packet['draft']['lyrics']
        if model == 'minimax-music3':
            assert structured_caption(packet['inputs']['caption'])
        target = args.output / (model + '-prompt.json')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(packet, ensure_ascii=False, indent=2), encoding='utf8')
        print('PROMPT_VERIFIED', model, 'english', len(packet['draft']['caption']), 'chinese', len(packet['draft']['captionZh']), 'lyrics', len(lyrics), flush=True)


if __name__ == '__main__':
    main()
