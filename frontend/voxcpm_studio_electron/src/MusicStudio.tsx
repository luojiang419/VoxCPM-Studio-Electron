import { useEffect, useRef, useState, type ReactNode } from "react";
import { musicRequest, type AssistantConfig, type MusicBrief, type MusicDraft, type MusicResult, type PromptPacket } from "./music-api";
import WorkspacePlayer from "./WorkspacePlayer";
import "./music-studio.css";

type Model = { id: string; name: string; ready: boolean; installed: boolean; selected: boolean; size: number };
type Source = { id: string; name: string; kind: string; skill: string | null; url: string };
type Status = { models: Model[]; defaultModel: string; active: boolean; runtimeReady: boolean; rules: { version: string; models: Source[] } };
type Running = { id: string; kind: "prompt" | "audio"; sourceKey: string; writerKey: string };
type Task = { taskId: string; status: string; statusText: string; progressText: string; completed: number; total: number; error: string; result?: any; cancelRequested?: boolean };
const modelDescriptions: Record<string, string> = {
  "ace-xl-turbo": "推荐主力。Turbo适合快速尝试不同编曲，支持中文歌曲与纯音乐，可单独控制速度、调式和拍号。",
  "minimax-music3": "适合细致描述人声、音色与编曲层次。采用分段风格描述，支持歌曲和纯音乐，适合流行与电影配乐方向。",
  "yue2": "先规划乐谱，再生成音乐。支持人声歌曲与纯音乐；纯音乐会自动将旋律转为器乐声部，生成较慢。",
  "heartmula": "用简洁风格标签创作多语言歌曲或纯音乐；纯音乐使用器乐标签与空歌词，建议先生成短段试听。",
};
const STORAGE = "voxcpm-music-studio-v1";
const defaults: MusicBrief = { modelId: "ace-xl-turbo", idea: "", requirements: "", lyrics: "", caption: "", preserveLyrics: true, instrumental: false, language: "auto", duration: 120, bpm: null, keyScale: "", timeSignature: "", seed: 1247, providerId: "" };
function stored() { try { return JSON.parse(localStorage.getItem(STORAGE) || "{}"); } catch { return {}; } }
const sourceKey = (brief: MusicBrief) => JSON.stringify({ ...brief, seed: 0, title: "", providerId: "" });
const writerKey = (brief: MusicBrief) => JSON.stringify([brief.idea, brief.requirements, brief.lyrics, brief.preserveLyrics, brief.instrumental, brief.language]);
const seconds = (value: number) => value >= 60 ? `${Math.floor(value / 60)}分${Math.round(value % 60)}秒` : `${value.toFixed(1)}秒`;

