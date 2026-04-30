import { startTransition, useEffect, useState, type ReactNode } from "react";

type ThemeMode = "dark" | "light" | "system";
type PageKey = "workspace" | "control" | "overview" | "batch" | "training" | "settings";

type BootstrapState = {
  status: string;
  statusText: string;
  detail: string;
  backendBaseUrl: string;
  backendLogPath: string;
  backendPid: number | null;
  backendRunning: boolean;
  backendStartedAt: number;
  lastBackendExitCode: number | null;
  projectRoot: string;
  appRoot: string;
  dataRoot: string;
  themeSource: ThemeMode;
  systemPrefersDark: boolean;
};

type RuntimeSummary = {
  device: string;
  torch_version: string;
  torch_cuda_build: string;
  cuda_available: boolean;
  gpu_names: string[];
  data_root: string;
  config_path: string;
  lora_root: string;
  cache_dir: string;
  current_model_source: string;
  loaded_lora: string;
  lora_count: number;
  output_dir: string;
  hf_repo_id: string;
  proxy_url: string;
  download_strategy: string;
  ffmpeg_path: string;
  training: TrainingStatus;
};

type ResourceStats = {
  cpuUsagePercent: number;
  systemMemoryTotalMB: number;
  systemMemoryUsedMB: number;
  systemMemoryFreeMB: number;
  systemMemoryUsagePercent: number;
  appMemoryRssMB: number;
  gpuMemorySupported: boolean;
  gpuMemoryUsedMB: number;
  gpuMemoryTotalMB: number;
  gpuMemoryUsagePercent: number;
  gpuMemoryDeviceCount: number;
  backendPid: number | null;
  backendRunning: boolean;
  backendStartedAt: number;
  backendUptimeSec: number;
  platform: string;
  cpuCoreCount: number;
};

type TrainingStatus = {
  running: boolean;
  pid: number | null;
  exit_code: number | null;
  output_dir: string;
  config_path: string;
  command: string[];
  log_length: number;
  log_base_offset: number;
};

type LoraEntry = {
  id: string;
  label: string;
  base_model: string;
  loaded: boolean;
  updated_at: string;
};

type TaskPayload = {
  taskId: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  statusText: string;
  progressText: string;
  error: string;
  result?: Record<string, any>;
};

type SettingsPayload = {
  model_dir: string;
  hf_repo_id: string;
  cache_dir: string;
  zipenhancer_path: string;
  output_dir: string;
  proxy_url: string;
  disable_denoiser: boolean;
  disable_optimize: boolean;
};

type SingleForm = {
  mode: string;
  text: string;
  control: string;
  referenceAudio: string;
  promptText: string;
  selectedLora: string;
  cfgValue: number;
  normalize: boolean;
  denoise: boolean;
  inferenceTimesteps: number;
};

type BatchForm = {
  mode: string;
  batchText: string;
  batchFile: string;
  control: string;
  referenceAudio: string;
  promptText: string;
  selectedLora: string;
  cfgValue: number;
  normalize: boolean;
  denoise: boolean;
  inferenceTimesteps: number;
  outputPrefix: string;
};

type TrainingForm = {
  pretrainedPath: string;
  trainManifest: string;
  valManifest: string;
  learningRate: number;
  numIters: number;
  batchSize: number;
  loraRank: number;
  loraAlpha: number;
  saveInterval: number;
  outputName: string;
  gradAccumSteps: number;
  numWorkers: number;
  logInterval: number;
  validInterval: number;
  weightDecay: number;
  warmupSteps: number;
  maxSteps: number;
  sampleRate: number;
  maxGradNorm: number;
  enableLm: boolean;
  enableDit: boolean;
  enableProj: boolean;
  dropout: number;
  tensorboardPath: string;
  hfModelId: string;
  distribute: boolean;
};

const NAV_ITEMS: Array<{ key: PageKey; label: string }> = [
  { key: "workspace", label: "工作台" },
  { key: "control", label: "运行控制" },
  { key: "overview", label: "概览" },
  { key: "batch", label: "批量" },
  { key: "training", label: "训练" },
  { key: "settings", label: "设置" },
];

const DEFAULT_SETTINGS: SettingsPayload = {
  model_dir: "",
  hf_repo_id: "openbmb/VoxCPM2",
  cache_dir: "",
  zipenhancer_path: "",
  output_dir: "",
  proxy_url: "http://127.0.0.1:7890",
  disable_denoiser: false,
  disable_optimize: false,
};

const DEFAULT_SINGLE_FORM: SingleForm = {
  mode: "声音设计",
  text: "欢迎来到 VoxCPM Studio Electron，本地原生工作台已经准备就绪。",
  control: "",
  referenceAudio: "",
  promptText: "",
  selectedLora: "不使用 LoRA",
  cfgValue: 2,
  normalize: false,
  denoise: false,
  inferenceTimesteps: 10,
};

const DEFAULT_BATCH_FORM: BatchForm = {
  mode: "声音设计",
  batchText: "",
  batchFile: "",
  control: "",
  referenceAudio: "",
  promptText: "",
  selectedLora: "不使用 LoRA",
  cfgValue: 2,
  normalize: false,
  denoise: false,
  inferenceTimesteps: 10,
  outputPrefix: "",
};

const DEFAULT_TRAINING_FORM: TrainingForm = {
  pretrainedPath: "",
  trainManifest: "",
  valManifest: "",
  learningRate: 0.0001,
  numIters: 3000,
  batchSize: 1,
  loraRank: 32,
  loraAlpha: 16,
  saveInterval: 500,
  outputName: "",
  gradAccumSteps: 1,
  numWorkers: 2,
  logInterval: 10,
  validInterval: 500,
  weightDecay: 0,
  warmupSteps: 0,
  maxSteps: 0,
  sampleRate: 24000,
  maxGradNorm: 1,
  enableLm: true,
  enableDit: true,
  enableProj: false,
  dropout: 0,
  tensorboardPath: "",
  hfModelId: "",
  distribute: false,
};

const WORKSPACE_AUDIO_FILTERS = [{ name: "音频文件", extensions: ["wav", "mp3", "flac", "ogg"] }];
const WORKSPACE_CUSTOM_PRESETS_STORAGE_KEY = "voxcpm-electron-workspace-custom-presets";
const DEFAULT_WORKSPACE_CONTROL_PRESETS = [
  "温柔女声，语速平稳，咬字清晰",
  "磁性男声，低沉有力，节奏稳重",
  "轻快自然，像朋友聊天一样放松",
  "广播主持风，清晰正式，停顿自然",
  "新闻播报风，理性克制，吐字准确",
  "科技解说风，专业冷静，逻辑清楚",
  "温暖治愈风，情绪柔和，尾音自然",
  "广告宣传风，热情饱满，感染力强",
  "电商带货风，节奏明快，重点突出",
  "客服引导风，亲切耐心，表达稳定",
  "儿童故事风，生动活泼，富有画面感",
  "纪录片旁白风，沉稳自然，层次分明",
  "游戏配音风，张力明显，情绪外放",
  "动漫少女风，轻盈明亮，可爱自然",
  "动漫少年风，清爽干净，朝气十足",
  "古风叙事风，语气婉转，节奏舒缓",
  "冷静说明风，弱情绪，突出信息",
  "激励演讲风，坚定有力，富有号召感",
  "ASMR 轻声风，贴耳温柔，气声更明显",
  "高端品牌风，克制高级，留白自然",
] as const;

