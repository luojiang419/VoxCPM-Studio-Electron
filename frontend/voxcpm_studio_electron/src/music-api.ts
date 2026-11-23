export async function musicRequest<T = any>(base: string, path: string, options?: RequestInit): Promise<T> {
  if (!base) throw new Error("本地引擎尚未连接");
  const response = await fetch(base + path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await response.json();
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((e: any) => e.msg).join("；") : `请求失败（${response.status}）`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return data;
}
export type AssistantProvider = { id: string; name: string; baseUrl: string; model: string; apiType: string; enabled: boolean; hasApiKey?: boolean; apiKey?: string; clearKey?: boolean };
export type AssistantConfig = { protocol: number; defaultProviderId: string; autoOptimizeMusic: boolean; providers: AssistantProvider[] };
export type MusicBrief = { modelId: string; title?: string; idea: string; requirements: string; lyrics: string; caption: string; captionZh?: string; preserveLyrics: boolean; instrumental: boolean; language: string; duration: number; bpm: number | null; keyScale: string; timeSignature: string; seed: number; providerId: string };
export type MusicDraft = { title: string; caption: string; captionZh?: string; captionNeedsAdaptation?: boolean; lyrics: string; metadata: { bpm: number | null; keyScale: string; language: string; timeSignature: string }; modelId: string; instrumental: boolean; duration: number; seed: number };
export type PromptPacket = { promptId?: string; brief?: MusicBrief; draft: MusicDraft; inputs: Record<string, unknown>; modelId: string; warnings: string[]; canGenerate: boolean; assistantSeconds?: number; assistant?: { id: string; name: string; model: string }; source?: { url: string; skill: string | null; kind: string }; rulesVersion?: string };
export type MusicResult = { title: string; fileName?: string; modelId: string; duration: number; outputPath: string; previewUrl: string; requestPath: string; packet: PromptPacket; report: { elapsedSeconds: number; assistantSeconds: number; sampleRate: number; peakReservedMB?: number } };
