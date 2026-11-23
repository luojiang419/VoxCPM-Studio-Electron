import { useEffect, useRef, useState } from 'react';
import WorkspacePlayer from './WorkspacePlayer';
import './soundeffect-studio.css';

type Brief = { prompt: string; title: string; seconds: number; steps: number; guidance: number; seed: number; negativePrompt: string };
type Result = { id: string; outputPath: string; previewUrl: string; title: string; prompt: string; createdAt: string; duration: number; settings: Brief };
type Task = { taskId: string; status: string; error: string; progressText: string; statusText: string; result?: Result };
type Model = { id: string; ready: boolean };
const KEY = 'jvox-soundeffect-v1';
const defaults: Brief = { prompt: '', title: '', seconds: 10, steps: 100, guidance: 4, seed: 1247, negativePrompt: '' };
const scenes = [
  { name: '雨夜街角', type: '自然环境', symbol: 'rain', prompt: '雨夜的安静街道，雨滴持续敲打路面与遮雨棚，近处偶尔滴落积水，远处一辆汽车缓缓驶过，声音由远及近再远去。没有人声和音乐。' },
  { name: '清晨森林', type: '自然环境', symbol: 'leaf', prompt: '清晨森林里的自然环境声，轻风吹动树叶，几只小鸟从不同方向交替鸣叫，远处有细小溪流，空间开阔而安静。没有人声和音乐。' },
  { name: '机械键盘', type: '日常拟音', symbol: 'keys', prompt: '近距离录制的机械键盘打字声，清脆、快速又有不规则的停顿，偶尔敲击空格与回车，安静室内背景。没有人声和音乐。' },
  { name: '咖啡时刻', type: '日常拟音', symbol: 'cup', prompt: '安静咖啡馆内，将热咖啡倒入陶瓷杯，细腻的水流声逐渐变高，随后用小勺轻轻搅拌，勺子与杯壁轻碰。没有人声和音乐。' },
  { name: '能量启动', type: '影视游戏', symbol: 'spark', prompt: '科幻装置启动的声音，从低沉的电流嗡鸣逐渐上升，伴随细小的电子脉冲，最后发出一次短促有力的能量释放声。没有人声和音乐。' },
  { name: '老门打开', type: '影视游戏', symbol: 'door', prompt: '一扇厚重的老木门被缓慢推开，先听到门把手转动，再是木头与铰链低沉的吱呀声，最后门轻轻撞到门挡，在空房间内留下短暂回声。没有人声和音乐。' },
];
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { rain: 'M6 14a4 4 0 0 1 0-8 6 6 0 0 1 11 0 4 4 0 0 1 1 8M7 17l-1 3m6-3-1 3m6-3-1 3', leaf: 'M5 19C1 7 10 3 21 3c0 12-4 18-13 15M4 21 16 9', keys: 'M3 6h18v13H3ZM6 10h1m3 0h1m3 0h1m3 0h1M6 14h1m3 0h1m3 0h4', cup: 'M4 5h13v10a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5ZM17 7h2a3 3 0 0 1 0 6h-2M7 2v1m5-1v1', spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z', door: 'M4 22V3l14-1v20M18 5h3v17H2m11-10v2', wave: 'M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4' };
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.wave} /></svg>;
}
function stored(): { brief?: Brief; taskId?: string; selectedId?: string } { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
async function request<T>(base: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + route, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || `请求失败（${response.status}）`), { status: response.status });
  return data;
}