const BATCH_REFERENCE_AUDIO_PLACEHOLDER = "批量做可控克隆或极致克隆时，整批文本会共用同一段参考音频；声音设计模式可留空。";
const BATCH_CONTROL_PLACEHOLDER = "会作用到本次任务中的每一条文本，适合统一人设、统一主播风格。示例：冷静、专业、适合知识解说的中性声线";
const BATCH_PROMPT_TEXT_PLACEHOLDER = "极致克隆模式下整批任务共用同一份参考文本；留空则会在生成前自动识别参考音频文本。";
const BATCH_TEXT_PLACEHOLDER = "一行一条文本；也可以上传 UTF-8 编码的 txt 文件；文本框和文件内容会合并处理。\n示例：\n第一条批量文本\n第二条批量文本";
const BATCH_FILE_PLACEHOLDER = "可选：上传 UTF-8 编码 txt 文件，和上方批量文本一起合并处理。";
const BATCH_OUTPUT_PREFIX_PLACEHOLDER = "用于区分本次任务的输出目录名，方便后续回看。示例：marketing_batch";

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pathTail(value: string) {
  const items = value.split(/[\\/]/).filter(Boolean);
  return items.at(-1) || value;
}

function isAbsolutePath(value: string) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

function resolveLocalPath(targetPath: string, bootstrap: BootstrapState | null) {
  const cleanTarget = (targetPath || "").trim();
  if (!cleanTarget) {
    return "";
  }
  if (isAbsolutePath(cleanTarget)) {
    return cleanTarget;
  }

  const basePath = (bootstrap?.appRoot || bootstrap?.projectRoot || bootstrap?.dataRoot || "").trim();
  if (!basePath) {
    return cleanTarget;
  }

  const normalizedBase = basePath.replace(/\//g, "\\");
  const normalizedTarget = cleanTarget.replace(/\//g, "\\");
  const baseSegments = normalizedBase.split("\\").filter(Boolean);
  const targetSegments = normalizedTarget.split("\\").filter(Boolean);
  const prefix = /^[A-Za-z]:$/.test(baseSegments[0]) ? `${baseSegments.shift()}\\` : normalizedBase.startsWith("\\\\") ? "\\\\" : "";
  const segments = [...baseSegments];

  for (const segment of targetSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }

  return `${prefix}${segments.join("\\")}`;
}

function parentPath(value: string) {
  const normalized = value.replace(/[\\/]+$/, "");
  const lastSlash = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : normalized;
}

function toLocalFileUrl(targetPath: string, bootstrap: BootstrapState | null) {
  const resolved = resolveLocalPath(targetPath, bootstrap);
  if (!resolved) {
    return "";
  }
  const normalized = resolved.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return encodeURI(`file:///${normalized}`);
  }
  if (normalized.startsWith("//")) {
    return encodeURI(`file:${normalized}`);
  }
  return encodeURI(`file://${normalized}`);
}

function formatDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isPendingTask(task: TaskPayload | null) {
  return task?.status === "queued" || task?.status === "running";
}

function inferWorkspaceProgressPercent(task: TaskPayload | null, elapsedSeconds: number) {
  if (!task) {
    return 0;
  }
  if (task.status === "queued") {
    return Math.min(28, 10 + elapsedSeconds * 3);
  }
  if (task.status === "running") {
    return Math.min(96, 35 + elapsedSeconds * 4);
  }
  if (task.status === "succeeded") {
    return 100;
  }
  if (task.status === "failed") {
    return 100;
  }
  return 0;
}

function isCloneMode(mode: string) {
  return mode === "可控克隆" || mode === "极致克隆";
}

function validateSingleForm(form: SingleForm): string | null {
  if (!form.text.trim()) {
    return "请先填写输入文本。";
  }
  if (isCloneMode(form.mode) && !form.referenceAudio.trim()) {
    return "当前模式需要先选择参考音频。";
  }
  return null;
}

function validateBatchForm(form: BatchForm): string | null {
  if (!form.batchText.trim() && !form.batchFile.trim()) {
    return "请先填写批量文本，或选择一个 UTF-8 文本文件。";
  }
  if (isCloneMode(form.mode) && !form.referenceAudio.trim()) {
    return "当前批量模式需要先选择参考音频。";
  }
  return null;
}

function validateTrainingForm(form: TrainingForm): string | null {
  if (!form.pretrainedPath.trim()) {
    return "请先选择预训练模型路径。";
  }
  if (!form.trainManifest.trim()) {
    return "请先选择训练数据清单。";
  }
  return null;
}

async function apiJson(baseUrl: string, path: string, options?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.detail || payload.message || detail;
    } catch (_error) {}
    throw new Error(detail);
  }
  return response.json();
}

