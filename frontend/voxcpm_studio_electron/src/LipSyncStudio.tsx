import { useEffect, useState } from "react";
import type { StudioHistory } from "./production-types";
import "./lipsync-studio.css";

type Result = { outputPath: string; previewUrl: string; mode: string; duration: number; logPath: string; report: { engine: string; elapsedSeconds: number; peakReservedMB: number; fallbackReason?: string } };
type Task = { taskId: string; status: string; statusText: string; error: string; completed: number; cancelRequested?: boolean; result?: Result };
type ModelVersion = "auto" | "1.5" | "1.6";
type Status = { ready: boolean; root: string; missing: string[]; active: boolean; engine: string; selectedVersion: string; selectionReason: string; hardware: { name: string; totalMB: number; freeMB: number } };
type Draft = { mode: "video" | "photo"; modelVersion: ModelVersion; video: string; photo: string; audio: string; steps: number; guidance: number; seed: number; shortVideo: "loop" | "hold" };
const DRAFT_KEY = "voxcpm-lipsync-draft", TASK_KEY = "voxcpm-lipsync-task";
const defaults: Draft = { mode: "video", modelVersion: "auto", video: "", photo: "", audio: "", steps: 20, guidance: 1.5, seed: 1247, shortVideo: "loop" };
const basename = (value: string) => value.split(/[\\/]/).pop() || value;
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } }
async function request<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  if (!base) throw new Error("请先在运行控制中启动本地服务。");
  const response = await fetch(base + path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await response.json();
  if (!response.ok) { const error = new Error(typeof data.detail === "string" ? data.detail : `请求失败（${response.status}）`); Object.assign(error, { status: response.status }); throw error; }
  return data;
}