export default function SoundEffectStudio({ backendBaseUrl }: { backendBaseUrl: string }) {
  const initial = useRef(stored());
  const [brief, setBrief] = useState<Brief>(() => ({ ...defaults, ...initial.current.brief }));
  const [taskId, setTaskId] = useState(initial.current.taskId || '');
  const [task, setTask] = useState<Task | null>(null);
  const [results, setResults] = useState<Result[]>([]), [selected, setSelected] = useState<Result | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [filter, setFilter] = useState('全部');
  const locked = !!taskId || busy;
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify({ brief, taskId, selectedId: selected?.id })); }, [brief, taskId, selected]);
  useEffect(() => {
    if (!backendBaseUrl) return;
    let active = true;
    void Promise.all([request<{ models: Model[] }>(backendBaseUrl, '/api/moss/status'), request<{ items: Result[] }>(backendBaseUrl, '/api/soundeffects/results')])
      .then(([status, history]) => { if (active) { setReady(!!status.models.find(m => m.id === 'soundeffect')?.ready); setResults(history.items); setSelected(current => current || history.items.find(r => r.id === initial.current.selectedId) || history.items[0] || null); } })
      .catch(e => { if (active) setMessage(e.message); });
    return () => { active = false; };
  }, [backendBaseUrl]);
  useEffect(() => {
    if (!taskId || !backendBaseUrl) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<Task>(backendBaseUrl, '/api/tasks/' + taskId);
        if (!active) return;
        setTask(next);
        if (['succeeded', 'failed', 'cancelled'].includes(next.status)) {
          setTaskId(''); setMessage(next.error || next.statusText);
          if (next.status === 'succeeded' && next.result) {
            const result = next.result; setSelected(result); setResults(rows => [result, ...rows.filter(row => row.id !== result.id)]);
          }
          return;
        }
      } catch (e) {
        if (!active) return;
        const text = (e as Error).message;
        if ((e as Error & { status?: number }).status === 404) { setTaskId(''); setMessage('本地服务已重启，草稿和已保存作品仍保留。'); return; }
        setMessage('正在重连任务：' + text);
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [taskId, backendBaseUrl]);
  function update(patch: Partial<Brief>) { setBrief(value => ({ ...value, ...patch })); }
  async function generate() {
    setBusy(true); setMessage('');
    try { const task = await request<Task>(backendBaseUrl, '/api/tasks/generate-soundeffect', { method: 'POST', body: JSON.stringify(brief) }); setTask(task); setTaskId(task.taskId); }
    catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!selected) return;
    try {
      const target = await window.voxcpmDesktop.saveDialog({ defaultPath: selected.title + '.wav', filters: [{ name: 'WAV 音频', extensions: ['wav'] }] });
      if (target.canceled || !target.filePath) return;
      await request(backendBaseUrl, '/api/files/save-as', { method: 'POST', body: JSON.stringify({ sourcePath: selected.outputPath, targetPath: target.filePath }) });
      setMessage('已保存到 ' + target.filePath);
    } catch (e) { setMessage((e as Error).message); }
  }
  async function cancel() { try { await request(backendBaseUrl, '/api/tasks/' + taskId + '/cancel', { method: 'POST' }); setMessage('正在取消任务…'); } catch (e) { setMessage((e as Error).message); } }
  return <>
    <div className="sfx-layout">
      <div className="sfx-main">
        <section className="sfx-card sfx-compose">
          <div className="sfx-heading"><div><span className="sfx-kicker">SOUND DESIGN</span><h2>把脑海里的场景，变成声音。</h2></div><div className="sfx-wave-mark"><Icon name="wave" /></div></div>
          <label className="sfx-label" htmlFor="sfx-prompt">音效描述 <span>中文 / English</span></label>
          <textarea id="sfx-prompt" className="sfx-prompt" maxLength={2000} disabled={locked} value={brief.prompt} onChange={e => update({ prompt: e.target.value })} placeholder="例如：雨落在木屋屋顶上，窗外传来轻轻的风声，偶尔有一滴水落进金属桶……" />
          <div className="sfx-prompt-foot"><span>描述声源、动作、空间与声音的变化。</span><span>{brief.prompt.length} / 2000</span></div>
          <label className="sfx-title"><span>作品名称 <small>可选</small></span><input aria-label="音效作品名称" maxLength={100} disabled={locked} value={brief.title} onChange={e => update({ title: e.target.value })} placeholder="给这个声音起个名字" /></label>
        </section>
        <section className="sfx-card">
          <div className="sfx-section-heading"><h3>从一个声音开始</h3><span>选择灵感，继续改写</span></div>
          <div className="sfx-filters" aria-label="音效灵感分类">{['全部', '自然环境', '日常拟音', '影视游戏'].map(name => <button key={name} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}</button>)}</div>
          <div className="sfx-scenes">{scenes.filter(scene => filter === '全部' || scene.type === filter).map(scene => <button key={scene.name} disabled={locked} onClick={() => update({ prompt: scene.prompt })}><span className="sfx-scene-symbol"><Icon name={scene.symbol} /></span><strong>{scene.name}</strong><span>{scene.type}</span><span className="sfx-scene-arrow" aria-hidden="true">↗</span></button>)}</div>
        </section>
        <section className="sfx-card sfx-works">
          <div className="sfx-section-heading"><h3>最近作品 <small>{results.length ? String(results.length).padStart(2, '0') : ''}</small></h3><span>点击作品，底部试听</span></div>
          {results.length === 0 ? <div className="sfx-empty"><Icon name="wave" /><div><strong>你的声音灵感，即将在这里留存。</strong><span>生成后自动保存，可随时试听、复用和导出。</span></div></div> : <div className="sfx-result-list">{results.map(result => <div key={result.id} className={`sfx-result ${selected?.id === result.id ? 'is-selected' : ''}`}><button onClick={() => setSelected(result)} aria-label={`试听 ${result.title}`}><Icon name="wave" /><span><strong>{result.title}</strong><small>{result.duration.toFixed(1)} 秒 · {new Date(result.createdAt).toLocaleString('zh-CN')}</small></span></button><button className="sfx-reuse" disabled={locked} onClick={() => { setSelected(result); setBrief({ ...defaults, ...result.settings }); }}>复用设置</button></div>)}</div>}
        </section>
      </div>
      <aside className="sfx-options">
        <section className="sfx-card"><div className="sfx-section-heading"><h3>生成模型</h3><span className={`sfx-ready ${ready ? 'is-ready' : ''}`}>{ready ? '已就绪' : '待准备'}</span></div><div className="sfx-model"><div className="sfx-model-logo">M</div><div><strong>MOSS-SoundEffect</strong><span>v2.0 · OpenMOSS</span></div></div><p className="sfx-help">从文字生成环境氛围、日常拟音和影视音效。支持中英文描述。</p><div className="sfx-model-specs"><span>48 kHz</span><span>最长 30 秒</span><span>本地生成</span></div>{!ready && <p className="sfx-help">模型准备完成后可生成。运行测试目录的「准备MOSS模型」，完成后重新进入此页。</p>}</section>
        <section className="sfx-card"><div className="sfx-section-heading"><h3>声音参数</h3><button className="sfx-text-button" disabled={locked} onClick={() => update({ seconds: 10, steps: 100, guidance: 4, seed: 1247, negativePrompt: '' })}>重置</button></div>
          <label className="sfx-control"><span>音效时长 <strong>{brief.seconds} <small>秒</small></strong></span><input type="range" aria-label="音效时长" min={1} max={30} step={1} disabled={locked} value={brief.seconds} onChange={e => update({ seconds: +e.target.value })} /><div className="sfx-range-labels"><span>1 秒</span><span>30 秒</span></div></label>
          <div className="sfx-duration-chips">{[5, 10, 15, 30].map(seconds => <button key={seconds} disabled={locked} aria-pressed={brief.seconds === seconds} onClick={() => update({ seconds })}>{seconds}s</button>)}</div>
          <details className="sfx-advanced"><summary>高级设置</summary><label className="sfx-control"><span>推理步数 <strong>{brief.steps}</strong></span><input type="range" aria-label="音效推理步数" min={10} max={200} step={10} disabled={locked} value={brief.steps} onChange={e => update({ steps: +e.target.value })} /></label><label className="sfx-control"><span>描述引导强度 <strong>{brief.guidance.toFixed(1)}</strong></span><input type="range" aria-label="音效描述引导强度" min={1} max={10} step={.5} disabled={locked} value={brief.guidance} onChange={e => update({ guidance: +e.target.value })} /></label><label className="sfx-control"><span>随机种子<button type="button" className="sfx-text-button" disabled={locked} onClick={() => update({ seed: Math.floor(Math.random() * 2147483647) })}>换一个</button></span><input type="number" aria-label="音效随机种子" min={0} max={2147483647} disabled={locked} value={brief.seed} onChange={e => update({ seed: Math.min(2147483647, Math.max(0, Math.floor(+e.target.value))) })} /></label><label className="sfx-control"><span>不希望出现的声音</span><textarea aria-label="音效负面描述" rows={3} maxLength={1000} disabled={locked} value={brief.negativePrompt} onChange={e => update({ negativePrompt: e.target.value })} placeholder="例如：音乐、人声、失真" /></label></details>
        </section>
        <div className="sfx-note"><span>创作小提示</span><p>一次聚焦一个场景。写清楚声音如何开始、变化和结束，能让音效更有画面感。</p></div>
      </aside>
    </div>
    <WorkspacePlayer variant="soundeffect" src={selected ? backendBaseUrl + selected.previewUrl : ''} fileName={selected?.title || ''} hasOutput={!!selected} canGenerate={!!backendBaseUrl && ready && !!brief.prompt.trim() && !locked} generating={locked} onGenerate={() => void generate()} onSave={() => void save()} onOpenDirectory={() => { if (selected) void window.voxcpmDesktop.showItemInFolder(selected.outputPath); }} status={(message || taskId) && <div className="sfx-status" role="status"><span>{taskId ? task?.progressText || task?.statusText || '正在提交…' : message}</span>{taskId && <button className="ghost-button" onClick={() => void cancel()}>取消生成</button>}</div>} />
  </>;
}