function App() {
  const [page, setPage] = useState<PageKey>("workspace");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("voxcpm-electron-theme-mode");
    if (stored === "light" || stored === "system") {
      return stored;
    }
    return "dark";
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSummary | null>(null);
  const [settings, setSettings] = useState<SettingsPayload>(DEFAULT_SETTINGS);
  const [loraItems, setLoraItems] = useState<LoraEntry[]>([]);
  const [singleForm, setSingleForm] = useState<SingleForm>(DEFAULT_SINGLE_FORM);
  const [batchForm, setBatchForm] = useState<BatchForm>(DEFAULT_BATCH_FORM);
  const [trainingForm, setTrainingForm] = useState<TrainingForm>(DEFAULT_TRAINING_FORM);
  const [workspaceTask, setWorkspaceTask] = useState<TaskPayload | null>(null);
  const [batchTask, setBatchTask] = useState<TaskPayload | null>(null);
  const [workspacePreviewUrl, setWorkspacePreviewUrl] = useState("");
  const [workspaceOutputPath, setWorkspaceOutputPath] = useState("");
  const [workspaceStatus, setWorkspaceStatus] = useState("等待生成。");
  const [batchStatus, setBatchStatus] = useState("等待批量任务。");
  const [batchLog, setBatchLog] = useState("");
  const [batchArchivePath, setBatchArchivePath] = useState("");
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null);
  const [resourceStats, setResourceStats] = useState<ResourceStats | null>(null);
  const [trainingLog, setTrainingLog] = useState("");
  const [trainingOffset, setTrainingOffset] = useState(0);
  const [trainingMessage, setTrainingMessage] = useState("等待训练任务。");
  const [globalMessage, setGlobalMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceTaskStartedAt, setWorkspaceTaskStartedAt] = useState(0);
  const [workspaceTaskElapsedSeconds, setWorkspaceTaskElapsedSeconds] = useState(0);
  const [customWorkspacePresets, setCustomWorkspacePresets] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(WORKSPACE_CUSTOM_PRESETS_STORAGE_KEY);
      if (!stored) {
        return [];
      }
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  });

  const backendBaseUrl = bootstrap?.backendBaseUrl ?? "";
  const effectiveTheme = themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;
  const workspaceControlPresets = [
    ...DEFAULT_WORKSPACE_CONTROL_PRESETS,
    ...customWorkspacePresets.filter((item) => !DEFAULT_WORKSPACE_CONTROL_PRESETS.includes(item)),
  ];
  const workspaceReferenceAudioUrl = toLocalFileUrl(singleForm.referenceAudio, bootstrap);

  useEffect(() => {
    document.body.setAttribute("data-theme", effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    localStorage.setItem("voxcpm-electron-theme-mode", themeMode);
    window.voxcpmDesktop.setThemeSource(themeMode);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(customWorkspacePresets));
  }, [customWorkspacePresets]);

  useEffect(() => {
    if (!workspaceTaskStartedAt || !isPendingTask(workspaceTask)) {
      return;
    }

    const syncElapsed = () => {
      setWorkspaceTaskElapsedSeconds(Math.max(0, Math.floor((Date.now() - workspaceTaskStartedAt) / 1000)));
    };

    syncElapsed();
    const timer = window.setInterval(syncElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [workspaceTaskStartedAt, workspaceTask]);

  useEffect(() => {
    let active = true;
    window.voxcpmDesktop.getBootstrapState().then((state) => {
      if (!active) {
        return;
      }
      setBootstrap(state);
      setSystemPrefersDark(Boolean(state.systemPrefersDark));
      setThemeMode((current) => current || state.themeSource || "dark");
    });
    const unsubscribe = window.voxcpmDesktop.onRuntimeEvent((payload) => {
      startTransition(() => {
        setBootstrap(payload);
        setSystemPrefersDark(Boolean(payload.systemPrefersDark));
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!backendBaseUrl) {
      return;
    }
    refreshAll();
  }, [backendBaseUrl]);

  useEffect(() => {
    if (!backendBaseUrl) {
      return;
    }
    const timer = window.setInterval(() => {
      apiJson(backendBaseUrl, "/api/training/status")
        .then((payload) => setTrainingStatus(payload))
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [backendBaseUrl]);

  useEffect(() => {
    if (page !== "control") {
      return;
    }

    let active = true;
    const pullResourceStats = async () => {
      try {
        const payload = await window.voxcpmDesktop.getResourceStats();
        if (active) {
          setResourceStats(payload);
        }
      } catch (_error) {}
    };

    pullResourceStats();
    const timer = window.setInterval(pullResourceStats, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [page, bootstrap?.backendRunning]);

  useEffect(() => {
    if (!backendBaseUrl || page !== "training") {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const payload = await apiJson(backendBaseUrl, `/api/training/log?offset=${trainingOffset}`);
        if (payload.chunk) {
          setTrainingLog((current) => current + payload.chunk);
        }
        setTrainingOffset(payload.next_offset);
        setTrainingStatus(payload.status);
      } catch (_error) {}
    }, 1500);
    return () => window.clearInterval(timer);
  }, [backendBaseUrl, page, trainingOffset]);

  async function refreshAll() {
    if (!backendBaseUrl) {
      return;
    }
    const [runtimePayload, settingsPayload, loraPayload, trainingPayload] = await Promise.all([
      apiJson(backendBaseUrl, "/api/runtime/summary"),
      apiJson(backendBaseUrl, "/api/settings"),
      apiJson(backendBaseUrl, "/api/lora"),
      apiJson(backendBaseUrl, "/api/training/status"),
    ]);
    startTransition(() => {
      setRuntime(runtimePayload);
      setSettings(settingsPayload.settings);
      setLoraItems(loraPayload.items);
      setTrainingStatus(trainingPayload);
      setSingleForm((current) => ({
        ...current,
        selectedLora: loraPayload.defaultValue || current.selectedLora,
      }));
      setBatchForm((current) => ({
        ...current,
        selectedLora: loraPayload.defaultValue || current.selectedLora,
      }));
      setTrainingForm((current) => ({
        ...current,
        pretrainedPath: current.pretrainedPath || settingsPayload.settings.model_dir || "",
      }));
    });
  }

  async function choosePath(mode: "file" | "directory", filters?: Array<{ name: string; extensions: string[] }>) {
    const response = await window.voxcpmDesktop.openDialog({
      properties: mode === "directory" ? ["openDirectory"] : ["openFile"],
      filters,
    });
    return response.canceled ? "" : response.filePaths[0] || "";
  }

  async function pollTask(taskId: string, setter: (task: TaskPayload) => void) {
    while (true) {
      const task = (await apiJson(backendBaseUrl, `/api/tasks/${taskId}`)) as TaskPayload;
      setter(task);
      if (task.status === "succeeded" || task.status === "failed") {
        return task;
      }
      await delay(1000);
    }
  }

  async function handleGenerate() {
    if (!backendBaseUrl) {
      return;
    }
    const validationMessage = validateSingleForm(singleForm);
    if (validationMessage) {
      setWorkspaceStatus(validationMessage);
      return;
    }
    setBusy(true);
    setWorkspaceStatus("已提交生成任务，正在排队。");
    try {
      const task = await apiJson(backendBaseUrl, "/api/tasks/generate-single", {
        method: "POST",
        body: JSON.stringify(singleForm),
      });
      setWorkspaceTaskStartedAt(Date.now());
      setWorkspaceTaskElapsedSeconds(0);
      setWorkspaceTask(task);
      const finalTask = await pollTask(task.taskId, setWorkspaceTask);
      if (finalTask.status === "failed") {
        throw new Error(finalTask.error || finalTask.statusText);
      }
      setWorkspaceStatus(finalTask.statusText);
      setWorkspacePreviewUrl(finalTask.result?.previewUrl || "");
      setWorkspaceOutputPath(finalTask.result?.output_path || "");
      await refreshAll();
    } catch (error) {
      setWorkspaceStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleBatchGenerate() {
    if (!backendBaseUrl) {
      return;
    }
    const validationMessage = validateBatchForm(batchForm);
    if (validationMessage) {
      setBatchStatus(validationMessage);
      return;
    }
    setBusy(true);
    setBatchStatus("已提交批量任务，正在排队。");
    try {
      const task = await apiJson(backendBaseUrl, "/api/tasks/generate-batch", {
        method: "POST",
        body: JSON.stringify(batchForm),
      });
      setBatchTask(task);
      const finalTask = await pollTask(task.taskId, setBatchTask);
      if (finalTask.status === "failed") {
        throw new Error(finalTask.error || finalTask.statusText);
      }
      setBatchStatus(finalTask.statusText);
      setBatchLog(finalTask.result?.log || "");
      setBatchArchivePath(finalTask.result?.archivePath || "");
      await refreshAll();
    } catch (error) {
      setBatchStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecognizePrompt(target: "workspace" | "batch") {
    if (!backendBaseUrl) {
      return;
    }
    const audioPath = target === "workspace" ? singleForm.referenceAudio : batchForm.referenceAudio;
    if (!audioPath) {
      setGlobalMessage("请先选择参考音频。");
      return;
    }
    try {
      const payload = await apiJson(backendBaseUrl, "/api/asr/recognize", {
        method: "POST",
        body: JSON.stringify({ audioPath }),
      });
      if (target === "workspace") {
        setSingleForm((current) => ({ ...current, promptText: payload.text }));
      } else {
        setBatchForm((current) => ({ ...current, promptText: payload.text }));
      }
      setGlobalMessage("参考文本识别完成。");
    } catch (error) {
      setGlobalMessage(String(error));
    }
  }

  async function handleSaveAudio() {
    if (!backendBaseUrl || !workspaceOutputPath) {
      return;
    }
    const result = await window.voxcpmDesktop.saveDialog({
      defaultPath: workspaceOutputPath,
      filters: [{ name: "音频文件", extensions: ["wav"] }],
    });
    if (result.canceled || !result.filePath) {
      return;
    }
    try {
      const payload = await apiJson(backendBaseUrl, "/api/files/save-as", {
        method: "POST",
        body: JSON.stringify({
          sourcePath: workspaceOutputPath,
          targetPath: result.filePath,
        }),
      });
      setWorkspaceStatus(payload.message);
    } catch (error) {
      setWorkspaceStatus(String(error));
    }
  }

  async function handlePickWorkspaceReferenceAudio() {
    const selected = await choosePath("file", WORKSPACE_AUDIO_FILTERS);
    if (selected) {
      setSingleForm((current) => ({ ...current, referenceAudio: selected }));
    }
  }

  function handleApplyWorkspacePreset(preset: string) {
    setSingleForm((current) => ({ ...current, control: preset }));
  }

  function handleAddWorkspacePreset() {
    const cleanPreset = singleForm.control.trim();
    if (!cleanPreset) {
      setGlobalMessage("请先输入要保存为预设的控制指令。");
      return;
    }
    if (workspaceControlPresets.includes(cleanPreset)) {
      setGlobalMessage("这条控制指令已经在预设列表中了。");
      return;
    }
    setCustomWorkspacePresets((current) => [cleanPreset, ...current].slice(0, 20));
    setGlobalMessage("已添加为常用预设。");
  }

  async function handleOpenWorkspaceOutputDirectory() {
    const resolvedOutputPath = resolveLocalPath(workspaceOutputPath, bootstrap);
    const resolvedOutputDir = resolvedOutputPath ? parentPath(resolvedOutputPath) : "";
    const fallbackDir = resolveLocalPath(runtime?.output_dir || "", bootstrap);
    const targetDirectory = resolvedOutputDir || fallbackDir;
    if (!targetDirectory) {
      setWorkspaceStatus("当前还没有可打开的输出目录，请先生成音频。");
      return;
    }

    try {
      const opened = await window.voxcpmDesktop.openPath(targetDirectory);
      if (!opened) {
        throw new Error("打开输出目录失败。");
      }
    } catch (error) {
      setWorkspaceStatus(String(error));
    }
  }

  function handleBrandMarkClick() {
    if (!bootstrap?.backendRunning && !busy) {
      void handleStartService();
    }
  }

  async function handleWarmup() {
    if (!backendBaseUrl) {
      return;
    }
    setBusy(true);
    try {
      const task = await apiJson(backendBaseUrl, "/api/tasks/warmup", { method: "POST" });
      const finalTask = await pollTask(task.taskId, () => undefined);
      if (finalTask.status === "failed") {
        throw new Error(finalTask.error || finalTask.statusText);
      }
      setGlobalMessage(finalTask.statusText);
      await refreshAll();
    } catch (error) {
      setGlobalMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings() {
    if (!backendBaseUrl) {
      return;
    }
    setBusy(true);
    try {
      const payload = await apiJson(backendBaseUrl, "/api/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      setGlobalMessage(payload.message);
      setRuntime(payload.runtime);
    } catch (error) {
      setGlobalMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStartService() {
    setBusy(true);
    setGlobalMessage("正在启动本地服务...");
    try {
      const payload = await window.voxcpmDesktop.startBackend();
      setBootstrap(payload);
      setGlobalMessage(payload.statusText || "本地服务已启动。");
      await refreshAll();
      const stats = await window.voxcpmDesktop.getResourceStats();
      setResourceStats(stats);
    } catch (error) {
      setGlobalMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopService() {
    setBusy(true);
    try {
      const payload = await window.voxcpmDesktop.stopBackend();
      setBootstrap(payload);
      setGlobalMessage(payload.statusText || "本地服务已停止。");
      const stats = await window.voxcpmDesktop.getResourceStats();
      setResourceStats(stats);
    } catch (error) {
      setGlobalMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStartTraining() {
    if (!backendBaseUrl) {
      return;
    }
    const validationMessage = validateTrainingForm(trainingForm);
    if (validationMessage) {
      setTrainingMessage(validationMessage);
      return;
    }
    setBusy(true);
    try {
      const payload = await apiJson(backendBaseUrl, "/api/training/start", {
        method: "POST",
        body: JSON.stringify(trainingForm),
      });
      setTrainingMessage(payload.message);
      setTrainingLog(payload.log || "");
      setTrainingOffset((payload.log || "").length);
      setTrainingStatus(payload.status);
    } catch (error) {
      setTrainingMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopTraining() {
    if (!backendBaseUrl) {
      return;
    }
    try {
      const payload = await apiJson(backendBaseUrl, "/api/training/stop", { method: "POST" });
      setTrainingMessage(payload.message);
      setTrainingLog(payload.log || "");
      setTrainingStatus(payload.status);
    } catch (error) {
      setTrainingMessage(String(error));
    }
  }

  const statusTone =
    bootstrap?.status === "error" || workspaceTask?.status === "failed" || batchTask?.status === "failed"
      ? "error"
      : bootstrap?.status === "ready"
        ? "ready"
        : "pending";

  const summaryStatusTitle = bootstrap?.statusText || "准备中";
  const summaryOutputLabel = runtime?.output_dir ? pathTail(runtime.output_dir) : "待配置";
  const workspaceTaskActive = isPendingTask(workspaceTask);
  const workspaceProgressPercent = inferWorkspaceProgressPercent(workspaceTask, workspaceTaskElapsedSeconds);
  const workspaceStatusTitle = workspaceTask?.status === "queued"
    ? "已提交生成任务，正在排队。"
    : workspaceTask?.status === "running"
      ? "正在根据输入文本进行合成。"
      : workspaceStatus;
  const workspaceShouldShowProgress = workspaceTaskStartedAt > 0 && (workspaceTaskActive || workspaceTask?.status === "succeeded" || workspaceTask?.status === "failed");
  const brandMarkClassName = [
    "brand-mark",
    bootstrap?.backendRunning ? "brand-mark-running" : "",
    !bootstrap?.backendRunning && (busy || bootstrap?.status === "booting") ? "brand-mark-starting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button
            type="button"
            className={brandMarkClassName}
            onClick={handleBrandMarkClick}
            disabled={busy && !bootstrap?.backendRunning}
            title={bootstrap?.backendRunning ? "本地服务运行中" : "点击启动本地服务"}
            aria-label={bootstrap?.backendRunning ? "本地服务运行中" : "点击启动本地服务"}
          >
            VC
          </button>
          <div className="brand-copy">
            <strong>VoxCPM</strong>
            <span>Studio</span>
          </div>
          <div className="nav-list">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`nav-item ${page === item.key ? "nav-item-active" : ""}`}
                onClick={() => setPage(item.key)}
                title={item.label}
              >
                <span className="nav-icon">
                  <NavIcon page={item.key} />
                </span>
                <span className="nav-text">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="workspace">
        {globalMessage ? <div className="notice-banner">{globalMessage}</div> : null}

        <section className="panel-shell">
          {page === "control" ? (
            <div className="control-layout">
              <section className="panel-card control-service-section">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">运行控制</p>
                    <h3>本地服务</h3>
                  </div>
                  <span className={`tiny-pill tiny-pill-${statusTone}`}>{summaryStatusTitle}</span>
                </div>
                <div className="control-status-card">
                  <div>
                    <p className="card-kicker">运行状态</p>
                    <h2>{summaryStatusTitle}</h2>
                    <p>{bootstrap?.detail || "当前尚未拿到本地服务状态。"}</p>
                  </div>
                  <div className="control-action-row">
                    <button type="button" className="primary-button" onClick={handleStartService} disabled={busy || Boolean(bootstrap?.backendRunning)}>
                      启动
                    </button>
                    <button type="button" className="ghost-button" onClick={handleStopService} disabled={busy || !bootstrap?.backendRunning}>
                      停止
                    </button>
                    <button type="button" className="ghost-button" onClick={() => refreshAll()} disabled={busy || !backendBaseUrl}>
                      刷新
                    </button>
                  </div>
                </div>
                <div className="runtime-list runtime-list-large">
                  <div className="runtime-item">
                    <span>服务 PID</span>
                    <strong>{bootstrap?.backendPid ?? "未启动"}</strong>
                  </div>
                  <div className="runtime-item">
                    <span>最近退出码</span>
                    <strong>{bootstrap?.lastBackendExitCode ?? "无"}</strong>
                  </div>
                  <div className="runtime-item">
                    <span>日志文件</span>
                    <strong>{bootstrap?.backendLogPath || "未生成"}</strong>
                  </div>
                  <div className="runtime-item">
                    <span>数据目录</span>
                    <strong>{bootstrap?.dataRoot || "未设置"}</strong>
                  </div>
                </div>
              </section>

              <section className="panel-card control-monitor-section">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">资源监控</p>
                    <h3>系统资源仪表盘</h3>
                  </div>
                </div>
                <div className="dashboard-grid">
                  <DashboardCard title="CPU 占用" value={`${resourceStats?.cpuUsagePercent ?? 0}%`} caption={`${resourceStats?.cpuCoreCount ?? 0} 核`} />
                  <DashboardCard title="内存占用" value={`${resourceStats?.systemMemoryUsagePercent ?? 0}%`} caption={`${resourceStats?.systemMemoryUsedMB ?? 0} / ${resourceStats?.systemMemoryTotalMB ?? 0} MB`} />
                  <DashboardCard
                    title="GPU显存占用"
                    value={resourceStats?.gpuMemorySupported ? `${resourceStats?.gpuMemoryUsagePercent ?? 0}%` : "未检测到"}
                    caption={resourceStats?.gpuMemorySupported
                      ? `${resourceStats?.gpuMemoryUsedMB ?? 0} / ${resourceStats?.gpuMemoryTotalMB ?? 0} MB`
                      : "nvidia-smi 不可用"}
                  />
                  <DashboardCard title="前端进程内存" value={`${resourceStats?.appMemoryRssMB ?? 0} MB`} caption="Electron 主进程 RSS" />
                  <DashboardCard title="服务运行时长" value={`${resourceStats?.backendUptimeSec ?? 0}s`} caption={bootstrap?.backendRunning ? "本地服务运行中" : "本地服务未运行"} />
                </div>
              </section>

              <section className="panel-card control-runtime-section">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">运行参数</p>
                    <h3>运行环境与路径</h3>
                  </div>
                </div>
                <RuntimeList runtime={runtime} large />
              </section>
            </div>
          ) : null}

          {page === "overview" ? (
            <>
              <div className={`notice-banner notice-banner-${statusTone}`}>
                <strong>{summaryStatusTitle}</strong>
                <span>{bootstrap?.detail || "正在等待本地服务启动。"}</span>
              </div>
              <section className="summary-grid">
                <article className="summary-card summary-card-primary">
                  <p className="card-kicker">运行状态</p>
                  <h2>{summaryStatusTitle}</h2>
                  <p>{bootstrap?.detail || "等待本地 API 返回模型信息。"}</p>
                </article>
                <article className="summary-card">
                  <p className="card-kicker">LoRA</p>
                  <h2>{runtime?.lora_count ?? 0}</h2>
                  <p>{runtime?.loaded_lora || "当前使用基础模型"}</p>
                </article>
                <article className="summary-card">
                  <p className="card-kicker">输出目录</p>
                  <h2>{summaryOutputLabel}</h2>
                  <p>{runtime?.output_dir || "可在设置页选择输出目录。"}</p>
                </article>
              </section>
            </>
          ) : null}

                  {page === "workspace" ? (
            <div className="panel-grid workspace-grid">
              <section className="panel-card panel-card-workspace">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">语音工作台</p>
                    <h3>单条生成</h3>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => refreshAll()}>
                    刷新 LoRA / 状态
                  </button>
                </div>
                <div className="workspace-form-scroll">
                  <div className="form-grid">
                    <Field label="生成模式">
                      <select value={singleForm.mode} onChange={(event) => setSingleForm({ ...singleForm, mode: event.target.value })}>
                        <option>声音设计</option>
                        <option>可控克隆</option>
                        <option>极致克隆</option>
                      </select>
                    </Field>
                    <Field label="LoRA">
                      <select value={singleForm.selectedLora} onChange={(event) => setSingleForm({ ...singleForm, selectedLora: event.target.value })}>
                        <option value="不使用 LoRA">不使用 LoRA</option>
                        {loraItems.map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="添加音频参考" full>
                      <div
                        className={`reference-audio-card ${singleForm.referenceAudio ? "reference-audio-card-filled" : "reference-audio-card-empty"}`}
                        role={!singleForm.referenceAudio ? "button" : undefined}
                        tabIndex={!singleForm.referenceAudio ? 0 : undefined}
                        onClick={() => {
                          if (!singleForm.referenceAudio) {
                            void handlePickWorkspaceReferenceAudio();
                          }
                        }}
                        onKeyDown={(event) => {
                          if (!singleForm.referenceAudio && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            void handlePickWorkspaceReferenceAudio();
                          }
                        }}
                      >
                        {singleForm.referenceAudio ? (
                          <>
                            <audio controls src={workspaceReferenceAudioUrl} className="audio-player" />
                            <div className="reference-audio-meta">
                              <strong>{pathTail(singleForm.referenceAudio)}</strong>
                              <span title={singleForm.referenceAudio}>{singleForm.referenceAudio}</span>
                            </div>
                            <div className="reference-audio-actions">
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handlePickWorkspaceReferenceAudio();
                                }}
                              >
                                重新选择
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="reference-audio-empty-state">
                            <strong>点击此处添加音频参考</strong>
                            <span>支持 wav / mp3 / flac / ogg，添加后可直接播放预览。</span>
                          </div>
                        )}
                      </div>
                    </Field>
                    <Field label="参考文本" full hidden={singleForm.mode !== "极致克隆"}>
                      <textarea value={singleForm.promptText} onChange={(event) => setSingleForm({ ...singleForm, promptText: event.target.value })} rows={2} />
                      <div className="inline-actions">
                        <button type="button" className="ghost-button" onClick={() => handleRecognizePrompt("workspace")}>识别参考文本</button>
                      </div>
                    </Field>
                    <Field label="输入文本" full>
                      <textarea value={singleForm.text} onChange={(event) => setSingleForm({ ...singleForm, text: event.target.value })} rows={4} />
                    </Field>
                    <Field label={`CFG 引导强度 ${singleForm.cfgValue.toFixed(1)}`}>
                      <input type="range" min={1} max={3} step={0.1} value={singleForm.cfgValue} onChange={(event) => setSingleForm({ ...singleForm, cfgValue: Number(event.target.value) })} />
                    </Field>
                    <Field label={`推理步数 ${singleForm.inferenceTimesteps}`}>
                      <input type="range" min={1} max={50} step={1} value={singleForm.inferenceTimesteps} onChange={(event) => setSingleForm({ ...singleForm, inferenceTimesteps: Number(event.target.value) })} />
                    </Field>
                    <ToggleRow
                      checked={singleForm.normalize}
                      label="文本规范化"
                      onChange={(checked) => setSingleForm({ ...singleForm, normalize: checked })}
                    />
                    <ToggleRow
                      checked={singleForm.denoise}
                      label="参考音频增强"
                      onChange={(checked) => setSingleForm({ ...singleForm, denoise: checked })}
                    />
                  </div>
                </div>
                <div className="action-row workspace-action-bar">
                  <button type="button" className="primary-button" onClick={handleGenerate} disabled={busy || !backendBaseUrl}>开始生成</button>
                  <button type="button" className="ghost-button" onClick={handleSaveAudio} disabled={!workspaceOutputPath}>另存为音频</button>
                  <button type="button" className="ghost-button" onClick={handleOpenWorkspaceOutputDirectory} disabled={!workspaceOutputPath}>打开输出目录</button>
                </div>
                <div className={`workspace-status-panel ${workspaceTaskActive ? "workspace-status-panel-active" : ""}`}>
                  <p className="status-text">{workspaceStatusTitle}</p>
                  {workspaceShouldShowProgress ? (
                    <div className="workspace-status-meta">
                      <span>{workspaceTaskActive ? "生成计时" : "总耗时"} {formatDuration(workspaceTaskElapsedSeconds)}</span>
                      <strong>{workspaceTaskActive ? `进度 ${workspaceProgressPercent}%` : workspaceTask?.status === "succeeded" ? "进度 100%" : "任务已结束"}</strong>
                    </div>
                  ) : null}
                  {workspaceTaskActive ? (
                    <div className="workspace-progress-track" aria-hidden="true">
                      <span className="workspace-progress-fill" style={{ width: `${workspaceProgressPercent}%` }} />
                    </div>
                  ) : null}
                </div>
              </section>

              <div className="workspace-side-column">
                <section className="panel-card panel-card-preview">
                  <div className="panel-head">
                    <div>
                      <p className="panel-kicker">结果区</p>
                      <h3>预览与输出</h3>
                    </div>
                    {workspaceTask ? <span className="tiny-pill">{workspaceTask.status}</span> : null}
                  </div>
                  <div className="preview-box">
                    {workspacePreviewUrl ? (
                      <audio controls src={`${backendBaseUrl}${workspacePreviewUrl}`} className="audio-player" />
                    ) : (
                      <div className="placeholder-box">生成完成后会在这里预听音频。</div>
                    )}
                  </div>
                </section>

                {singleForm.mode !== "极致克隆" ? (
                  <section className="panel-card panel-card-control-presets">
                    <div className="panel-head">
                      <h3>控制指令</h3>
                    </div>
                    <Field label="控制指令" full>
                      <textarea value={singleForm.control} onChange={(event) => setSingleForm({ ...singleForm, control: event.target.value })} rows={2} />
                      <div className="control-preset-add">
                        <button type="button" className="ghost-button" onClick={handleAddWorkspacePreset}>添加为预设</button>
                      </div>
                    </Field>
                    <div className="preset-module">
                      <div className="preset-module-head">
                        <span className="field-label">常用预设指令</span>
                      </div>
                      <div className="preset-chip-grid">
                        {workspaceControlPresets.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={`preset-chip ${singleForm.control.trim() === preset ? "preset-chip-active" : ""}`}
                            onClick={() => handleApplyWorkspacePreset(preset)}
                            title={preset}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>
                ) : null}
              </div>
            </div>
          ) : null}

          {page === "overview" ? (
            <div className="panel-grid">
              <section className="panel-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">项目概览</p>
                    <h3>运行环境与部署状态</h3>
                  </div>
                  <button type="button" className="primary-button" onClick={handleWarmup} disabled={busy || !backendBaseUrl}>模型预热</button>
                </div>
                <RuntimeList runtime={runtime} large />
              </section>
              <section className="panel-card overview-info-card">
                <p className="panel-kicker">当前说明</p>
                <h3>本地专业工作台</h3>
                <div className="overview-info-copy">
                  <p className="paragraph">这一版已经切到 Electron 原生桌面结构，左侧保持紧凑导航，右侧承载主要创作、批量、训练和设置操作。</p>
                  <p className="paragraph">本地 API 仅绑定到 127.0.0.1，默认深灰暗黑风格，同时保留浅色与跟随系统三种主题模式。</p>
                </div>
                <div className="action-row overview-info-actions">
                  <button type="button" className="ghost-button" onClick={() => backendBaseUrl && window.voxcpmDesktop.openExternal(backendBaseUrl)}>打开 API 地址</button>
                  <button type="button" className="ghost-button" onClick={() => bootstrap?.backendLogPath && window.voxcpmDesktop.openPath(bootstrap.backendLogPath)}>打开后台日志</button>
                </div>
              </section>
            </div>
          ) : null}

          {page === "batch" ? (
            <div className="panel-grid">
              <section className="panel-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">批量生成</p>
                    <h3>整批文本生成</h3>
                  </div>
                </div>
                <div className="form-grid">
                  <Field label="批量模式">
                    <select value={batchForm.mode} onChange={(event) => setBatchForm({ ...batchForm, mode: event.target.value })}>
                      <option>声音设计</option>
                      <option>可控克隆</option>
                      <option>极致克隆</option>
                    </select>
                  </Field>
                  <Field label="LoRA">
                    <select value={batchForm.selectedLora} onChange={(event) => setBatchForm({ ...batchForm, selectedLora: event.target.value })}>
                      <option value="不使用 LoRA">不使用 LoRA</option>
                      {loraItems.map((item) => (
                        <option key={item.id} value={item.id}>{item.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="批量参考音频" full>
                    <PathRow
                      value={batchForm.referenceAudio}
                      placeholder={BATCH_REFERENCE_AUDIO_PLACEHOLDER}
                      onChange={(value) => setBatchForm({ ...batchForm, referenceAudio: value })}
                      onPick={async () => {
                        const selected = await choosePath("file", [{ name: "音频文件", extensions: ["wav", "mp3", "flac", "ogg"] }]);
                        if (selected) {
                          setBatchForm({ ...batchForm, referenceAudio: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="批量控制指令" full hidden={batchForm.mode === "极致克隆"}>
                    <textarea value={batchForm.control} placeholder={BATCH_CONTROL_PLACEHOLDER} onChange={(event) => setBatchForm({ ...batchForm, control: event.target.value })} rows={3} />
                  </Field>
                  <Field label="批量参考文本" full hidden={batchForm.mode !== "极致克隆"}>
                    <textarea value={batchForm.promptText} placeholder={BATCH_PROMPT_TEXT_PLACEHOLDER} onChange={(event) => setBatchForm({ ...batchForm, promptText: event.target.value })} rows={3} />
                    <div className="inline-actions">
                      <button type="button" className="ghost-button" onClick={() => handleRecognizePrompt("batch")}>识别参考文本</button>
                    </div>
                  </Field>
                  <Field label="批量文本" full>
                    <textarea value={batchForm.batchText} placeholder={BATCH_TEXT_PLACEHOLDER} onChange={(event) => setBatchForm({ ...batchForm, batchText: event.target.value })} rows={8} />
                  </Field>
                  <Field label="文本文件" full>
                    <PathRow
                      value={batchForm.batchFile}
                      placeholder={BATCH_FILE_PLACEHOLDER}
                      onChange={(value) => setBatchForm({ ...batchForm, batchFile: value })}
                      onPick={async () => {
                        const selected = await choosePath("file", [{ name: "文本文件", extensions: ["txt"] }]);
                        if (selected) {
                          setBatchForm({ ...batchForm, batchFile: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="输出前缀">
                    <input value={batchForm.outputPrefix} placeholder={BATCH_OUTPUT_PREFIX_PLACEHOLDER} onChange={(event) => setBatchForm({ ...batchForm, outputPrefix: event.target.value })} />
                  </Field>
                  <Field label={`CFG 引导强度 ${batchForm.cfgValue.toFixed(1)}`}>
                    <input type="range" min={1} max={3} step={0.1} value={batchForm.cfgValue} onChange={(event) => setBatchForm({ ...batchForm, cfgValue: Number(event.target.value) })} />
                  </Field>
                  <Field label={`推理步数 ${batchForm.inferenceTimesteps}`}>
                    <input type="range" min={1} max={50} step={1} value={batchForm.inferenceTimesteps} onChange={(event) => setBatchForm({ ...batchForm, inferenceTimesteps: Number(event.target.value) })} />
                  </Field>
                  <ToggleRow checked={batchForm.normalize} label="文本规范化" onChange={(checked) => setBatchForm({ ...batchForm, normalize: checked })} />
                  <ToggleRow checked={batchForm.denoise} label="参考音频增强" onChange={(checked) => setBatchForm({ ...batchForm, denoise: checked })} />
                </div>
                <div className="action-row">
                  <button type="button" className="primary-button" onClick={handleBatchGenerate} disabled={busy || !backendBaseUrl}>执行批量生成</button>
                  <button type="button" className="ghost-button" onClick={() => batchArchivePath && window.voxcpmDesktop.showItemInFolder(batchArchivePath)} disabled={!batchArchivePath}>打开归档位置</button>
                </div>
                <p className="status-text">{batchStatus}</p>
              </section>

              <section className="panel-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">批量结果</p>
                    <h3>日志与归档</h3>
                  </div>
                  {batchTask ? <span className="tiny-pill">{batchTask.status}</span> : null}
                </div>
                <Field label="归档路径" full>
                  <input value={batchArchivePath} readOnly />
                </Field>
                <Field label="批量日志" full>
                  <textarea value={batchLog} readOnly rows={16} />
                </Field>
              </section>
            </div>
          ) : null}

          {page === "training" ? (
            <div className="panel-grid">
              <section className="panel-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">LoRA 微调</p>
                    <h3>训练任务</h3>
                  </div>
                  <span className="tiny-pill">{trainingStatus?.running ? "运行中" : "空闲"}</span>
                </div>
                <div className="form-grid form-grid-compact">
                  <Field label="预训练模型路径" full>
                    <PathRow
                      value={trainingForm.pretrainedPath}
                      onChange={(value) => setTrainingForm({ ...trainingForm, pretrainedPath: value })}
                      onPick={async () => {
                        const selected = await choosePath("directory");
                        if (selected) {
                          setTrainingForm({ ...trainingForm, pretrainedPath: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="训练清单" full>
                    <PathRow
                      value={trainingForm.trainManifest}
                      onChange={(value) => setTrainingForm({ ...trainingForm, trainManifest: value })}
                      onPick={async () => {
                        const selected = await choosePath("file", [{ name: "JSONL 文件", extensions: ["jsonl"] }]);
                        if (selected) {
                          setTrainingForm({ ...trainingForm, trainManifest: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="验证清单" full>
                    <PathRow
                      value={trainingForm.valManifest}
                      onChange={(value) => setTrainingForm({ ...trainingForm, valManifest: value })}
                      onPick={async () => {
                        const selected = await choosePath("file", [{ name: "JSONL 文件", extensions: ["jsonl"] }]);
                        if (selected) {
                          setTrainingForm({ ...trainingForm, valManifest: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="输出名称">
                    <input value={trainingForm.outputName} onChange={(event) => setTrainingForm({ ...trainingForm, outputName: event.target.value })} />
                  </Field>
                  <Field label="HF 模型 ID">
                    <input value={trainingForm.hfModelId} onChange={(event) => setTrainingForm({ ...trainingForm, hfModelId: event.target.value })} />
                  </Field>
                  <NumberField label="学习率" value={trainingForm.learningRate} onChange={(value) => setTrainingForm({ ...trainingForm, learningRate: value })} step={0.0001} />
                  <NumberField label="训练步数" value={trainingForm.numIters} onChange={(value) => setTrainingForm({ ...trainingForm, numIters: value })} step={100} />
                  <NumberField label="Batch Size" value={trainingForm.batchSize} onChange={(value) => setTrainingForm({ ...trainingForm, batchSize: value })} step={1} />
                  <NumberField label="LoRA Rank" value={trainingForm.loraRank} onChange={(value) => setTrainingForm({ ...trainingForm, loraRank: value })} step={1} />
                  <NumberField label="LoRA Alpha" value={trainingForm.loraAlpha} onChange={(value) => setTrainingForm({ ...trainingForm, loraAlpha: value })} step={1} />
                  <NumberField label="保存间隔" value={trainingForm.saveInterval} onChange={(value) => setTrainingForm({ ...trainingForm, saveInterval: value })} step={100} />
                  <NumberField label="梯度累积" value={trainingForm.gradAccumSteps} onChange={(value) => setTrainingForm({ ...trainingForm, gradAccumSteps: value })} step={1} />
                  <NumberField label="Worker 数" value={trainingForm.numWorkers} onChange={(value) => setTrainingForm({ ...trainingForm, numWorkers: value })} step={1} />
                  <NumberField label="日志间隔" value={trainingForm.logInterval} onChange={(value) => setTrainingForm({ ...trainingForm, logInterval: value })} step={1} />
                  <NumberField label="验证间隔" value={trainingForm.validInterval} onChange={(value) => setTrainingForm({ ...trainingForm, validInterval: value })} step={100} />
                  <NumberField label="Weight Decay" value={trainingForm.weightDecay} onChange={(value) => setTrainingForm({ ...trainingForm, weightDecay: value })} step={0.0001} />
                  <NumberField label="Warmup Steps" value={trainingForm.warmupSteps} onChange={(value) => setTrainingForm({ ...trainingForm, warmupSteps: value })} step={1} />
                  <NumberField label="Max Steps" value={trainingForm.maxSteps} onChange={(value) => setTrainingForm({ ...trainingForm, maxSteps: value })} step={100} />
                  <NumberField label="采样率" value={trainingForm.sampleRate} onChange={(value) => setTrainingForm({ ...trainingForm, sampleRate: value })} step={1000} />
                  <NumberField label="最大梯度范数" value={trainingForm.maxGradNorm} onChange={(value) => setTrainingForm({ ...trainingForm, maxGradNorm: value })} step={0.1} />
                  <NumberField label="LoRA Dropout" value={trainingForm.dropout} onChange={(value) => setTrainingForm({ ...trainingForm, dropout: value })} step={0.01} />
                  <Field label="TensorBoard 路径" full>
                    <input value={trainingForm.tensorboardPath} onChange={(event) => setTrainingForm({ ...trainingForm, tensorboardPath: event.target.value })} />
                  </Field>
                  <ToggleRow checked={trainingForm.enableLm} label="启用 LM LoRA" onChange={(checked) => setTrainingForm({ ...trainingForm, enableLm: checked })} />
                  <ToggleRow checked={trainingForm.enableDit} label="启用 DIT LoRA" onChange={(checked) => setTrainingForm({ ...trainingForm, enableDit: checked })} />
                  <ToggleRow checked={trainingForm.enableProj} label="启用投影层 LoRA" onChange={(checked) => setTrainingForm({ ...trainingForm, enableProj: checked })} />
                  <ToggleRow checked={trainingForm.distribute} label="分布式训练" onChange={(checked) => setTrainingForm({ ...trainingForm, distribute: checked })} />
                </div>
                <div className="action-row">
                  <button type="button" className="primary-button" onClick={handleStartTraining} disabled={busy || !backendBaseUrl}>开始训练</button>
                  <button type="button" className="ghost-button" onClick={handleStopTraining} disabled={!trainingStatus?.running}>停止训练</button>
                </div>
                <p className="status-text">{trainingMessage}</p>
              </section>

              <section className="panel-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">训练日志</p>
                    <h3>实时输出</h3>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => trainingStatus?.output_dir && window.voxcpmDesktop.showItemInFolder(trainingStatus.output_dir)} disabled={!trainingStatus?.output_dir}>打开输出目录</button>
                </div>
                <Field label="实时日志" full>
                  <textarea value={trainingLog} readOnly rows={22} />
                </Field>
              </section>
            </div>
          ) : null}

          {page === "settings" ? (
            <div className="panel-grid settings-grid">
              <section className="panel-card">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">系统设置</p>
                    <h3>模型、缓存与输出策略</h3>
                  </div>
                </div>
                <div className="notice-banner">
                  当前桌面版默认把运行数据集中到软件同级 <code>data/</code> 目录：
                  配置写入 <code>data/config</code>，自动生成结果写入 <code>data/outputs</code>，LoRA 训练输出写入 <code>data/lora</code>。
                </div>
                <div className="form-grid">
                  <Field label="本地模型目录" full>
                    <PathRow
                      value={settings.model_dir}
                      onChange={(value) => setSettings({ ...settings, model_dir: value })}
                      onPick={async () => {
                        const selected = await choosePath("directory");
                        if (selected) {
                          setSettings({ ...settings, model_dir: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="Hugging Face 仓库 ID" full>
                    <input value={settings.hf_repo_id} onChange={(event) => setSettings({ ...settings, hf_repo_id: event.target.value })} />
                  </Field>
                  <Field label="缓存目录" full>
                    <PathRow
                      value={settings.cache_dir}
                      onChange={(value) => setSettings({ ...settings, cache_dir: value })}
                      onPick={async () => {
                        const selected = await choosePath("directory");
                        if (selected) {
                          setSettings({ ...settings, cache_dir: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="ZipEnhancer 路径" full>
                    <PathRow
                      value={settings.zipenhancer_path}
                      onChange={(value) => setSettings({ ...settings, zipenhancer_path: value })}
                      onPick={async () => {
                        const selected = await choosePath("directory");
                        if (selected) {
                          setSettings({ ...settings, zipenhancer_path: selected });
                        }
                      }}
                      />
                    </Field>
                  <Field label="输出目录设置" full>
                    <PathRow
                      value={settings.output_dir}
                      onChange={(value) => setSettings({ ...settings, output_dir: value })}
                      onPick={async () => {
                        const selected = await choosePath("directory");
                        if (selected) {
                          setSettings({ ...settings, output_dir: selected });
                        }
                      }}
                    />
                  </Field>
                  <Field label="代理地址" full>
                    <input value={settings.proxy_url} onChange={(event) => setSettings({ ...settings, proxy_url: event.target.value })} />
                  </Field>
                  <ToggleRow checked={settings.disable_denoiser} label="禁用参考音频增强" onChange={(checked) => setSettings({ ...settings, disable_denoiser: checked })} />
                  <ToggleRow checked={settings.disable_optimize} label="禁用模型优化预热" onChange={(checked) => setSettings({ ...settings, disable_optimize: checked })} />
                </div>
                <div className="action-row">
                  <button type="button" className="primary-button" onClick={handleSaveSettings} disabled={busy || !backendBaseUrl}>保存设置</button>
                  <button type="button" className="ghost-button" onClick={() => refreshAll()}>刷新状态</button>
                </div>
              </section>
              <section className="panel-card settings-tools-card">
                <div className="panel-head panel-head-compact">
                  <div>
                    <p className="panel-kicker">界面与工具</p>
                    <h3>主题与快捷入口</h3>
                  </div>
                </div>
                <div className="settings-tool-section">
                  <span className="field-label">界面主题</span>
                  <div className="settings-theme-grid">
                    <button type="button" className={`theme-chip theme-chip-wide ${themeMode === "dark" ? "theme-chip-active" : ""}`} onClick={() => setThemeMode("dark")}>深色模式</button>
                    <button type="button" className={`theme-chip theme-chip-wide ${themeMode === "light" ? "theme-chip-active" : ""}`} onClick={() => setThemeMode("light")}>浅色模式</button>
                    <button type="button" className={`theme-chip theme-chip-wide ${themeMode === "system" ? "theme-chip-active" : ""}`} onClick={() => setThemeMode("system")}>跟随系统</button>
                  </div>
                </div>
                <div className="settings-tool-section">
                  <span className="field-label">桌面工具</span>
                  <div className="settings-tool-grid">
                    <button type="button" className="tool-link tool-link-wide" onClick={() => bootstrap?.backendLogPath && window.voxcpmDesktop.openPath(bootstrap.backendLogPath)}>
                      打开日志
                    </button>
                    <button type="button" className="tool-link tool-link-wide" onClick={() => backendBaseUrl && window.voxcpmDesktop.openExternal(backendBaseUrl)}>
                      打开 API
                    </button>
                    <button type="button" className="tool-link tool-link-wide" onClick={() => bootstrap?.dataRoot && window.voxcpmDesktop.openPath(bootstrap.dataRoot)} disabled={!bootstrap?.dataRoot}>
                      打开数据目录
                    </button>
                  </div>
                </div>
              </section>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function Field(props: {
  label: string;
  full?: boolean;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`field ${props.full ? "field-full" : ""} ${props.hidden ? "field-hidden" : ""}`}>
      <span className="field-label">{props.label}</span>
      {props.children}
    </label>
  );
}

function NumberField(props: { label: string; value: number; step: number; onChange: (value: number) => void }) {
  return (
    <Field label={props.label}>
      <input
        type="number"
        value={props.value}
        step={props.step}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </Field>
  );
}

function ToggleRow(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="toggle-copy">{props.label}</span>
      <span className="toggle-control">
        <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      </span>
    </label>
  );
}

function PathRow(props: { value: string; onChange: (value: string) => void; onPick: () => void; placeholder?: string }) {
  return (
    <div className="path-row">
      <input value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.target.value)} />
      <button type="button" className="ghost-button" onClick={props.onPick}>浏览</button>
    </div>
  );
}

function RuntimeList(props: { runtime: RuntimeSummary | null; large?: boolean }) {
  const runtime = props.runtime;
  const items = runtime
    ? [
        ["设备", runtime.device],
        ["数据目录", runtime.data_root],
        ["配置文件", runtime.config_path],
        ["Torch", runtime.torch_version],
        ["CUDA 构建", runtime.torch_cuda_build],
        ["GPU", runtime.cuda_available ? runtime.gpu_names.join(", ") : "不可用"],
        ["当前模型", runtime.current_model_source],
        ["当前 LoRA", runtime.loaded_lora || "无"],
        ["输出目录", runtime.output_dir],
        ["LoRA 目录", runtime.lora_root],
        ["缓存目录", runtime.cache_dir],
        ["FFmpeg", runtime.ffmpeg_path || "未检测到"],
      ]
    : [];
  return (
    <div className={`runtime-list ${props.large ? "runtime-list-large" : ""}`}>
      {items.map(([label, value]) => (
        <div className="runtime-item" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function NavIcon(props: { page: PageKey }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (props.page) {
    case "workspace":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M4 17V9" />
          <path {...common} d="M9 20V4" />
          <path {...common} d="M15 16v-8" />
          <path {...common} d="M20 13v-2" />
        </svg>
      );
    case "control":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M12 4v7" />
          <path {...common} d="M8 7.5A7 7 0 1 0 16 7.5" />
        </svg>
      );
    case "overview":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M5 18h14" />
          <path {...common} d="M7 15l3-4 3 2 4-6" />
          <circle cx="7" cy="15" r="1.2" fill="currentColor" />
          <circle cx="10" cy="11" r="1.2" fill="currentColor" />
          <circle cx="13" cy="13" r="1.2" fill="currentColor" />
          <circle cx="17" cy="7" r="1.2" fill="currentColor" />
        </svg>
      );
    case "batch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect {...common} x="4" y="5" width="16" height="4" rx="1.5" />
          <rect {...common} x="4" y="10" width="16" height="4" rx="1.5" />
          <rect {...common} x="4" y="15" width="16" height="4" rx="1.5" />
        </svg>
      );
    case "training":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M6 18V8" />
          <path {...common} d="M12 18V5" />
          <path {...common} d="M18 18v-6" />
          <path {...common} d="M4 18h16" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle {...common} cx="12" cy="12" r="3.2" />
          <path {...common} d="M12 4.5v2.1" />
          <path {...common} d="M12 17.4v2.1" />
          <path {...common} d="M4.5 12h2.1" />
          <path {...common} d="M17.4 12h2.1" />
          <path {...common} d="m6.8 6.8 1.5 1.5" />
          <path {...common} d="m15.7 15.7 1.5 1.5" />
          <path {...common} d="m17.2 6.8-1.5 1.5" />
          <path {...common} d="m8.3 15.7-1.5 1.5" />
        </svg>
      );
    default:
      return null;
  }
}

function DashboardCard(props: { title: string; value: string; caption: string }) {
  return (
    <article className="dashboard-card">
      <p className="card-kicker">{props.title}</p>
      <h2>{props.value}</h2>
      <p>{props.caption}</p>
    </article>
  );
}

export default App;