export default function LipSyncStudio({ backendBaseUrl, latestAudio }: { backendBaseUrl: string; latestAudio: string }) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...defaults, ...stored<Partial<Draft>>(DRAFT_KEY, {}) }));
  const [status, setStatus] = useState<Status | null>(null);
  const [history, setHistory] = useState<StudioHistory[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [taskId, setTaskId] = useState(() => stored<string>(TASK_KEY, ""));
  const [task, setTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = !!taskId;
  const locked = !!busy || running;
  const source = draft[draft.mode];
  const media = (path: string) => path ? `${backendBaseUrl}/media?path=${encodeURIComponent(path)}` : "";
  const update = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));
  useEffect(() => { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }, [draft]);
  useEffect(() => { localStorage.setItem(TASK_KEY, JSON.stringify(taskId)); }, [taskId]);

  async function refresh(accept: () => boolean = () => true) {
    const [nextStatus, nextHistory, nextResults] = await Promise.all([
      request<Status>(backendBaseUrl, `/api/lipsync/status?modelVersion=${draft.modelVersion}`),
      request<{ items: StudioHistory[] }>(backendBaseUrl, "/api/workspace/history"),
      request<{ items: Result[] }>(backendBaseUrl, "/api/lipsync/results"),
    ]);
    if (!accept()) return;
    setStatus(nextStatus); setHistory(nextHistory.items); setResults(nextResults.items);
    setResult(current => current || nextResults.items[0] || null);
  }
  useEffect(() => {
    let active = true;
    setStatus(null);
    if (backendBaseUrl) void refresh(() => active).catch(exc => { if (active) setError(String(exc.message || exc)); });
    return () => { active = false; };
  }, [backendBaseUrl, draft.modelVersion]);
  useEffect(() => {
    if (!taskId || !backendBaseUrl) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<Task>(backendBaseUrl, `/api/tasks/${taskId}`);
        if (!active) return;
        setTask(next);
        if (["succeeded", "failed", "cancelled"].includes(next.status)) {
          setTaskId("");
          if (next.status === "succeeded" && next.result) { setResult(next.result); setNotice([next.result.report.fallbackReason, "视频已生成，可以播放或另存为。"].filter(Boolean).join(" ")); setError(""); }
          else if (next.status === "failed") setError(next.error || "生成失败，请查看本次任务日志。");
          else setNotice("视频任务已取消。");
          void refresh().catch(() => {});
          return;
        }
      } catch (exc) {
        if (!active) return;
        const failure = exc as Error & { status?: number };
        if (failure.status === 404) { setTaskId(""); setTask(null); setError("服务已重启，之前的任务状态已失效。已完成的视频仍可在最近作品中查看。"); return; }
        setError("无法读取任务进度，正在重连。" + failure.message);
      }
      if (active) timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [taskId, backendBaseUrl]);

  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name); setError(""); setNotice("");
    try { await fn(); } catch (exc) { setError((exc as Error).message || String(exc)); } finally { setBusy(""); }
  }
  async function choose(kind: "source" | "audio") {
    await action("选择文件", async () => {
      const extensions = kind === "audio" ? ["wav", "mp3", "flac", "ogg", "m4a", "aac"] : draft.mode === "video" ? ["mp4", "mov", "mkv", "avi", "webm", "m4v"] : ["png", "jpg", "jpeg", "webp", "bmp"];
      const selected = await window.voxcpmDesktop.openDialog({ properties: ["openFile"], filters: [{ name: kind === "audio" ? "配音音频" : "人物素材", extensions }] });
      if (!selected.canceled && selected.filePaths[0]) update({ [kind === "audio" ? "audio" : draft.mode]: selected.filePaths[0] });
    });
  }
  async function generate() {
    await action("提交任务", async () => {
      if (!source || !draft.audio) throw new Error("请先选择人物素材和配音音频。");
      const next = await request<Task>(backendBaseUrl, "/api/lipsync/generate", { method: "POST", body: JSON.stringify({ mode: draft.mode, modelVersion: draft.modelVersion, sourcePath: source, audioPath: draft.audio, steps: draft.steps, guidance: draft.guidance, seed: draft.seed, shortVideo: draft.shortVideo }) });
      setTask(next); setTaskId(next.taskId);
    });
  }
  async function configure() {
    await action("选择模型", async () => {
      const selected = await window.voxcpmDesktop.openDialog({ properties: ["openDirectory"] });
      if (!selected.canceled && selected.filePaths[0]) {
        const next = await request<Status>(backendBaseUrl, "/api/lipsync/settings", { method: "PUT", body: JSON.stringify({ root: selected.filePaths[0] }) });
        setStatus(await request<Status>(backendBaseUrl, `/api/lipsync/status?modelVersion=${draft.modelVersion}`));
        if (!next.ready) throw new Error(next.missing.join("、"));
      }
    });
  }

  return <div className="ls-studio">
    <div className="ls-toolbar"><div className="ls-tabs" role="group" aria-label="素材模式">{(["video", "photo"] as const).map(mode => <button key={mode} className={draft.mode === mode ? "active" : ""} onClick={() => update({ mode })} disabled={locked}>{mode === "video" ? "视频对口型" : "照片说话"}</button>)}</div><span className={`ls-engine ${status?.ready ? "ready" : ""}`}><i />{status?.ready ? `${status.engine} · 低显存` : "视频模型待就绪"}</span></div>
    {error && <div className="ls-message ls-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="ls-message" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
    <div className="ls-body"><section className="ls-preview-column"><div className="ls-section-title"><h2>人物素材</h2><span>{draft.mode === "video" ? "保留原画面与人物动作" : "固定姿态 · 音频驱动嘴部"}</span></div>
      <button className={`ls-file ${source ? "selected" : ""}`} disabled={locked} onClick={() => void choose("source")}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m9 8 7 4-7 4z" /></svg><span><strong>{source ? basename(source) : `选择${draft.mode === "video" ? "人物视频" : "人物照片"}`}</strong><small>{source ? "点击更换素材" : draft.mode === "video" ? "MP4 / MOV / MKV / WEBM" : "JPG / PNG / WEBP"}</small></span><b>＋</b></button>
      <div className="ls-source-preview">{source ? draft.mode === "video" ? <video key={source} src={media(source)} controls preload="metadata" /> : <img src={media(source)} alt="待生成的人物照片" /> : <div className="ls-empty"><span>让画面，跟上你的声音</span><p>选择单人、脸部清晰、无遮挡的素材</p></div>}</div>
      <div className="ls-section-title ls-result-title"><h2>生成结果</h2>{results.length > 0 && <select aria-label="最近视频作品" value={result?.outputPath || ""} onChange={event => setResult(results.find(item => item.outputPath === event.target.value) || null)}><option value="" disabled>最近作品</option>{results.map(item => <option key={item.outputPath} value={item.outputPath}>{basename(item.outputPath)} · {duration(item.duration)}</option>)}</select>}</div>
      <div className="ls-result-preview">{result ? <video key={result.outputPath} src={backendBaseUrl + result.previewUrl} controls preload="metadata" /> : <div className="ls-empty"><span>{running ? "正在生成新视频" : "作品将在这里出现"}</span><p>完成后可预览和导出 MP4</p></div>}</div>
      {result && <div className="ls-result-info"><span>{result.report.engine} · {duration(result.duration)} · {Math.round(result.report.elapsedSeconds)} 秒生成 · 峰值 {Math.round(result.report.peakReservedMB / 1024 * 10) / 10} GB</span><button className="ls-link" onClick={() => void window.voxcpmDesktop.showItemInFolder(result.outputPath)}>打开文件位置 ↗</button></div>}
      {result?.report.fallbackReason && <p className="ls-hint" role="status">{result.report.fallbackReason}</p>}
    </section><aside className="ls-settings"><div className="ls-section-title"><h2>配音与生成</h2><span>全程在本机处理</span></div><label className="ls-label">驱动音频</label><button className="ls-file ls-audio-file" disabled={locked} onClick={() => void choose("audio")}><span><strong>{draft.audio ? basename(draft.audio) : "选择配音音频"}</strong><small>声音克隆、配音成品或本地音频</small></span><b>＋</b></button>
      <div className="ls-audio-shortcuts"><button className="ls-link" disabled={locked || !latestAudio} onClick={() => update({ audio: latestAudio })}>使用刚生成的声音</button><button className="ls-link" disabled={locked} onClick={() => void action("刷新声音", refresh)}>刷新</button></div>
      <select aria-label="使用配音作品" value="" disabled={locked} onChange={event => update({ audio: event.target.value })}><option value="" disabled>从配音作品中选择…</option>{history.filter(item => item.audioPath).slice(0, 80).map(item => <option value={item.audioPath} key={item.id}>{item.projectName || "单条声音"} · {(item.text || basename(item.audioPath)).slice(0, 24)} · {duration(item.duration)}</option>)}</select>
      {draft.audio && <audio key={draft.audio} src={media(draft.audio)} controls preload="metadata" />}
      {draft.mode === "video" && <><label className="ls-label" htmlFor="ls-short-video">配音比视频长时</label><select id="ls-short-video" disabled={locked} value={draft.shortVideo} onChange={event => update({ shortVideo: event.target.value as Draft["shortVideo"] })}><option value="loop">循环原视频</option><option value="hold">停留在最后一帧</option></select></>}
      <label className="ls-label" htmlFor="ls-model-version">视频模型</label><select id="ls-model-version" disabled={locked} value={draft.modelVersion} onChange={event => update({ modelVersion: event.target.value as ModelVersion })}><option value="auto">自动选择 · 按硬件与空闲显存</option><option value="1.5">1.5 · 轻量 · 256px</option><option value="1.6">1.6 · 高清 · 512px · 16 GB 起</option></select>
      {status && <div className="ls-hardware"><span>{status.hardware.name}</span><span>显存 {(status.hardware.totalMB / 1024).toFixed(1)} GB · 当前空闲 {(status.hardware.freeMB / 1024).toFixed(1)} GB</span><p>{status.selectionReason}</p><button className="ls-link" disabled={locked} onClick={() => void action("检测硬件", refresh)}>重新检测</button></div>}
      <label className="ls-label" htmlFor="ls-quality">生成质量</label><select id="ls-quality" disabled={locked} value={draft.steps} onChange={event => update({ steps: Number(event.target.value) })}><option value={20}>标准 · 20 步</option><option value={30}>精细 · 30 步</option><option value={50}>高质量 · 50 步（较慢）</option></select><p className="ls-hint">保留完整的 16 帧时序窗口。自动模式遇到 1.6 显存不足时，将回退到已安装的 1.5 并提示。首次加载需要一些时间。</p>
      <details className="ls-advanced"><summary>高级参数与模型</summary><label className="ls-label" htmlFor="ls-guidance">口型引导强度</label><input id="ls-guidance" type="number" min={1} max={3} step={0.1} disabled={locked} value={draft.guidance} onChange={event => update({ guidance: Number(event.target.value) })} /><p className="ls-hint">默认 1.5；提高可能增强口型，也可能增加抖动。</p><label className="ls-label" htmlFor="ls-seed">随机种子</label><input id="ls-seed" type="number" min={0} max={2147483647} disabled={locked} value={draft.seed} onChange={event => update({ seed: Number(event.target.value) })} /><p className="ls-model-path" title={status?.root}>{status?.root || "等待服务连接"}</p><button className="ghost-button" disabled={locked} onClick={() => void configure()}>选择已安装模型目录</button></details>
      <p className="ls-hint ls-bottom-hint">支持 0.32～120 秒配音，输出 MP4。优先使用单人连续镜头；照片模式保留原有姿态。生成时将自动释放语音模型占用的显存。</p>
    </aside></div>
    <footer className="ls-footer"><div className="ls-progress"><span>{running ? task?.statusText || "读取任务状态…" : status?.ready ? "本地模型已就绪" : "请先配置视频模型"}</span><progress max={100} value={running ? task?.completed || 0 : task?.status === "succeeded" ? 100 : 0} /></div><div className="ls-footer-buttons">{running ? <button className="ghost-button" disabled={!!busy || task?.cancelRequested} onClick={() => void action("取消任务", async () => { const next = await request<Task>(backendBaseUrl, `/api/tasks/${taskId}/cancel`, { method: "POST" }); setTask(next); })}>{task?.cancelRequested ? "正在停止…" : "取消任务"}</button> : <button className="primary-button" disabled={locked || !backendBaseUrl || !status?.ready || !source || !draft.audio} onClick={() => void generate()}>{busy || "生成说话视频"}</button>}<button className="ghost-button" disabled={!!busy || !result} onClick={() => void action("保存视频", async () => { if (!result) return; const selected = await window.voxcpmDesktop.saveDialog({ defaultPath: result.outputPath, filters: [{ name: "MP4 视频", extensions: ["mp4"] }] }); if (!selected.canceled && selected.filePath) { await request(backendBaseUrl, "/api/files/save-as", { method: "POST", body: JSON.stringify({ sourcePath: result.outputPath, targetPath: selected.filePath }) }); setNotice(`已保存到 ${selected.filePath}`); } })}>另存为 MP4</button></div></footer>
  </div>;
}
