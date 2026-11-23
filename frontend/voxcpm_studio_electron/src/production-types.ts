export type StudioView = "editor" | "voices";

export type GenerationConfig = {
  mode: "声音设计" | "可控克隆" | "极致克隆";
  control: string;
  referenceAudio: string;
  promptText: string;
  selectedLora: string;
  cfgValue: number;
  normalize: boolean;
  denoise: boolean;
  inferenceTimesteps: number;
};

export type StudioRole = {
  id: string;
  name: string;
  color: string;
  config: GenerationConfig;
  volume: number;
  pan: number;
};

export type StudioSegment = {
  id: string;
  roleId: string;
  text: string;
  pauseAfterMs: number;
  audioPath: string;
  duration: number;
  status: "pending" | "ready" | "failed";
  error: string;
  fingerprint: string;
  previewUrl: string;
  stale: boolean;
};

export type StudioExport = {
  outputPath: string;
  archivePath: string;
  srtPath: string;
  previewUrl: string;
  duration: number;
  stale?: boolean;
};

export type StudioProject = {
  id: string;
  name: string;
  roles: StudioRole[];
  segments: StudioSegment[];
  backgroundMusic: { path: string; volume: number };
  createdAt: string;
  updatedAt: string;
  lastExport?: StudioExport;
};

export type StudioVoice = {
  id: string;
  name: string;
  tags: string[];
  config: GenerationConfig;
  createdAt: string;
  sourceMode?: GenerationConfig["mode"];
  designConfig?: GenerationConfig;
  sampleText?: string;
  previewAudio?: string;
  previewUrl?: string;
};

export type StudioHistory = {
  id: string;
  kind: string;
  projectId: string;
  projectName: string;
  segmentId?: string;
  text?: string;
  audioPath: string;
  previewUrl: string;
  createdAt: string;
  duration: number;
  config?: GenerationConfig;
};

export type StudioTask = {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  statusText: string;
  progressText: string;
  completed?: number;
  total?: number;
  cancelRequested?: boolean;
  error?: string;
  result?: { project?: StudioProject; generatedCount?: number; failedCount?: number };
};

export const DEFAULT_GENERATION_CONFIG: GenerationConfig = {
  mode: "声音设计",
  control: "",
  referenceAudio: "",
  promptText: "",
  selectedLora: "不使用 LoRA",
  cfgValue: 2,
  normalize: false,
  denoise: false,
  inferenceTimesteps: 10,
};