export default function MusicStudio({ backendBaseUrl, modelManager }: { backendBaseUrl: string; modelManager?: ReactNode }) {
  const [brief, setBrief] = useState<MusicBrief>(() => ({ ...defaults, ...stored().brief, providerId: "" }));
  const [packet, setPacket] = useState<PromptPacket | null>(() => stored().packet || null);
  const [preparedKey, setPreparedKey] = useState<string>(() => stored().preparedKey || "");
  const [previousWriterKey, setPreviousWriterKey] = useState<string>(() => stored().previousWriterKey || "");
  const [autoOptimize, setAutoOptimize] = useState<boolean>(true);
  const [manualMode, setManualMode] = useState<boolean>(() => !!stored().manualMode);
  const [running, setRunning] = useState<Running | null>(() => stored().running || null);
  const [task, setTask] = useState<Task | null>(null), [status, setStatus] = useState<Status | null>(null);
  const [results, setResults] = useState<MusicResult[]>([]), [result, setResult] = useState<MusicResult | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [tab, setTab] = useState<"caption" | "lyrics">("caption");
  const [compiled, setCompiled] = useState<PromptPacket | null>(null), [compileError, setCompileError] = useState("");
  const initial = useRef(stored());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sourceRef = useRef(sourceKey(brief)); sourceRef.current = sourceKey(brief);
  const locked = busy || !!running;
  const current = !!packet?.draft.captionZh?.trim() && (!manualMode || !!packet.draft.caption.trim()) && !packet.draft.captionNeedsAdaptation && packet.modelId === brief.modelId && (manualMode || preparedKey === sourceKey(brief)) && (!status || !packet.rulesVersion || packet.rulesVersion === status.rules.version);
  const selected = status?.models.find(model => model.id === brief.modelId);
  const canRepairModel = !!selected?.selected && !!status?.runtimeReady;
  const official = status?.rules.models.find(model => model.id === brief.modelId);
  const draft: MusicDraft = packet?.draft || { title: "", caption: "", lyrics: "", metadata: { bpm: brief.bpm, keyScale: brief.keyScale, language: brief.language, timeSignature: brief.timeSignature }, modelId: brief.modelId, instrumental: brief.instrumental, duration: brief.duration, seed: brief.seed };
  useEffect(() => { localStorage.setItem(STORAGE, JSON.stringify({ brief, packet, preparedKey, previousWriterKey, running, manualMode })); }, [brief, packet, preparedKey, previousWriterKey, running, manualMode]);
  async function refresh(accept: () => boolean = () => true) {
    const [state, config, history] = await Promise.all([musicRequest<Status>(backendBaseUrl, "/api/music/status"), musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings"), musicRequest<{ items: MusicResult[] }>(backendBaseUrl, "/api/music/results")]);
    if (!accept()) return;
    setStatus(state); setAutoOptimize(config.autoOptimizeMusic); setResults(history.items);
    setResult(value => value || history.items[0] || null);
    if (!initial.current.brief) { setBrief(value => ({ ...value, modelId: state.defaultModel || value.modelId })); initial.current.brief = true; }
  }
  useEffect(() => { let active = true; if (backendBaseUrl) void refresh(() => active).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [backendBaseUrl]);
  function buildBrief(): MusicBrief {
    if (current && packet?.brief) return { ...packet.brief, caption: draft.caption, captionZh: draft.captionZh || "", lyrics: draft.lyrics, seed: brief.seed, title: brief.title?.trim() || draft.title, providerId: "" };
    const reuse = packet && writerKey(brief) === previousWriterKey;
    return { ...brief, title: brief.title?.trim() || (reuse ? draft.title : ""), providerId: "", caption: reuse ? (draft.captionNeedsAdaptation ? "" : draft.caption) : brief.caption, captionZh: reuse ? draft.captionZh || "" : brief.captionZh || "", lyrics: reuse ? draft.lyrics : brief.lyrics };
  }
  function manualBrief(): MusicBrief {
    return { ...(manualMode ? brief : buildBrief()), title: brief.title?.trim() || draft.title, lyrics: draft.lyrics, preserveLyrics: true, caption: draft.caption, captionZh: draft.captionZh || "" };
  }
  const draftKey = JSON.stringify([draft, brief.title, brief.bpm, brief.keyScale, brief.timeSignature, brief.seed, current, manualMode]);
  useEffect(() => {
    if (!current) { setCompiled(null); setCompileError(""); }
    if (!backendBaseUrl || !packet || !current || locked) return;
    let active = true;
    const timer = setTimeout(() => {
      void musicRequest<PromptPacket>(backendBaseUrl, "/api/music/compile", { method: "POST", body: JSON.stringify({ brief: manualBrief(), draft }) }).then(value => { if (active) { setCompiled(value); setCompileError(""); } }).catch(error => { if (active) setCompileError(error.message); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [backendBaseUrl, draftKey, locked]);
  useEffect(() => {
    if (!running || !backendBaseUrl) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const route = running!.kind === "prompt" ? "/api/music/prompt-tasks/" : "/api/tasks/";
        const next = await musicRequest<Task>(backendBaseUrl, route + running!.id);
        if (!active) return;
        setTask(next);
        if (["succeeded", "failed", "cancelled"].includes(next.status)) {
          setRunning(null);
          const retained = next.result?.packet || (running!.kind === "prompt" && next.status === "succeeded" ? next.result : null);
          if (retained?.draft && sourceRef.current === running!.sourceKey) { setPacket(retained); setPreparedKey(running!.sourceKey); setPreviousWriterKey(running!.writerKey); setTab("caption"); }
          if (next.status === "succeeded" && next.result && !next.result.cancelled) {
            const prepared = running!.kind === "prompt" ? next.result as PromptPacket : (next.result as MusicResult).packet;
            if (running!.kind === "audio") { setResult(next.result); setMessage("音乐已生成，实际提示词与歌词已随作品保存。"); }
            else setMessage(`AI创作与模型适配完成，用时${seconds(prepared.assistantSeconds || 0)}。可编辑后生成，也可继续调整需求。`);
          } else setMessage(next.error || next.result?.status || "任务已取消，草稿已保留。");
          void refresh().catch(() => {}); return;
        }
      } catch (error) {
        if (!active) return;
        if ((error as any).status === 404) { setRunning(null); setTask(null); setMessage("本地服务已重启，草稿和已完成作品仍保留。"); return; }
        setMessage("正在重连任务进度：" + (error as Error).message);
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [running?.id, backendBaseUrl]);
  async function perform(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  async function compose() {
    await perform(async () => {
      const next = await musicRequest<Task>(backendBaseUrl, "/api/music/compose", { method: "POST", body: JSON.stringify(buildBrief()) });
      setRunning({ id: next.taskId, kind: "prompt", sourceKey: sourceKey(brief), writerKey: writerKey(brief) }); setTask(next);
    });
  }
  async function generate() {
    await perform(async () => {
      if (manualMode && !current) throw new Error("请填写中文风格说明与英文生成提示词，再生成音乐。");
      if (!manualMode && !autoOptimize && (!packet || !current)) throw new Error("请先点击AI创作或适配，完成配套的中英文提示词后再生成。");
      const cached = current && packet;
      const next = await musicRequest<Task>(backendBaseUrl, "/api/music/generate", { method: "POST", body: JSON.stringify({
        brief: cached ? manualBrief() : buildBrief(), draft: cached ? draft : undefined,
        autoOptimize: !manualMode && autoOptimize && !cached, promptId: cached ? packet.promptId || "" : "",
      }) });
      setRunning({ id: next.taskId, kind: "audio", sourceKey: sourceKey(brief), writerKey: writerKey(brief) }); setTask(next);
    });
  }
  function editDraft(value: Partial<MusicDraft>) {
    setPacket({ ...(packet || { inputs: {}, warnings: [], canGenerate: true }), modelId: brief.modelId, rulesVersion: status?.rules.version,
      draft: { ...draft, ...value, modelId: brief.modelId } });
    setPreparedKey(sourceKey(brief)); setPreviousWriterKey(writerKey(brief));
  }
  function toggleInstrumental(enabled: boolean) {
    const keepDraftLyrics = enabled && !draft.instrumental && writerKey(brief) === previousWriterKey;
    setBrief({ ...brief, instrumental: enabled, lyrics: keepDraftLyrics ? draft.lyrics || brief.lyrics : brief.lyrics });
    setTab("caption");
  }
  async function enableModel() {
    const modelId = brief.modelId;
    await perform(async () => {
      const components = await window.voxcpmDesktop.getComponents();
      const profile = components.profile || { selected: [], removed: [], defaultModel: "ace-xl-turbo" };
      await window.voxcpmDesktop.selectComponents({ ...profile, defaultModel: modelId, selected: [...new Set([...profile.selected, modelId])], removed: profile.removed.filter((id: string) => id !== modelId) });
      const backend = await window.voxcpmDesktop.startBackend({ prepare: true });
      // 组件准备会重建音乐页；若页面仍在原处，也必须从恢复后的服务读取就绪状态。
      if (!mounted.current) return;
      const state = await musicRequest<Status>(backend.backendBaseUrl || backendBaseUrl, "/api/music/status");
      if (!mounted.current) return;
      setStatus(state);
      setBrief(value => ({ ...value, modelId }));
      setMessage(state.models.find(model => model.id === modelId)?.ready ? "模型已补齐并选用，可以生成音乐。" : "模型尚未就绪，请检查补齐进度后重试。");
    });
  }
  async function saveAudio() {
    const output = result;
    if (!output) return;
    await perform(async () => {
      const target = await window.voxcpmDesktop.saveDialog({
        defaultPath: output.fileName || (output.title || "音乐").replace(/[<>:"/\\|?*]/g, "_") + ".wav",
        filters: [{ name: "WAV音频", extensions: ["wav"] }],
      });
      if (!target.canceled && target.filePath) {
        await musicRequest(backendBaseUrl, "/api/files/save-as", { method: "POST", body: JSON.stringify({ sourcePath: output.outputPath, targetPath: target.filePath }) });
        setMessage("音乐已另存为。");
      }
    });
  }
  const hasContent = !!(brief.idea.trim() || brief.lyrics.trim() || draft.caption.trim() || draft.captionZh?.trim() || draft.lyrics.trim());
  const canGenerate = !locked && !!backendBaseUrl && (!!selected?.ready || canRepairModel) && hasContent && (manualMode ? current : autoOptimize || current) && !(current && (compiled?.canGenerate === false || !!compileError));
  const taskPanel = (running || message) && <section className="music-task-card" role="status" aria-live="polite"><div><strong>{running ? task?.progressText || task?.statusText || "任务已加入队列" : message}</strong>{running && <progress max={100} value={running.kind === "prompt" ? task?.completed || undefined : undefined} />}</div>{running && <button className="ghost-button" disabled={!!task?.cancelRequested} onClick={() => void perform(async () => { const route = running.kind === "prompt" ? "/api/music/prompt-tasks/" : "/api/tasks/"; setTask(await musicRequest(backendBaseUrl, route + running.id + "/cancel", { method: "POST", body: "{}" })); })}>{task?.cancelRequested ? "正在取消…" : "取消任务"}</button>}</section>;
  return <>
  <div className="music-layout">
    <div className="music-main">
      <section className="music-card music-brief-card">
        <div className="music-card-heading"><div><span className="music-kicker">从灵感开始</span><h2>今天，想听到怎样的音乐？</h2></div></div>
        <textarea className="music-idea" aria-label="音乐需求与提示词" value={brief.idea} disabled={locked} onChange={e => setBrief({ ...brief, idea: e.target.value })} placeholder="描述主题、情绪或故事，也可以粘贴已有提示词。例如：一首中文史诗歌曲，回望人类五十万年的战争与文明，从苍凉克制走向宏大，最终落在对和平的希望。" rows={4} />
        <details className="music-details"><summary>更多要求与已有歌词 <span>可选</span></summary><label className="field"><span>创作要求</span><textarea value={brief.requirements} disabled={locked} onChange={e => setBrief({ ...brief, requirements: e.target.value })} rows={3} placeholder="如：男中音、不要说唱、铜管和弦乐逐步进入、结尾完整收束。" /></label><label className="field"><span>已有歌词</span><textarea value={brief.lyrics} disabled={locked || brief.instrumental} onChange={e => setBrief({ ...brief, lyrics: e.target.value })} rows={6} placeholder="有歌词可以直接粘贴；没有时，AI会根据需求创作。" /></label><label className="music-switch-label"><input className="music-switch" type="checkbox" role="switch" checked={brief.preserveLyrics} disabled={locked || brief.instrumental} onChange={e => setBrief({ ...brief, preserveLyrics: e.target.checked })} />保留已有歌词原文</label></details>
        <div className="music-brief-actions"><label className="music-switch-label"><input className="music-switch" type="checkbox" role="switch" checked={brief.instrumental} disabled={locked} onChange={e => toggleInstrumental(e.target.checked)} />纯音乐</label><button className="primary-button" disabled={locked || !backendBaseUrl || !hasContent} onClick={() => void compose()}>{current ? "再次优化 / 创作" : packet ? "AI 适配所选模型" : "AI 创作 / 优化"}</button></div>
        {brief.instrumental && <p className="music-help">全器乐模式：AI将设计旋律、配器与段落发展，生成时不使用歌词或人声要求。关闭后可继续编辑已有歌词。</p>}
      </section>
      <section className="music-card music-prompt-card">
        <div className="music-card-heading"><div><span className="music-kicker">生成前，可自由修改</span><h3>最终音乐提示词</h3></div><span className={`music-ready-label ${current ? "is-ready" : ""}`}>{current ? manualMode ? "手工提示词已就绪" : "已适配当前模型" : manualMode ? "填写中文说明与英文提示词" : draft.captionNeedsAdaptation ? "中文已修改，等待重新适配" : packet ? "草稿或模型已改变，等待适配" : "等待创作或填写中文风格"}</span></div>
        <label className="music-switch-label music-manual-switch"><input className="music-switch" type="checkbox" role="switch" aria-label="手工填写中英文提示词" checked={manualMode} disabled={locked} onChange={event => { setManualMode(event.target.checked); if (event.target.checked) editDraft({ captionNeedsAdaptation: false }); }} />手工填写提示词，无需 AI 助手</label>
        <label className="music-title-input"><span>作品名称</span><input value={brief.title ?? draft.title} maxLength={150} disabled={locked} placeholder="填写名称，生成后以此命名音频" onChange={e => setBrief({ ...brief, title: e.target.value })} /></label>
        <div className="music-tabs" role="tablist" aria-label="提示词与歌词"><button role="tab" aria-selected={tab === "caption"} onClick={() => setTab("caption")}>{brief.modelId === "heartmula" ? "风格标签" : "风格与编曲"}</button><button role="tab" disabled={brief.instrumental} aria-selected={tab === "lyrics"} onClick={() => setTab("lyrics")}>歌词</button></div>
        <textarea className="music-final-text" aria-label={tab === "lyrics" ? "最终歌词" : "最终风格提示词"} value={tab === "lyrics" ? draft.lyrics : draft.captionZh || ""} disabled={locked || (tab === "lyrics" && brief.instrumental)} onChange={e => editDraft(tab === "lyrics" ? { lyrics: e.target.value } : { captionZh: e.target.value, captionNeedsAdaptation: !manualMode })} rows={manualMode ? 3 : 12} placeholder={tab === "lyrics" ? "AI创作的歌词会显示在这里。" : manualMode ? "中文风格说明，方便核对音乐方向。" : draft.caption && !draft.captionZh ? "这份旧草稿仅有英文，点击AI适配即可同时获得中文展示稿和英文生成稿。" : brief.modelId === "heartmula" ? "填写中文风格标签，如：纯音乐、电影感、管弦乐、庄重。" : "用中文描述风格与编曲，AI会同时创作中文展示稿和英文生成稿。"} />
        {manualMode && tab === "caption" && <label className="field music-manual-caption"><span>英文生成提示词</span><textarea aria-label="英文生成提示词" value={draft.caption} disabled={locked} onChange={event => editDraft({ caption: event.target.value, captionNeedsAdaptation: false })} rows={5} placeholder="填写实际提交给音乐模型的英文风格与配器描述。" /></label>}
        {tab === "caption" && <p className="music-help">{manualMode ? "核对中英文描述与音乐参数后，点击底部生成音乐。手工模式直接使用英文稿，不调用AI助手。" : "中文展示与英文生成稿由AI同时创作。修改中文后需重新适配，生成时使用配套英文稿。"}</p>}
        {compileError && current && <p className="music-message">{compileError}</p>}
        {(current ? compiled?.warnings || packet?.warnings || [] : []).map(warning => <p className="music-help" key={warning}>{warning}</p>)}
        <details className="music-details"><summary>查看最终模型输入与规则来源</summary><p className="music-help">{official?.kind === "official-skill" ? `官方技能：${official.skill}` : "依据HeartMuLa官方文档与推理协议整理"} <button className="music-text-button" onClick={() => official && window.voxcpmDesktop.openExternal(official.url)}>查看官方来源 ↗</button></p><pre className="music-input-preview">{current && compiled ? JSON.stringify(compiled.inputs, null, 2) : "完成当前模型的适配后，可在此查看实际提交字段。"}</pre><button className="ghost-button" disabled={!current || !compiled} onClick={() => void perform(async () => { await navigator.clipboard.writeText(JSON.stringify(compiled!.inputs, null, 2)); setMessage("最终模型输入已复制。"); })}>复制模型输入</button></details>
      </section>
      {result && <section className="music-card music-result"><div className="music-card-heading"><div><span className="music-kicker">当前试听作品</span><h3>{result.title}</h3></div><span className="music-help">底部播放与保存</span></div><div className="music-result-meta"><span>{status?.models.find(m => m.id === result.modelId)?.name || result.modelId}</span><span>音频 {seconds(result.duration)}</span><span>生成 {seconds(result.report.elapsedSeconds)}</span>{result.report.assistantSeconds > 0 && <span>AI创作 {seconds(result.report.assistantSeconds)}</span>}</div></section>}
      {results.length > 0 && <section className="music-card music-history"><div className="music-card-heading"><h3>最近作品</h3><span className="music-help">点击载入底部播放器</span></div>{results.slice(0, 8).map(item => <button className={item.outputPath === result?.outputPath ? "is-current" : ""} key={item.outputPath} aria-pressed={item.outputPath === result?.outputPath} onClick={() => setResult(item)}><span className="music-history-icon">♪</span><strong>{item.title}</strong><span>{status?.models.find(m => m.id === item.modelId)?.name || item.modelId}</span><small>{seconds(item.duration)}</small></button>)}</section>}
    </div>
    <aside className="music-options">
      <section className="music-card"><div className="music-card-heading music-model-heading"><h3>音乐模型</h3>{modelManager}</div><label className="field"><span>当前模型</span><select value={brief.modelId} disabled={locked} onChange={e => setBrief({ ...brief, modelId: e.target.value })}>{(status?.models || [{ id: "ace-xl-turbo", name: "ACE-Step 1.5 XL Turbo" }]).map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>{selected && <div className="music-model-facts"><span>{(selected.size / 1024 ** 3).toFixed(2)} GiB</span><span>{selected.ready ? "已就绪" : canRepairModel ? "生成时自动补齐" : selected.installed ? "文件已安装" : "待补齐"}</span></div>}{selected && !selected.ready && !canRepairModel && <button className="ghost-button music-full-button" disabled={locked} onClick={() => void enableModel()}>启用并补齐此模型</button>}{canRepairModel && !selected?.installed && <p className="music-help">生成时自动下载缺失文件，校验通过后继续生成，可随时取消。</p>}<p className="music-model-description">{modelDescriptions[brief.modelId]}</p><p className="music-help">更换模型后会重新适配提示词，保留相同需求下的歌词。</p></section>
      <section className="music-card"><div className="music-card-heading"><h3>音乐参数</h3></div><div className="music-parameter-grid">
        <label className="field"><span>期望时长 / 秒</span><input type="number" min={10} max={300} value={brief.duration} disabled={locked} onChange={e => setBrief({ ...brief, duration: Number(e.target.value) })} /></label>
        <label className="field"><span>歌词语言</span><select value={brief.instrumental ? "unknown" : brief.language} disabled={locked || brief.instrumental} onChange={e => setBrief({ ...brief, language: e.target.value })}>{brief.instrumental && <option value="unknown">无歌词</option>}<option value="auto">跟随需求</option><option value="zh">中文 / 普通话</option><option value="yue">粤语</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option></select></label>
        <label className="field"><span>速度 / BPM</span><input type="number" min={30} max={300} placeholder="由AI推断" value={brief.bpm ?? ""} disabled={locked} onChange={e => setBrief({ ...brief, bpm: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        <label className="field"><span>拍号</span><select value={brief.timeSignature} disabled={locked} onChange={e => setBrief({ ...brief, timeSignature: e.target.value })}><option value="">由AI推断</option><option>4/4</option><option>3/4</option><option>6/8</option><option>2/4</option></select></label>
        <label className="field"><span>调式</span><input placeholder="如 D minor，可留空" value={brief.keyScale} disabled={locked} onChange={e => setBrief({ ...brief, keyScale: e.target.value })} /></label>
        <label className="field"><span>随机种子</span><input type="number" min={0} max={2147483647} value={brief.seed} disabled={locked} onChange={e => setBrief({ ...brief, seed: Number(e.target.value) })} /></label>
      </div><p className="music-help">模型可能提前结束歌曲。节奏、音色和结构是生成方向，可通过试听继续调整。</p></section>
    </aside>
  </div>
  <WorkspacePlayer variant="music"
    src={result ? backendBaseUrl + result.previewUrl : ""}
    fileName={result?.title || ""} hasOutput={!!result}
    canGenerate={canGenerate} generating={running?.kind === "audio"}
    onGenerate={() => void generate()} onSave={() => void saveAudio()}
    onOpenDirectory={() => { const output = result; if (output) void window.voxcpmDesktop.showItemInFolder(output.outputPath).catch(error => setMessage((error as Error).message)); }}
    status={taskPanel}
  />
  </>;
}
