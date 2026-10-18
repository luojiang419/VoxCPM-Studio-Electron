import { useEffect, useState } from "react";
import { musicRequest, type AssistantConfig, type AssistantProvider } from "./music-api";
import "./music-studio.css";

const presets = [
  ["通用兼容接口", "", "", "chat-completions"],
  ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat", "chat-completions"],
  ["通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "chat-completions"],
  ["SiliconFlow", "https://api.siliconflow.cn/v1", "", "chat-completions"],
  ["Ollama", "http://127.0.0.1:11434/v1", "", "chat-completions"],
  ["Responses兼容接口", "", "", "responses"],
];
export default function AssistantSettings({ backendBaseUrl }: { backendBaseUrl: string }) {
  const [config, setConfig] = useState<AssistantConfig>({ protocol: 1, defaultProviderId: "", autoOptimizeMusic: true, providers: [] });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { let active = true; if (backendBaseUrl) musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings").then(data => { if (active) setConfig(data); }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [backendBaseUrl]);
  const update = (id: string, value: Partial<AssistantProvider>) => setConfig(current => ({ ...current, providers: current.providers.map(p => p.id === id ? { ...p, ...value } : p) }));
  async function perform(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  async function save() { const data = await musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings", { method: "PUT", body: JSON.stringify(config) }); setConfig(data); return data; }
  return <section className="panel-card assistant-settings">
    <div className="panel-head"><div><p className="panel-kicker">AI 助手</p><h3>把灵感，写成适合模型的提示词</h3></div><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => {
      const file = await window.voxcpmDesktop.openDialog({ properties: ["openFile"], filters: [{ name: "已有AI助手配置", extensions: ["json"] }] });
      if (file.canceled || !file.filePaths?.[0]) return;
      setConfig(await musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/import", { method: "POST", body: JSON.stringify({ path: file.filePaths[0] }) })); setMessage("已有助手配置已导入，密钥保留加密存储。");
    })}>导入已有配置</button></div>
    <p className="music-help">音乐创作会自动调用选定助手，按所选音乐模型的官方规则创作歌词、编排风格描述。兼容现有 minimax 助手配置，也支持独立配置。</p>
    <div className="assistant-provider-list">{config.providers.map(provider => <section key={provider.id} className="assistant-provider">
      <div className="assistant-provider-head"><label className="music-switch-label"><input type="checkbox" role="switch" className="music-switch" checked={provider.enabled} disabled={busy} onChange={e => update(provider.id, { enabled: e.target.checked })} /><strong>{provider.name || "新助手"}</strong></label><button className="music-text-button" disabled={busy} onClick={() => setConfig({ ...config, providers: config.providers.filter(p => p.id !== provider.id) })}>移除配置</button></div>
      <div className="form-grid">
        <label className="field"><span>名称</span><input value={provider.name} disabled={busy} onChange={e => update(provider.id, { name: e.target.value })} /></label>
        <label className="field"><span>接口类型</span><select value={provider.apiType} disabled={busy} onChange={e => update(provider.id, { apiType: e.target.value })}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label>
        <label className="field"><span>服务地址</span><input value={provider.baseUrl} disabled={busy} placeholder="https://…/v1" onChange={e => update(provider.id, { baseUrl: e.target.value })} autoComplete="off" /></label>
        <label className="field"><span>模型名称</span><input value={provider.model} disabled={busy} onChange={e => update(provider.id, { model: e.target.value })} placeholder="服务商提供的模型名称" /></label>
        <label className="field"><span>API Key</span><input type="password" value={provider.apiKey || ""} disabled={busy} placeholder={provider.hasApiKey ? "已保存，留空保持原密钥" : "本地无密钥服务可留空"} autoComplete="new-password" onChange={e => update(provider.id, { apiKey: e.target.value, clearKey: false })} /></label>
        <div className="assistant-provider-actions"><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => { await save(); await musicRequest(backendBaseUrl, "/api/assistant/test", { method: "POST", body: JSON.stringify({ providerId: provider.id }) }); setMessage("助手连接成功。"); })}>保存并测试连接</button>{provider.hasApiKey && <button className="music-text-button" disabled={busy} onClick={() => update(provider.id, { clearKey: true, apiKey: "", hasApiKey: false })}>清除已存密钥</button>}</div>
      </div>
    </section>)}</div>
    <div className="assistant-settings-footer"><label className="field"><span>添加助手</span><select value="" disabled={busy || config.providers.length >= 20} onChange={e => {
      if (e.target.value === "") return; const preset = presets[Number(e.target.value)], id = crypto.randomUUID();
      setConfig({ ...config, defaultProviderId: config.defaultProviderId || id, providers: [...config.providers, { id, name: preset[0], baseUrl: preset[1], model: preset[2], apiType: preset[3], enabled: true }] });
    }}><option value="">选择服务类型…</option>{presets.map((p, i) => <option key={p[0]} value={i}>{p[0]}</option>)}</select></label>
    <label className="field"><span>默认助手</span><select value={config.defaultProviderId} disabled={busy} onChange={e => setConfig({ ...config, defaultProviderId: e.target.value })}><option value="">未选择</option>{config.providers.filter(p => p.enabled).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
    <label className="music-switch-label"><input type="checkbox" role="switch" className="music-switch" checked={config.autoOptimizeMusic} disabled={busy} onChange={e => setConfig({ ...config, autoOptimizeMusic: e.target.checked })} />默认开启音乐AI优化</label>
    <button className="primary-button" disabled={busy || !backendBaseUrl} onClick={() => void perform(async () => { await save(); setMessage("AI助手设置已保存。"); })}>{busy ? "处理中…" : "保存助手设置"}</button></div>
    {message && <p className="music-message" role="status">{message}</p>}
  </section>;
}
