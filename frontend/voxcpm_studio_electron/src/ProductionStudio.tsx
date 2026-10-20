import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DEFAULT_GENERATION_CONFIG, type GenerationConfig, type StudioExport,
  type StudioProject, type StudioRole, type StudioSegment, type StudioTask, type StudioView, type StudioVoice,
} from "./production-types";
import "./production-studio.css";
import RoleAvatar from "./RoleAvatar";
import RoleDeleteDialog from "./RoleDeleteDialog";
import { getRoleAppearance, ROLE_APPEARANCES } from "./role-appearance";

type Props = { backendBaseUrl: string; view?: StudioView; onNavigate?: (view: StudioView) => void; headerTools?: ReactNode; onOpenVoiceDesigner?: (voice?: StudioVoice, edit?: boolean) => void; designerBusy?: boolean };
type IconName = "play" | "pause" | "plus" | "upload" | "download" | "check" | "chevron" | "copy" | "up" | "down" | "trash" | "spark" | "close" | "search" | "folder" | "music" | "mic" | "refresh" | "stop" | "more";
const PATHS: Record<IconName, ReactNode> = {
  play: <path d="m9 5 10 7-10 7Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
  up: <path d="m6 14 6-6 6 6" />,
  down: <path d="m6 10 6 6 6-6" />,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></>,
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  folder: <path d="M3 6h7l2 3h9v11H3ZM3 6V4h7l2 2h8v3" />,
  music: <><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
  refresh: <><path d="M20 8A8 8 0 1 0 20 16M20 3v5h-5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
};
function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>;
}
function IconButton({ icon, label, onClick, disabled, className = "", title }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; className?: string; title?: string }) {
  return <button type="button" className={`ps-icon-button ${className}`} title={title || label} aria-label={label} onClick={onClick} disabled={disabled}><Icon name={icon} /></button>;
}
const COLORS = ROLE_APPEARANCES.map(appearance => appearance.color);
const COLOR_NAMES = ROLE_APPEARANCES.map(appearance => appearance.label);
function warmRoleColor(color: string) {
  return getRoleAppearance(color).color;
}
const PROJECT_KEY = "voxcpm-production-project";
const ROLE_KEY = "voxcpm-production-role:";
const TASK_KEY = "voxcpm-production-task";
const DRAFT_KEY = "voxcpm-production-draft:";
const AUDIO_FILTERS = [{ name: "音频文件", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }];
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const durationText = (value: number) => { const seconds = Number.isFinite(value) ? Math.max(0, value) : 0; return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`; };
const basename = (value: string) => value.split(/[\\/]/).pop() || value;
const dateText = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const ready = (segment: StudioSegment) => !!segment.audioPath && !segment.stale && segment.status === "ready";
const roleStyle = (color: string): CSSProperties => ({ "--ps-role": warmRoleColor(color) } as CSSProperties);
function rememberDraft(project: StudioProject) {
  try { localStorage.setItem(`${DRAFT_KEY}${project.id}`, JSON.stringify(project)); } catch { /* Saving to the backend remains available if browser storage is full. */ }
}
async function readScriptFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { return new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
}

async function request<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error("本地服务尚未连接，请在运行控制中启动服务后重试。");
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } }); }
  catch { throw new Error("无法连接本地服务。项目中的未保存内容仍保留在当前窗口，请恢复服务后重试。"); }
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try { const payload = await response.json(); detail = typeof payload.detail === "string" ? payload.detail : payload.message || detail; } catch { /* Preserve the HTTP error. */ }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function newSegment(roleId: string, text = ""): StudioSegment {
  return { id: uid(), roleId, text, pauseAfterMs: 300, audioPath: "", duration: 0, status: "pending", error: "", fingerprint: "", previewUrl: "", stale: false };
}

export default function ProductionStudio({ backendBaseUrl, view = "editor", onNavigate, headerTools, onOpenVoiceDesigner, designerBusy = false }: Props) {
  const [project, setProject] = useState<StudioProject | null>(null);
  const projectRef = useRef<StudioProject | null>(null);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [voices, setVoices] = useState<StudioVoice[]>([]);
  const [expandedVoiceId, setExpandedVoiceId] = useState("");
  const [loras, setLoras] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [deleteRoleRequest, setDeleteRoleRequest] = useState<{ projectId: string; roleId: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const savedRevision = useRef(0);
  const savePromise = useRef<Promise<StudioProject> | null>(null);
  const initializingBase = useRef<string | null>(null);
  const initializationEpoch = useRef(0);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [task, setTask] = useState<StudioTask | null>(null);
  const [pollError, setPollError] = useState("");
  const [search, setSearch] = useState("");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"auto" | "txt" | "srt">("auto");
  const [exportResult, setExportResult] = useState<StudioExport | null>(null);
  const [deletedSegment, setDeletedSegment] = useState<{ segment: StudioSegment; index: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [audioName, setAudioName] = useState("");
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const taskRunning = task?.status === "running" || task?.status === "queued";
  const locked = !!busy || taskRunning || loading;
  const selectedRole = project?.roles.find(role => role.id === selectedRoleId) || project?.roles[0];
  const roleToDelete = project?.id === deleteRoleRequest?.projectId ? project?.roles.find(role => role.id === deleteRoleRequest?.roleId) : undefined;
  const completed = project?.segments.filter(ready).length || 0;
  const segments = project?.segments || [];
  const totalCharacters = segments.reduce((sum, item) => sum + item.text.length, 0);
  const totalDuration = segments.reduce((sum, item, index) => ready(item) ? sum + item.duration + (index < segments.length - 1 ? item.pauseAfterMs / 1000 : 0) : sum, 0);
  const allReady = segments.length > 0 && completed === segments.length;
  const filteredVoices = voices.filter(voice => `${voice.name} ${voice.tags.join(" ")} ${voice.config.control}`.toLowerCase().includes(voiceSearch.toLowerCase()));
  const audioUrl = (value: string) => value.startsWith("/") ? `${backendBaseUrl}${value}` : value;

  useEffect(() => {
    const dismissActions = (event: Event) => {
      const card = document.querySelector('.ps-voice-card[data-actions-open="true"]');
      if (card && !card.contains(event.target as Node)) setExpandedVoiceId("");
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const toggle = document.querySelector<HTMLButtonElement>('.ps-voice-card[data-actions-open="true"] .ps-voice-more-toggle');
      setExpandedVoiceId(""); toggle?.focus();
    };
    document.addEventListener("pointerdown", dismissActions);
    document.addEventListener("focusin", dismissActions);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissActions);
      document.removeEventListener("focusin", dismissActions);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (project && selectedRoleId && project.roles.some(role => role.id === selectedRoleId)) {
      try { localStorage.setItem(`${ROLE_KEY}${project.id}`, selectedRoleId); } catch { /* 可选的选择记忆失败时仍可正常保存工程。 */ }
    }
  }, [project?.id, selectedRoleId]);

  function acceptProject(next: StudioProject, recoverDraft = false) {
    let recovered = false;
    if (recoverDraft) {
      try {
        const raw = localStorage.getItem(`${DRAFT_KEY}${next.id}`);
        if (raw) {
          const draft = JSON.parse(raw) as StudioProject;
          if (draft.id === next.id && Array.isArray(draft.roles) && Array.isArray(draft.segments)) { next = { ...draft, lastExport: undefined }; recovered = true; }
        }
      } catch { /* A corrupt optional draft must not prevent opening the saved project. */ }
    }
    projectRef.current = next;
    revisionRef.current += 1;
    savedRevision.current = revisionRef.current - (recovered ? 1 : 0);
    setProject(next);
    setRevision(revisionRef.current);
    setSaveState(recovered ? "dirty" : "saved");
    if (recovered) { setNotice("已恢复上次未保存的本地草稿，正在重新保存。请核对文案与角色配置。"); setExportResult(null); }
    setProjects(items => [next, ...items.filter(item => item.id !== next.id)]);
    setSelectedRoleId(current => {
      let remembered = "";
      try { remembered = localStorage.getItem(`${ROLE_KEY}${next.id}`) || ""; } catch { /* 可选的角色选择记忆不影响工程读取。 */ }
      return next.roles.some(role => role.id === current) ? current : next.roles.find(role => role.id === remembered)?.id || next.roles[0]?.id || "";
    });
    localStorage.setItem(PROJECT_KEY, next.id);
  }

  function updateProject(transform: (current: StudioProject) => StudioProject) {
    if (!projectRef.current || locked) return;
    const next = { ...transform(projectRef.current), lastExport: undefined };
    projectRef.current = next;
    rememberDraft(next);
    revisionRef.current += 1;
    setProject(next);
    setRevision(revisionRef.current);
    setSaveState("dirty");
    setExportResult(null);
  }

  async function flushProject(): Promise<StudioProject> {
    if (savePromise.current) await savePromise.current;
    const snapshot = projectRef.current;
    if (!snapshot) throw new Error("请先创建或打开一个项目。");
    const snapshotRevision = revisionRef.current;
    if (snapshotRevision <= savedRevision.current) return snapshot;
    setSaveState("saving");
    const pending = request<StudioProject>(backendBaseUrl, `/api/workspace/projects/${snapshot.id}`, { method: "PUT", body: JSON.stringify(snapshot) });
    savePromise.current = pending;
    try {
      const stored = await pending;
      if (projectRef.current?.id === snapshot.id) {
        savedRevision.current = snapshotRevision;
        // A slow save must never replace text entered after this snapshot.
        if (revisionRef.current === snapshotRevision) { projectRef.current = stored; setProject(stored); setSaveState("saved"); localStorage.removeItem(`${DRAFT_KEY}${snapshot.id}`); }
        else setSaveState("dirty");
        setProjects(items => [stored, ...items.filter(item => item.id !== stored.id)]);
      }
      return revisionRef.current === snapshotRevision ? stored : projectRef.current || stored;
    } catch (cause) { setSaveState("error"); throw cause; }
    finally { if (savePromise.current === pending) savePromise.current = null; }
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }

  async function refreshAssets() {
    const voiceResult = await request<{ items: StudioVoice[] }>(backendBaseUrl, "/api/workspace/voices");
    setVoices(voiceResult.items);
  }

  async function initialize() {
    // React StrictMode replays effects; only one first-launch project may be created.
    if (initializingBase.current === backendBaseUrl) return;
    initializingBase.current = backendBaseUrl;
    const epoch = ++initializationEpoch.current;
    setLoading(true); setError("");
    try {
      const result = await request<{ items: StudioProject[] }>(backendBaseUrl, "/api/workspace/projects");
      if (initializationEpoch.current !== epoch) return;
      setProjects(result.items);
      const remembered = localStorage.getItem(PROJECT_KEY);
      const existing = result.items.find(item => item.id === remembered) || result.items[0];
      const next = existing ? await request<StudioProject>(backendBaseUrl, `/api/workspace/projects/${existing.id}`) : await request<StudioProject>(backendBaseUrl, "/api/workspace/projects", { method: "POST", body: JSON.stringify({ name: "未命名配音项目" }) });
      if (initializationEpoch.current !== epoch) return;
      acceptProject(next, true);
      setExportResult(projectRef.current?.lastExport?.stale ? null : projectRef.current?.lastExport || null);
      const storedTask = localStorage.getItem(TASK_KEY);
      if (storedTask) {
        try {
          const resumed = await request<StudioTask>(backendBaseUrl, `/api/tasks/${storedTask}`);
          setTask(resumed);
          if (resumed.result?.project && resumed.result.project.id === next.id) acceptProject(resumed.result.project);
          if (!["running", "queued"].includes(resumed.status)) localStorage.removeItem(TASK_KEY);
        } catch { localStorage.removeItem(TASK_KEY); }
      }
      await refreshAssets();
      const loraResult = await request<{ items?: Array<{ id: string; label: string }>; loras?: Array<{ id: string; label: string }> }>(backendBaseUrl, "/api/lora").catch(() => null);
      if (loraResult) setLoras(loraResult.items || loraResult.loras || []);
    } catch (cause) { if (initializationEpoch.current === epoch) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (initializationEpoch.current === epoch) { initializingBase.current = null; setLoading(false); } }
  }

  useEffect(() => { if (backendBaseUrl) void initialize(); else { setLoading(false); setError("本地服务尚未连接，请在运行控制中启动服务。"); } }, [backendBaseUrl]);

  useEffect(() => {
    if (!project || revisionRef.current <= savedRevision.current || taskRunning) return;
    const timer = window.setTimeout(() => { void flushProject().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }, 850);
    return () => window.clearTimeout(timer);
  }, [revision, backendBaseUrl, taskRunning]);

  useEffect(() => {
    if (!task?.taskId || !["running", "queued"].includes(task.status)) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try {
        const current = await request<StudioTask>(backendBaseUrl, `/api/tasks/${task.taskId}`);
        if (disposed) return;
        setTask(current); setPollError("");
        if (["succeeded", "failed", "cancelled"].includes(current.status)) {
          localStorage.removeItem(TASK_KEY);
          if (current.result?.project && projectRef.current?.id === current.result.project.id) acceptProject(current.result.project);
          else if (projectRef.current) acceptProject(await request<StudioProject>(backendBaseUrl, `/api/workspace/projects/${projectRef.current.id}`));
          if (current.status === "failed") setError(current.error || current.statusText || "合成失败，请检查模型状态后重试。");
          else setNotice(current.status === "cancelled" ? "任务已暂停，完成的段落已保存。可继续生成剩余段落。" : current.result?.failedCount ? `合成结束，${current.result.failedCount} 段失败，可单独重试。` : "台词合成完成，可以试听或导出作品。");
          await refreshAssets();
          return;
        }
      } catch (cause) { if (!disposed) setPollError(cause instanceof Error ? cause.message : String(cause)); }
      if (!disposed) timer = window.setTimeout(poll, 1100);
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [task?.taskId, backendBaseUrl]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (revisionRef.current > savedRevision.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => () => {
    // Navigation to legacy tools may unmount the editor before its debounce runs.
    if (projectRef.current && revisionRef.current > savedRevision.current) void flushProject().catch(() => undefined);
    audioRef.current?.pause();
  }, [backendBaseUrl]);

  function updateSegment(id: string, changes: Partial<StudioSegment>) {
    updateProject(current => ({ ...current, segments: current.segments.map(segment => segment.id === id ? { ...segment, ...changes, ...(changes.text !== undefined || changes.roleId !== undefined ? { stale: !!segment.audioPath, status: segment.audioPath ? segment.status : "pending" as const, error: "" } : {}) } : segment) }));
  }

  function updateRole(changes: Partial<StudioRole>, invalidate = false) {
    if (!selectedRole) return;
    updateProject(current => ({ ...current, roles: current.roles.map(role => role.id === selectedRole.id ? { ...role, ...changes } : role), segments: invalidate ? current.segments.map(segment => segment.roleId === selectedRole.id && segment.audioPath ? { ...segment, stale: true } : segment) : current.segments }));
  }

  function updateConfig(changes: Partial<GenerationConfig>) {
    if (selectedRole) updateRole({ config: { ...selectedRole.config, ...changes } }, true);
  }

  function removeRole(roleId: string, replacementId: string) {
    const current = projectRef.current;
    if (!current || locked || current.roles.length <= 1 || roleId === replacementId) return;
    const removedRole = current.roles.find(role => role.id === roleId);
    const replacement = current.roles.find(role => role.id === replacementId);
    if (!removedRole || !replacement) return;
    const affectedCount = current.segments.filter(segment => segment.roleId === roleId).length;
    const configChanged = (Object.keys(DEFAULT_GENERATION_CONFIG) as Array<keyof GenerationConfig>).some(key => removedRole.config[key] !== replacement.config[key]);
    const reassign = (segment: StudioSegment): StudioSegment => segment.roleId === roleId ? {
      ...segment, roleId: replacementId, stale: !!segment.audioPath && (segment.stale || configChanged),
      status: segment.audioPath ? segment.status : "pending", error: "",
    } : segment;
    updateProject(value => ({ ...value, roles: value.roles.filter(role => role.id !== roleId), segments: value.segments.map(reassign) }));
    // 尚可撤销的台词也要指向有效角色，避免撤销后保存被后端拒绝。
    setDeletedSegment(value => value ? { ...value, segment: reassign(value.segment) } : null);
    setSelectedRoleId(value => value === roleId || !current.roles.some(role => role.id === value) ? replacementId : value);
    setDeleteRoleRequest(null);
    if (affectedCount) {
      audioRef.current?.pause();
      audioRef.current?.removeAttribute("src");
      audioRef.current?.load();
      setAudioName(""); setAudioTime(0); setAudioDuration(0);
    }
    setNotice(affectedCount ? `已删除「${removedRole.name}」，${affectedCount} 段台词已转给「${replacement.name}」。` : `已删除角色「${removedRole.name}」。`);
  }

  function requestRemoveRole(roleId: string) {
    const current = projectRef.current;
    if (!current || locked || current.roles.length <= 1) return;
    const replacement = current.roles.find(role => role.id !== roleId);
    if (!replacement || !current.roles.some(role => role.id === roleId)) return;
    if (current.segments.some(segment => segment.roleId === roleId)) setDeleteRoleRequest({ projectId: current.id, roleId });
    else removeRole(roleId, replacement.id);
  }

  function addSegment() {
    if (!project || !selectedRole) return;
    updateProject(current => ({ ...current, segments: [...current.segments, newSegment(selectedRole.id)] }));
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".ps-segment:last-child textarea")?.focus(), 50);
  }

  function moveSegment(index: number, direction: number) {
    updateProject(current => { const items = [...current.segments]; const target = index + direction; if (target < 0 || target >= items.length) return current; [items[index], items[target]] = [items[target], items[index]]; return { ...current, segments: items }; });
  }

  function duplicateSegment(segment: StudioSegment, index: number) {
    updateProject(current => { const items = [...current.segments]; items.splice(index + 1, 0, { ...newSegment(segment.roleId, segment.text), pauseAfterMs: segment.pauseAfterMs }); return { ...current, segments: items }; });
  }

  async function chooseAudio(target: "reference" | "background") {
    await run("选择音频", async () => {
      const result = await window.voxcpmDesktop.openDialog({ properties: ["openFile"], filters: target === "background" ? [{ name: "背景音乐（WAV）", extensions: ["wav"] }] : AUDIO_FILTERS });
      if (result.canceled || !result.filePaths?.[0]) return;
      // The dialog holds the edit lock; apply the chosen path directly after it closes.
      const current = projectRef.current;
      if (!current) return;
      const path = result.filePaths[0] as string;
      let next: StudioProject;
      if (target === "background") next = { ...current, backgroundMusic: { ...current.backgroundMusic, path }, lastExport: undefined };
      else next = { ...current, lastExport: undefined, roles: current.roles.map(role => role.id === selectedRole?.id ? { ...role, config: { ...role.config, referenceAudio: path } } : role), segments: current.segments.map(segment => segment.roleId === selectedRole?.id && segment.audioPath ? { ...segment, stale: true } : segment) };
      projectRef.current = next; rememberDraft(next); revisionRef.current += 1; setRevision(revisionRef.current); setProject(next); setSaveState("dirty"); setExportResult(null);
    });
  }

  async function recognizeReference() {
    if (!selectedRole?.config.referenceAudio) return;
    const roleId = selectedRole.id;
    await run("识别参考文本", async () => {
      const result = await request<{ text: string }>(backendBaseUrl, "/api/asr/recognize", { method: "POST", body: JSON.stringify({ audioPath: selectedRole.config.referenceAudio }) });
      const current = projectRef.current;
      if (!current) return;
      const next = { ...current, lastExport: undefined, roles: current.roles.map(role => role.id === roleId ? { ...role, config: { ...role.config, promptText: result.text } } : role), segments: current.segments.map(segment => segment.roleId === roleId && segment.audioPath ? { ...segment, stale: true } : segment) };
      projectRef.current = next; rememberDraft(next); revisionRef.current += 1; setRevision(revisionRef.current); setProject(next); setSaveState("dirty"); setNotice("参考文本识别完成，请核对后生成。"); setExportResult(null);
    });
  }

  async function openProject(id: string) {
    if (!id || id === project?.id) return;
    await run("打开项目", async () => {
      if (projectRef.current) await flushProject();
      const next = await request<StudioProject>(backendBaseUrl, `/api/workspace/projects/${id}`);
      acceptProject(next, true); setExportResult(projectRef.current?.lastExport?.stale ? null : projectRef.current?.lastExport || null); setDeletedSegment(null); audioRef.current?.pause();
    });
  }

  async function createProject() {
    await run("创建项目", async () => {
      if (projectRef.current) await flushProject();
      acceptProject(await request<StudioProject>(backendBaseUrl, "/api/workspace/projects", { method: "POST", body: JSON.stringify({ name: `新配音项目 ${projects.length + 1}` }) }));
      setExportResult(null); setDeletedSegment(null); audioRef.current?.pause();
    });
  }

  async function parseScript(text: string, format: "auto" | "txt" | "srt" = importFormat) {
    if (!text.trim()) { setError("请输入或导入需要配音的文案。"); return; }
    await run("整理台词", async () => {
      const current = await flushProject();
      const next = await request<StudioProject>(backendBaseUrl, `/api/workspace/projects/${current.id}/parse`, { method: "POST", body: JSON.stringify({ text, maxChars: 120, format }) });
      acceptProject(next); setExportResult(null); setImportOpen(false); setImportText(""); setDeletedSegment(null);
      setNotice(`已整理 ${next.segments.length} 段台词、${next.roles.length} 个角色。请为角色配置声音后开始合成。`);
    });
  }

  async function generate(segmentIds?: string[]) {
    await run("提交合成", async () => {
      const current = await flushProject();
      const selected = current.segments.filter(segment => !segmentIds || segmentIds.includes(segment.id));
      if (!selected.length) throw new Error("请先添加台词。");
      if (selected.some(segment => !segment.text.trim())) throw new Error("存在空白台词，请填写或删除后再生成。");
      for (const segment of selected.filter(item => segmentIds || !ready(item))) {
        const role = current.roles.find(item => item.id === segment.roleId);
        if (!role) throw new Error("台词未分配角色，请先选择角色。");
        if (role.config.mode !== "声音设计" && !role.config.referenceAudio) throw new Error(`「${role.name}」使用克隆模式，请先选择参考音频。`);
      }
      const next = await request<StudioTask>(backendBaseUrl, `/api/workspace/projects/${current.id}/generate`, { method: "POST", body: JSON.stringify({ segmentIds, force: !!segmentIds }) });
      setTask(next); setPollError(""); setExportResult(null);
      if (["running", "queued"].includes(next.status)) localStorage.setItem(TASK_KEY, next.taskId);
      else {
        localStorage.removeItem(TASK_KEY);
        if (next.result?.project) acceptProject(next.result.project);
        if (next.status === "failed") throw new Error(next.error || next.statusText || "合成失败，请检查模型后重试。");
        setNotice(next.statusText || "合成任务已结束。");
        await refreshAssets();
      }
    });
  }

  async function cancelTask() {
    if (!task) return;
    await run("请求暂停", async () => { setTask(await request<StudioTask>(backendBaseUrl, `/api/tasks/${task.taskId}/cancel`, { method: "POST" })); });
  }

  async function playAudio(url: string, name: string) {
    const audio = audioRef.current;
    if (!audio || !url) return;
    try {
      if (audio.src !== audioUrl(url)) { audio.src = audioUrl(url); setAudioTime(0); }
      setAudioName(name); await audio.play();
    } catch { setError("音频暂时无法播放，请检查文件是否存在，或重新生成该段音频。"); }
  }

  async function exportProject(preview = false) {
    await run(preview ? "准备整片试听" : "导出作品", async () => {
      const current = await flushProject();
      const result = await request<StudioExport & { project: StudioProject }>(backendBaseUrl, `/api/workspace/projects/${current.id}/export`, { method: "POST", body: JSON.stringify({}) });
      if (result.project) acceptProject(result.project);
      setExportResult(result);
      if (preview) await playAudio(result.previewUrl, `${current.name} · 完整作品`);
      else setNotice("作品已导出：完整 WAV、字幕 SRT 和分段 ZIP 均已就绪。");
      await refreshAssets();
    });
  }

  async function saveExport(sourcePath: string, extension: string) {
    await run("另存作品", async () => {
      const result = await window.voxcpmDesktop.saveDialog({ defaultPath: sourcePath, filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }] });
      if (result.canceled || !result.filePath) return;
      await request(backendBaseUrl, "/api/files/save-as", { method: "POST", body: JSON.stringify({ sourcePath, targetPath: result.filePath }) });
      setNotice(`已保存到 ${result.filePath}`);
    });
  }

  const applyVoice = (voice: StudioVoice) => { updateRole({ config: { ...voice.config } }, true); setNotice(`已将「${voice.name}」应用到「${selectedRole?.name}」。`); };

  const pageTitle = view === "voices" ? "我的音色" : "配音工作台";

  return <div className={`production-studio ps-view-${view}`}>
    <header className="ps-header">
      <div className="ps-title-group"><h1>{pageTitle}</h1></div>
      <div className="ps-header-actions"><span className={`ps-save-state ${saveState}`}><i />{saveState === "saved" ? "所有更改已保存" : saveState === "saving" ? "正在保存…" : saveState === "error" ? "保存失败" : "等待保存"}</span>{saveState === "error" && <button className="ps-button ps-small" onClick={() => void run("保存项目", async () => { await flushProject(); setError(""); })} disabled={locked}>重试保存</button>}<button className="ps-button" onClick={() => void createProject()} disabled={locked}><Icon name="plus" />新建项目</button>{headerTools}</div>
    </header>

    {(error || pollError) && <div className="ps-alert ps-alert-error" role="alert"><span>{error || pollError}</span><div>{!project && <button onClick={() => void initialize()} disabled={loading}>重新连接</button>}<IconButton icon="close" label="关闭提示" onClick={() => { setError(""); setPollError(""); }} /></div></div>}
    {notice && <div className="ps-alert ps-alert-success" role="status"><span><Icon name="check" />{notice}</span><IconButton icon="close" label="关闭提示" onClick={() => setNotice("")} /></div>}

    {loading ? <div className="ps-loading"><div className="ps-loading-ring" /><h2>正在打开创作空间</h2><p>读取本地项目与音色库…</p></div> : !project ? <div className="ps-empty ps-offline"><Icon name="folder" size={34} /><h2>连接本地服务，开始创作</h2><p>启动运行服务后，项目与音色会自动载入。</p><button className="ps-button ps-primary" onClick={() => void initialize()} disabled={loading || !backendBaseUrl}><Icon name="refresh" />重新连接</button></div> : <>
      <div className="ps-project-bar">
        <div className="ps-project-name"><Icon name="folder" size={19} /><input aria-label="项目名称" value={project.name} onChange={event => updateProject(current => ({ ...current, name: event.target.value }))} onBlur={() => { if (!projectRef.current?.name.trim()) updateProject(current => ({ ...current, name: "未命名配音项目" })); }} disabled={locked} maxLength={120} /><span className="ps-project-divider" /><select aria-label="切换项目" value={project.id} disabled={locked} onChange={event => void openProject(event.target.value)}>{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
        <div className="ps-project-actions"><span>{project.roles.length} 个角色<span className="ps-dot">·</span>{segments.length} 段台词</span><button className="ps-button ps-small" disabled={locked} onClick={() => { setImportOpen(true); setImportText(""); }}><Icon name="upload" />导入文案</button></div>
      </div>

      {view === "editor" && <div className="ps-workspace">
        <section className="ps-script-pane" aria-label="台词编辑器">
          <div className="ps-pane-heading"><div><h2>台词编排<span className="ps-count">{segments.length.toString().padStart(2, "0")}</span></h2><p>让每一个角色，都拥有自己的声音。</p></div><button className="ps-button ps-small" onClick={addSegment} disabled={locked}><Icon name="plus" />添加台词</button></div>
          <div className="ps-script-toolbar"><div className="ps-search"><Icon name="search" size={15} /><input aria-label="搜索台词" placeholder="搜索台词或角色…" value={search} onChange={event => setSearch(event.target.value)} /></div><span>{totalCharacters.toLocaleString()} 字<span className="ps-dot">·</span><b>{completed}</b> / {segments.length} 已合成</span></div>
          <div className="ps-segment-list">
            {!segments.length ? <div className="ps-empty ps-editor-empty"><div className="ps-empty-art"><span>01</span><Icon name="mic" size={32} /><span className="ps-empty-line" /></div><span className="ps-eyebrow">A STORY STARTS WITH A VOICE</span><h2>把灵感，变成听得见的故事</h2><p>粘贴文案，自动整理台词与角色。<br />也可以从第一句开始，慢慢打磨每一种表达。</p><div className="ps-empty-actions"><button className="ps-button ps-primary" onClick={() => setImportOpen(true)} disabled={locked}><Icon name="upload" />导入文案</button><button className="ps-button" onClick={addSegment} disabled={locked}><Icon name="plus" />写第一句</button></div><button className="ps-text-button" disabled={locked} onClick={() => void parseScript("{旁白}傍晚的风穿过街角，一段故事正悄悄开始。\n{林夏}你听，这座城市，好像也有自己的声音。\n{陈默}那就把它记录下来。从现在，从这一刻。", "txt")}>用一段双人故事试试看 <Icon name="chevron" size={13} /></button></div> : segments.map((segment, index) => {
              const role = project.roles.find(item => item.id === segment.roleId);
              if (search && !`${segment.text} ${role?.name || ""}`.toLowerCase().includes(search.toLowerCase())) return null;
              return <article className={`ps-segment ${segment.stale ? "ps-segment-stale" : ""} ${ready(segment) ? "ps-segment-ready" : ""}`} key={segment.id} style={roleStyle(role?.color || COLORS[0])}>
                <div className="ps-segment-number">{(index + 1).toString().padStart(2, "0")}</div>
                <div className="ps-segment-content"><div className="ps-segment-top"><select aria-label={`第 ${index + 1} 段角色`} className="ps-role-select" value={segment.roleId} onChange={event => updateSegment(segment.id, { roleId: event.target.value })} disabled={locked}>{project.roles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span className={`ps-segment-status ${segment.stale ? "stale" : segment.status}`}>{segment.stale ? "文案或音色已改 · 待重生成" : ready(segment) ? <><Icon name="check" size={12} />已合成 {durationText(segment.duration)}</> : segment.status === "failed" ? "合成失败" : "待合成"}</span><div className="ps-segment-tools"><IconButton icon="up" label="上移台词" disabled={locked || index === 0} onClick={() => moveSegment(index, -1)} /><IconButton icon="down" label="下移台词" disabled={locked || index === segments.length - 1} onClick={() => moveSegment(index, 1)} /><IconButton icon="copy" label="复制台词" disabled={locked} onClick={() => duplicateSegment(segment, index)} /><IconButton icon="trash" label="删除台词" disabled={locked} onClick={() => { setDeletedSegment({ segment, index }); updateProject(current => ({ ...current, segments: current.segments.filter(item => item.id !== segment.id) })); }} /></div></div>
                <textarea aria-label={`第 ${index + 1} 段台词`} placeholder="输入这一段的台词…" value={segment.text} rows={Math.max(2, Math.min(6, Math.ceil(segment.text.length / 44)))} onChange={event => updateSegment(segment.id, { text: event.target.value })} disabled={locked} />
                {segment.error && !segment.stale && <p className="ps-segment-error">{segment.error}</p>}
                <div className="ps-segment-bottom"><label>段后停顿 <input aria-label={`第 ${index + 1} 段停顿（毫秒）`} type="number" min={0} max={10000} step={100} value={segment.pauseAfterMs} onChange={event => updateSegment(segment.id, { pauseAfterMs: Math.max(0, Math.min(10000, Number(event.target.value))) })} disabled={locked} /><span>ms</span></label><span className="ps-character-count">{segment.text.length} 字</span><button className="ps-inline-button" onClick={() => void playAudio(segment.previewUrl, `第 ${index + 1} 段 · ${role?.name || "角色"}`)} disabled={!ready(segment)}><Icon name="play" size={13} />试听</button><button className="ps-inline-button ps-generate-one" onClick={() => void generate([segment.id])} disabled={locked || !segment.text.trim()}><Icon name={segment.audioPath ? "refresh" : "spark"} size={13} />{segment.audioPath ? "重新生成" : "生成此段"}</button></div></div>
              </article>;
            })}
            {!!segments.length && search && !segments.some(item => `${item.text} ${project.roles.find(role => role.id === item.roleId)?.name || ""}`.toLowerCase().includes(search.toLowerCase())) && <div className="ps-empty ps-search-empty"><Icon name="search" size={26} /><h3>没有找到匹配的台词</h3><button className="ps-text-button" onClick={() => setSearch("")}>清除搜索</button></div>}
            {!!segments.length && !search && <button className="ps-add-line" onClick={addSegment} disabled={locked}><Icon name="plus" size={16} />添加下一句台词</button>}
          </div>
          {deletedSegment && <div className="ps-undo"><span>已删除 1 段台词</span><button disabled={locked} onClick={() => { updateProject(current => { const items = [...current.segments]; items.splice(Math.min(deletedSegment.index, items.length), 0, deletedSegment.segment); return { ...current, segments: items }; }); setDeletedSegment(null); }}>撤销</button><IconButton icon="close" label="关闭撤销提示" onClick={() => setDeletedSegment(null)} /></div>}
          <div className="ps-script-summary"><span><i className="ps-dot-light" />本地创作 · 音频与项目保存在设备上</span><span>已合成时长 {durationText(totalDuration)}</span></div>
        </section>

        <aside className="ps-inspector" aria-label="角色与声音设置">
          <div className="ps-inspector-heading"><h2>角色与声音</h2><span>VOICE DIRECTION</span></div>
          <div className="ps-role-tabs">{project.roles.map(role => <div className={`ps-role-tab-group ${selectedRole?.id === role.id ? "active" : ""}`} key={role.id} style={roleStyle(role.color)}><button className={`ps-role-tab ${selectedRole?.id === role.id ? "active" : ""}`} onClick={() => setSelectedRoleId(role.id)} disabled={locked}><RoleAvatar color={role.color} name={role.name} className="ps-role-tab-avatar" />{role.name}<span>{segments.filter(item => item.roleId === role.id).length}</span></button><IconButton icon="trash" label={`删除角色 ${role.name}`} title={project.roles.length <= 1 ? "至少保留一个角色" : `删除角色 ${role.name}`} className="ps-delete-role" disabled={locked || project.roles.length <= 1} onClick={() => requestRemoveRole(role.id)} /></div>)}<button className="ps-add-role" title="添加角色" aria-label="添加角色" disabled={locked} onClick={() => { const role: StudioRole = { id: uid(), name: `角色 ${project.roles.length + 1}`, color: COLORS[project.roles.length % COLORS.length], config: { ...DEFAULT_GENERATION_CONFIG }, volume: 1, pan: 0 }; updateProject(current => ({ ...current, roles: [...current.roles, role] })); setSelectedRoleId(role.id); }}><Icon name="plus" size={15} /></button></div>
          {selectedRole && <div className="ps-inspector-body">
            <div className="ps-selected-role" style={roleStyle(selectedRole.color)}><div className="ps-role-avatar"><RoleAvatar color={selectedRole.color} name={selectedRole.name} /></div><div><label htmlFor="ps-role-name">当前角色</label><input id="ps-role-name" aria-label="角色名称" value={selectedRole.name} onChange={event => updateRole({ name: event.target.value })} disabled={locked} maxLength={32} /></div><select aria-label="角色颜色" className="ps-color-palette" value={warmRoleColor(selectedRole.color)} onChange={event => updateRole({ color: event.target.value })} disabled={locked}>{COLORS.map((color, index) => <option key={color} value={color}>{COLOR_NAMES[index]}</option>)}</select></div>
            <div className="ps-field"><label>生成模式</label><div className="ps-mode-switch">{(["声音设计", "可控克隆", "极致克隆"] as const).map(mode => <button key={mode} className={selectedRole.config.mode === mode ? "active" : ""} onClick={() => updateConfig({ mode })} disabled={locked}>{mode}</button>)}</div><p className="ps-hint">{selectedRole.config.mode === "声音设计" ? "用自然语言描述音色、情绪和表达方式。" : selectedRole.config.mode === "可控克隆" ? "以参考音色为基础，自由控制表达风格。" : "参考音频与逐字文本配合，还原声音特征。"}</p></div>
            {selectedRole.config.mode !== "声音设计" && <><div className="ps-field"><label>参考音频 <span>本地文件</span></label><button className={`ps-file-picker ${selectedRole.config.referenceAudio ? "has-file" : ""}`} onClick={() => void chooseAudio("reference")} disabled={locked}><Icon name={selectedRole.config.referenceAudio ? "music" : "upload"} size={19} /><span>{selectedRole.config.referenceAudio ? basename(selectedRole.config.referenceAudio) : "选择参考音频"}<small>{selectedRole.config.referenceAudio ? "点击更换音频" : "WAV / MP3 / FLAC / OGG"}</small></span><Icon name="chevron" size={14} /></button></div><div className="ps-field"><label htmlFor="ps-prompt-text">参考文本{selectedRole.config.mode === "极致克隆" ? <span>留空自动识别</span> : <span>可选</span>}<button className="ps-text-button" disabled={locked || !selectedRole.config.referenceAudio} onClick={() => void recognizeReference()}>自动识别</button></label><textarea id="ps-prompt-text" placeholder="参考音频中实际说出的内容…" rows={3} value={selectedRole.config.promptText} onChange={event => updateConfig({ promptText: event.target.value })} disabled={locked} /></div></>}
            {selectedRole.config.mode !== "极致克隆" && <div className="ps-field"><label htmlFor="ps-control">声音描述<span>风格 / 情绪 / 语速</span></label><textarea id="ps-control" className="ps-control-input" placeholder="例如：温暖沉稳的女声，像在讲述一段珍贵的回忆，语气自然，停顿从容。" value={selectedRole.config.control} onChange={event => updateConfig({ control: event.target.value })} rows={4} disabled={locked} /><div className="ps-preset-chips">{["温暖叙事", "清晰解说", "自然对话"].map((name, index) => <button key={name} disabled={locked} onClick={() => updateConfig({ control: ["温暖沉稳，娓娓道来，停顿从容自然", "清晰专业的解说音色，吐字准确，节奏平稳", "像朋友聊天一样自然放松，语气轻快，情绪真诚"][index] })}>{name}</button>)}</div></div>}
            <div className="ps-voice-quick"><div className="ps-subheading"><span>我的音色</span><button className="ps-text-button" onClick={() => onNavigate?.("voices")}>管理音色<Icon name="chevron" size={12} /></button></div>{voices.length ? <select aria-label="应用已保存音色" defaultValue="" onChange={event => { const voice = voices.find(item => item.id === event.target.value); if (voice) applyVoice(voice); event.target.value = ""; }} disabled={locked}><option value="" disabled>选择音色，应用到当前角色</option>{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.config.mode}</option>)}</select> : <p className="ps-hint">在声音设计与克隆中创建音色，保存后即可反复使用。</p>}<button className="ps-button ps-small ps-open-voice-designer" disabled={locked || designerBusy || !onOpenVoiceDesigner} onClick={() => onOpenVoiceDesigner?.()}><Icon name="plus" size={13} />设计新音色</button></div>
            <details className="ps-advanced"><summary>合成参数<span>精细调整 <Icon name="down" size={13} /></span></summary><div className="ps-advanced-content"><div className="ps-field"><label htmlFor="ps-lora">LoRA 模型</label><select id="ps-lora" value={selectedRole.config.selectedLora} onChange={event => updateConfig({ selectedLora: event.target.value })} disabled={locked}><option value="不使用 LoRA">不使用 LoRA</option>{!loras.some(item => item.id === selectedRole.config.selectedLora) && selectedRole.config.selectedLora !== "不使用 LoRA" && <option value={selectedRole.config.selectedLora}>{selectedRole.config.selectedLora}</option>}{loras.map(item => <option value={item.id} key={item.id}>{item.label || item.id}</option>)}</select></div><div className="ps-slider-field"><label htmlFor="ps-cfg">引导强度 CFG <strong>{selectedRole.config.cfgValue.toFixed(1)}</strong></label><input id="ps-cfg" type="range" min={1} max={3} step={0.1} value={selectedRole.config.cfgValue} onChange={event => updateConfig({ cfgValue: Number(event.target.value) })} disabled={locked} /></div><div className="ps-slider-field"><label htmlFor="ps-steps">推理步数 <strong>{selectedRole.config.inferenceTimesteps}</strong></label><input id="ps-steps" type="range" min={4} max={50} step={1} value={selectedRole.config.inferenceTimesteps} onChange={event => updateConfig({ inferenceTimesteps: Number(event.target.value) })} disabled={locked} /></div><label className="ps-checkbox"><input type="checkbox" checked={selectedRole.config.normalize} onChange={event => updateConfig({ normalize: event.target.checked })} disabled={locked} />文本规范化</label><label className="ps-checkbox"><input type="checkbox" checked={selectedRole.config.denoise} onChange={event => updateConfig({ denoise: event.target.checked })} disabled={locked} />参考音频降噪</label></div></details>
            <details className="ps-advanced"><summary>混音与背景音乐<span>导出时生效 <Icon name="down" size={13} /></span></summary><div className="ps-advanced-content"><div className="ps-slider-field"><label htmlFor="ps-role-volume">角色音量 <strong>{Math.round(selectedRole.volume * 100)}%</strong></label><input id="ps-role-volume" type="range" min={0} max={2} step={0.05} value={selectedRole.volume} onChange={event => updateRole({ volume: Number(event.target.value) })} disabled={locked} /></div><div className="ps-slider-field"><label htmlFor="ps-role-pan">角色声像 <strong>{selectedRole.pan === 0 ? "居中" : `${selectedRole.pan < 0 ? "左" : "右"} ${Math.round(Math.abs(selectedRole.pan) * 100)}%`}</strong></label><input id="ps-role-pan" type="range" min={-1} max={1} step={0.05} value={selectedRole.pan} onChange={event => updateRole({ pan: Number(event.target.value) })} disabled={locked} /></div><button className="ps-file-picker ps-bgm-picker" disabled={locked} onClick={() => void chooseAudio("background")}><Icon name="music" size={17} /><span>{project.backgroundMusic.path ? basename(project.backgroundMusic.path) : "添加背景音乐"}</span><Icon name="plus" size={14} /></button>{project.backgroundMusic.path && <><div className="ps-slider-field"><label htmlFor="ps-bgm-volume">背景音量 <strong>{Math.round(project.backgroundMusic.volume * 100)}%</strong></label><input id="ps-bgm-volume" type="range" min={0} max={1} step={0.01} value={project.backgroundMusic.volume} onChange={event => updateProject(current => ({ ...current, backgroundMusic: { ...current.backgroundMusic, volume: Number(event.target.value) } }))} disabled={locked} /></div><button className="ps-text-button" disabled={locked} onClick={() => updateProject(current => ({ ...current, backgroundMusic: { ...current.backgroundMusic, path: "" } }))}>移除背景音乐</button></>}</div></details>
          </div>}
        </aside>
      </div>}

      {view === "voices" && <section className="ps-library"><div className="ps-library-heading"><div><h2>收藏你的声音灵感<span>{voices.length} 个音色</span></h2><p>在声音设计与克隆中收藏参考音或生成音色，在这里试听、编辑并应用到配音角色。</p></div><div className="ps-library-tools"><button className="ps-button ps-small ps-create-voice" disabled={locked || designerBusy || !onOpenVoiceDesigner} onClick={() => onOpenVoiceDesigner?.()}><Icon name="plus" size={14} />设计新音色</button><div className="ps-search"><Icon name="search" /><input aria-label="搜索音色" value={voiceSearch} onChange={event => setVoiceSearch(event.target.value)} placeholder="搜索名称、标签或声音描述" /></div></div></div><div className="ps-library-target"><span>目标角色</span><select aria-label="选择应用音色的角色" value={selectedRole?.id || ""} onChange={event => setSelectedRoleId(event.target.value)} disabled={locked}>{project.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select><button className="ps-text-button" onClick={() => onNavigate?.("editor")}>前往配音工作台<Icon name="chevron" size={12} /></button></div>{filteredVoices.length ? <div className="ps-voice-grid">{filteredVoices.map(voice => <article className="ps-voice-card" data-actions-open={expandedVoiceId === voice.id} key={voice.id} style={roleStyle(getRoleAppearance(voice.id).color)}>
          <div className="ps-voice-card-top">
            <button className="ps-voice-avatar ps-voice-preview" disabled={!voice.previewUrl} aria-label={`试听 ${voice.name}`} title={voice.previewUrl ? "试听音色" : "暂无试听音频"} onClick={() => voice.previewUrl && void playAudio(voice.previewUrl, voice.name)}>
              <RoleAvatar color={getRoleAppearance(voice.id).color} name={voice.name} />
              {voice.previewUrl && <span className="ps-voice-preview-icon"><Icon name="play" size={10} /></span>}
              <span className="ps-sr-only">试听</span>
            </button>
            <div className="ps-voice-identity"><h3 title={voice.name}>{voice.name}</h3><span>{voice.sourceMode || voice.config.mode}</span></div>
            <button type="button" className="ps-icon-button ps-voice-more-toggle" aria-label={`更多操作 ${voice.name}`} aria-expanded={expandedVoiceId === voice.id} aria-controls={`voice-actions-${voice.id}`} title="更多操作" onClick={() => setExpandedVoiceId(current => current === voice.id ? "" : voice.id)}><Icon name="more" size={18} /></button>
          </div>
          <p>{voice.config.control || (voice.config.referenceAudio ? `参考音频：${basename(voice.config.referenceAudio)}` : "使用模型默认表达")}</p>
          <div className="ps-voice-tags">{voice.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
          {expandedVoiceId === voice.id && <div id={`voice-actions-${voice.id}`} className="ps-voice-more-actions" aria-label="更多音色操作">
            <button disabled={locked || designerBusy || !onOpenVoiceDesigner} onClick={() => { setExpandedVoiceId(""); onOpenVoiceDesigner?.(voice); }}><Icon name="spark" size={14} />继续设计</button>
            <button className="ps-voice-delete" aria-label={`删除音色 ${voice.name}`} disabled={locked} onClick={() => { setExpandedVoiceId(""); void run("删除音色", async () => { await request(backendBaseUrl, `/api/workspace/voices/${voice.id}`, { method: "DELETE" }); setVoices(items => items.filter(item => item.id !== voice.id)); setNotice(`已删除音色「${voice.name}」。项目里已使用的配置继续保留。`); }); }}><Icon name="trash" size={14} />删除音色</button>
          </div>}
          <div className="ps-voice-card-meta"><time>{dateText(voice.createdAt)}</time></div>
          <div className="ps-voice-card-footer ps-voice-card-actions">
            <button className="ps-button ps-small" disabled={locked || designerBusy || !onOpenVoiceDesigner} onClick={() => onOpenVoiceDesigner?.(voice, true)}>编辑音色</button>
            <button className="ps-button ps-small ps-primary" disabled={locked} title={`应用到「${selectedRole?.name || "当前角色"}」`} onClick={() => applyVoice(voice)}>应用音色<Icon name="chevron" size={12} /></button>
          </div>
        </article>)}</div> : <div className="ps-empty ps-library-empty"><Icon name="mic" size={37} /><h2>{voiceSearch ? "没有找到匹配的音色" : "为喜欢的声音，留一个位置"}</h2><p>{voiceSearch ? "试试另一个关键词。" : "在「声音设计与克隆」中保存参考音或设计音色，即可在这里编辑和应用。"}</p><button className="ps-button" disabled={!voiceSearch && (locked || designerBusy || !onOpenVoiceDesigner)} onClick={() => voiceSearch ? setVoiceSearch("") : onOpenVoiceDesigner?.()}>{voiceSearch ? "清除搜索" : "设计新音色"}</button></div>}</section>}


      <footer className="ps-production-footer">
        {taskRunning && <div className="ps-task-progress" role="status"><div><span className="ps-live-dot" /><strong>{task.cancelRequested ? "将在当前段结束后暂停" : task.statusText || "正在合成"}</strong><span>{task.progressText}</span><b>{task.completed || 0} / {task.total || segments.length}</b></div><progress value={task.completed || 0} max={task.total || segments.length || 1} /></div>}
        {!taskRunning && exportResult && <div className="ps-export-ready"><span><Icon name="check" size={14} />作品导出就绪</span><button disabled={locked} onClick={() => void saveExport(exportResult.outputPath, "wav")}>保存 WAV</button><button disabled={locked} onClick={() => void saveExport(exportResult.srtPath, "srt")}>保存字幕 SRT</button><button disabled={locked} onClick={() => void saveExport(exportResult.archivePath, "zip")}>保存分段 ZIP</button><IconButton icon="folder" label="打开导出位置" onClick={() => void window.voxcpmDesktop.showItemInFolder(exportResult.outputPath)} /><IconButton icon="close" label="收起导出结果" onClick={() => setExportResult(null)} /></div>}
        <div className="ps-transport"><div className="ps-player"><button className={`ps-play-button ${playing ? "playing" : ""}`} aria-label={playing ? "暂停播放" : "播放音频"} onClick={() => { if (playing) audioRef.current?.pause(); else if (audioRef.current?.src) void audioRef.current.play().catch(() => setError("音频播放失败，请重新选择试听内容。")); else void exportProject(true); }} disabled={!audioName && (!allReady || locked)}><Icon name={playing ? "pause" : "play"} size={18} /></button><div className="ps-now-playing"><strong>{audioName || "准备好，听听你的作品"}</strong><span>{audioName ? `${durationText(audioTime)} / ${durationText(audioDuration)}` : `${completed} 段已合成 · ${durationText(totalDuration)}`}</span></div></div><div className="ps-timeline" aria-label="作品段落进度">{segments.length ? segments.map((segment, index) => <button key={segment.id} style={{ ...roleStyle(project.roles.find(role => role.id === segment.roleId)?.color || COLORS[0]), flex: Math.max(1, Math.min(10, segment.text.length / 12)) }} className={ready(segment) ? "ready" : segment.stale ? "stale" : ""} title={`第 ${index + 1} 段 · ${ready(segment) ? durationText(segment.duration) : "待合成"}`} disabled={!ready(segment)} onClick={() => void playAudio(segment.previewUrl, `第 ${index + 1} 段`)}><span /></button>) : <div className="ps-empty-timeline"><span /><span /><span /><span /><span /><span /><span /></div>}</div><div className="ps-footer-actions"><button className="ps-button" disabled={!allReady || locked} onClick={() => void exportProject(true)}><Icon name="play" size={14} />整片试听</button>{taskRunning ? <button className="ps-button ps-primary" disabled={!!busy || task.cancelRequested} onClick={() => void cancelTask()}><Icon name="pause" size={15} />{task.cancelRequested ? "等待当前段完成" : "暂停任务"}</button> : <button className="ps-button ps-primary" disabled={locked || !segments.length || allReady} onClick={() => void generate()}><Icon name="spark" size={16} />{busy || (allReady ? "全部合成完成" : completed ? `继续合成 ${segments.length - completed} 段` : "开始合成")}</button>}<button className="ps-button ps-export-button" disabled={locked || !allReady} onClick={() => void exportProject()}><Icon name="download" size={15} />导出</button></div></div>
        {audioName && <input className="ps-audio-seek" aria-label="试听播放进度" type="range" min={0} max={audioDuration || 1} step={0.1} value={Math.min(audioTime, audioDuration || 1)} onChange={event => { if (audioRef.current) { audioRef.current.currentTime = Number(event.target.value); setAudioTime(Number(event.target.value)); } }} />}
      </footer>
    </>}

    <audio ref={audioRef} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => setAudioTime(audioRef.current?.currentTime || 0)} onLoadedMetadata={() => setAudioDuration(audioRef.current?.duration || 0)} onError={() => { if (audioRef.current?.src) { setPlaying(false); setError("无法读取试听音频，请检查文件或重新生成。"); } }} />
    {roleToDelete && project && <RoleDeleteDialog key={`${project.id}:${roleToDelete.id}`} role={roleToDelete}
      replacements={project.roles.filter(role => role.id !== roleToDelete.id)} segmentCount={segments.filter(segment => segment.roleId === roleToDelete.id).length}
      locked={locked} onCancel={() => setDeleteRoleRequest(null)} onConfirm={replacementId => {
        if (deleteRoleRequest?.projectId === projectRef.current?.id) removeRole(roleToDelete.id, replacementId);
      }} />}
    {importOpen && <div className="ps-modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !locked) setImportOpen(false); }}><section className="ps-import-modal" role="dialog" aria-modal="true" aria-labelledby="ps-import-title"><div className="ps-modal-heading"><div><span className="ps-eyebrow">SCRIPT IMPORT</span><h2 id="ps-import-title">让故事进入工作台</h2></div><IconButton icon="close" label="关闭导入" onClick={() => setImportOpen(false)} disabled={locked} /></div><p>识别 <code>{"{角色}台词"}</code>、<code>角色：台词</code> 与 SRT 字幕，自动分段并分配角色。</p><div className="ps-import-tools"><button className="ps-button ps-small" onClick={() => importRef.current?.click()} disabled={locked}><Icon name="folder" size={14} />选择 TXT / SRT 文件</button><select aria-label="文案格式" value={importFormat} onChange={event => setImportFormat(event.target.value as "auto" | "txt" | "srt")} disabled={locked}><option value="auto">自动识别格式</option><option value="txt">TXT 文本</option><option value="srt">SRT 字幕</option></select><input ref={importRef} type="file" accept=".txt,.srt,text/plain" hidden onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { setError("文案文件过大，请使用 5 MB 以内的 TXT 或 SRT 文件。"); event.target.value = ""; return; } void readScriptFile(file).then(text => { setImportText(text.replace(/^\uFEFF/, "")); setImportFormat(file.name.toLowerCase().endsWith(".srt") ? "srt" : "txt"); }).catch(() => setError("读取文件失败，请使用 UTF-8 编码的文本文件。")); event.target.value = ""; }} /></div><textarea autoFocus aria-label="待导入文案" placeholder={"{旁白}故事，从一句话开始。\n{主角}你好，很高兴在这里遇见你。"} value={importText} onChange={event => setImportText(event.target.value)} disabled={locked} />{error && <div className="ps-modal-error" role="alert">{error}</div>}<div className="ps-import-footer"><span>{segments.length ? "导入将替换当前项目中的台词，请先确认文案。" : "长段落将自动整理为适合合成的短句。"}</span><button className="ps-button ps-primary" onClick={() => void parseScript(importText)} disabled={locked || !importText.trim()}><Icon name="spark" size={15} />{busy || "整理并导入"}</button></div></section></div>}
  </div>;
}
