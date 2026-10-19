import { useEffect, useRef, useState } from "react";
import { musicRequest, type AssistantConfig, type AssistantProvider } from "./music-api";
import "./music-studio.css";

const presets = [
  ["通用兼容接口", "", "", "chat-completions"],
  ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-flash", "chat-completions"],
  ["通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "chat-completions"],
  ["SiliconFlow", "https://api.siliconflow.cn/v1", "", "chat-completions"],
  ["Ollama", "http://127.0.0.1:11434/v1", "", "chat-completions"],
  ["Responses兼容接口", "", "", "responses"],
];
export default function AssistantSettings({ backendBaseUrl }: { backendBaseUrl: string }) {
  const [config, setConfig] = useState<AssistantConfig>({ protocol: 1, defaultProviderId: "", autoOptimizeMusic: true, providers: [] });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { let active = true; if (backendBaseUrl) musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings").then(data => { if (active) setConfig(data); }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [backendBaseUrl]);
  const [catalogs, setCatalogs] = useState<Record<string, { models: string[]; selected: string; loading: boolean; error: string }>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});
  async function toggleKey(provider: AssistantProvider) {
    if (visibleKeys[provider.id]) {
      setVisibleKeys(current => ({ ...current, [provider.id]: false }));
      setRevealedKeys(current => { const next = { ...current }; delete next[provider.id]; return next; });
      return;
    }
    if (!provider.apiKey && provider.hasApiKey && !provider.clearKey) {
      const data = await musicRequest<{ apiKey: string }>(backendBaseUrl, "/api/assistant/reveal-key", { method: "POST", body: JSON.stringify({ providerId: provider.id }) });
      setRevealedKeys(current => ({ ...current, [provider.id]: data.apiKey }));
    }
    setVisibleKeys(current => ({ ...current, [provider.id]: true }));
  }
  const queried = useRef<Record<string, string>>({});
  const versions = useRef<Record<string, number>>({});
  const fingerprint = (p: AssistantProvider) => JSON.stringify([p.baseUrl, p.apiKey || "", p.hasApiKey, p.clearKey]);
  async function fetchModels(provider: AssistantProvider) {
    const version = (versions.current[provider.id] || 0) + 1;
    versions.current[provider.id] = version;
    queried.current[provider.id] = fingerprint(provider);
    setCatalogs(current => ({ ...current, [provider.id]: { models: [], selected: "", loading: true, error: "" } }));
    try {
      const data = await musicRequest<{ models: string[] }>(backendBaseUrl, "/api/assistant/models", { method: "POST", body: JSON.stringify(provider) });
      if (versions.current[provider.id] !== version) return;
      const selected = data.models.includes(provider.model) ? provider.model : data.models.includes("deepseek-flash") ? "deepseek-flash" : data.models[0];
      setCatalogs(current => ({ ...current, [provider.id]: { models: data.models, selected, loading: false, error: "" } }));
    } catch (error) {
      if (versions.current[provider.id] === version) setCatalogs(current => ({ ...current, [provider.id]: { models: [], selected: "", loading: false, error: (error as Error).message } }));
    }
  }
  useEffect(() => {
    if (!backendBaseUrl) return;
    const timers = config.providers.map(provider => {
      const signature = fingerprint(provider);
      if (queried.current[provider.id] === signature) return;
      versions.current[provider.id] = (versions.current[provider.id] || 0) + 1;
      setCatalogs(current => { const next = { ...current }; delete next[provider.id]; return next; });
      if (!provider.baseUrl.trim() || !(provider.apiKey?.trim() || (provider.hasApiKey && !provider.clearKey))) return;
      return window.setTimeout(() => void fetchModels(provider), 900);
    });
    return () => timers.forEach(timer => { if (timer !== undefined) window.clearTimeout(timer); });
  }, [config.providers, backendBaseUrl]);
  const update = (id: string, value: Partial<AssistantProvider>) => setConfig(current => ({ ...current, providers: current.providers.map(p => p.id === id ? { ...p, ...value } : p) }));
  async function perform(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  async function save(value = config) { const data = await musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings", { method: "PUT", body: JSON.stringify(value) }); setConfig(data); setVisibleKeys({}); setRevealedKeys({}); return data; }
  return <section className="panel-card assistant-settings">
    <div className="panel-head"><div><p className="panel-kicker">AI 助手</p><h3>把灵感，写成适合模型的提示词</h3></div><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => {
      const file = await window.voxcpmDesktop.openDialog({ properties: ["openFile"], filters: [{ name: "已有AI助手配置", extensions: ["json"] }] });
      if (file.canceled || !file.filePaths?.[0]) return;
      setConfig(await musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/import", { method: "POST", body: JSON.stringify({ path: file.filePaths[0] }) })); setMessage("已有助手配置已导入，密钥保留加密存储。");
    })}>导入已有配置</button></div>
    <p className="music-help">配置保存后自动使用默认助手，音乐创作页无需重复选择。音乐创作会调用该助手，按所选音乐模型的官方规则创作歌词、编排风格描述。兼容现有 minimax 助手配置，也支持独立配置。</p>
    <div className="assistant-provider-list">{config.providers.map(provider => <section key={provider.id} className="assistant-provider">
      <div className="assistant-provider-head"><label className="music-switch-label"><input type="checkbox" role="switch" className="music-switch" checked={provider.enabled} disabled={busy} onChange={e => update(provider.id, { enabled: e.target.checked })} /><strong>{provider.name || "新助手"}</strong></label><button className="music-text-button" disabled={busy} onClick={() => setConfig({ ...config, providers: config.providers.filter(p => p.id !== provider.id) })}>移除配置</button></div>
      <div className="form-grid">
        <label className="field"><span>名称</span><input value={provider.name} disabled={busy} onChange={e => update(provider.id, { name: e.target.value })} /></label>
        <label className="field"><span>接口类型</span><select value={provider.apiType} disabled={busy} onChange={e => update(provider.id, { apiType: e.target.value })}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label>
        <label className="field"><span>服务地址</span><input value={provider.baseUrl} disabled={busy} placeholder="https://…/v1" onChange={e => update(provider.id, { baseUrl: e.target.value })} autoComplete="off" /></label>
        <label className="field"><span>模型 ID（可手动填写）</span><input value={provider.model} disabled={busy} onChange={e => update(provider.id, { model: e.target.value })} placeholder="服务商提供的模型名称" /></label>
        <div className="field"><span>可用模型</span><select aria-label={`${provider.name}可用模型`} value={catalogs[provider.id]?.selected || ""} disabled={busy || catalogs[provider.id]?.loading || !catalogs[provider.id]?.models.length} onChange={e => { const selected = e.target.value; setCatalogs(current => ({ ...current, [provider.id]: { ...current[provider.id], selected } })); }}><option value="">{catalogs[provider.id]?.loading ? "正在获取模型…" : "输入密钥后自动获取，也可点击刷新"}</option>{catalogs[provider.id]?.models.map(model => <option key={model} value={model}>{model}</option>)}</select>
          <div className="assistant-provider-actions"><button className="ghost-button" disabled={busy || !provider.baseUrl.trim() || catalogs[provider.id]?.loading} onClick={() => void fetchModels(provider)}>刷新模型列表</button><button className="ghost-button" disabled={busy || !catalogs[provider.id]?.selected} onClick={() => void perform(async () => {
            const model = catalogs[provider.id].selected;
            await save({ ...config, defaultProviderId: provider.id, providers: config.providers.map(p => p.id === provider.id ? { ...p, model, enabled: true } : p) });
            setMessage(`已应用模型 ${model}，并设为默认助手。`);
          })}>应用所选模型</button></div>
          {catalogs[provider.id]?.error && <span className="music-help" role="status">{catalogs[provider.id].error}</span>}
        </div>
        <div className="field"><label htmlFor={`assistant-key-${provider.id}`}>API Key</label><div className="assistant-key-input"><input id={`assistant-key-${provider.id}`} type={visibleKeys[provider.id] ? "text" : "password"} value={provider.apiKey ?? (visibleKeys[provider.id] ? revealedKeys[provider.id] || "" : "")} disabled={busy} placeholder={provider.hasApiKey ? "已保存，留空保持原密钥" : "本地无密钥服务可留空"} autoComplete="new-password" spellCheck={false} onChange={e => update(provider.id, { apiKey: e.target.value, clearKey: false })} /><button type="button" className="music-text-button" aria-label={visibleKeys[provider.id] ? "隐藏 API Key" : "显示 API Key"} title={visibleKeys[provider.id] ? "隐藏密钥" : "查看密钥"} aria-pressed={!!visibleKeys[provider.id]} disabled={busy} onClick={() => void perform(() => toggleKey(provider))}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visibleKeys[provider.id] && <path d="m3 3 18 18" />}</svg></button></div></div>
        <div className="assistant-provider-actions"><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => { await save(); await musicRequest(backendBaseUrl, "/api/assistant/test", { method: "POST", body: JSON.stringify({ providerId: provider.id }) }); setMessage("助手连接成功。"); })}>保存并测试连接</button>{provider.hasApiKey && <button className="music-text-button" disabled={busy} onClick={() => { update(provider.id, { clearKey: true, apiKey: "", hasApiKey: false }); setVisibleKeys(current => ({ ...current, [provider.id]: false })); setRevealedKeys(current => ({ ...current, [provider.id]: "" })); }}>清除已存密钥</button>}</div>
      </div>
    </section>)}</div>
    <div className="assistant-settings-footer"><label className="field"><span>添加助手</span><select value="" disabled={busy || config.providers.length >= 20} onChange={e => {
      if (e.target.value === "") return; const preset = presets[Number(e.target.value)], id = crypto.randomUUID();
      setConfig({ ...config, defaultProviderId: config.defaultProviderId || id, providers: [...config.providers, { id, name: preset[0], baseUrl: preset[1], model: preset[2], apiType: preset[3], enabled: true }] });
    }}><option value="">选择服务类型…</option>{presets.map((p, i) => <option key={p[0]} value={i}>{p[0]}</option>)}</select></label>
    {config.providers.filter(p => p.enabled).length > 1 && <label className="field"><span>默认助手</span><select value={config.defaultProviderId} disabled={busy} onChange={e => setConfig({ ...config, defaultProviderId: e.target.value })}><option value="">未选择</option>{config.providers.filter(p => p.enabled).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>}
    <label className="music-switch-label"><input type="checkbox" role="switch" className="music-switch" checked={config.autoOptimizeMusic} disabled={busy} onChange={e => setConfig({ ...config, autoOptimizeMusic: e.target.checked })} />默认开启音乐AI优化</label>
    <button className="primary-button" disabled={busy || !backendBaseUrl} onClick={() => void perform(async () => { await save(); setMessage("AI助手设置已保存。"); })}>{busy ? "处理中…" : "保存助手设置"}</button></div>
    {message && <p className="music-message" role="status">{message}</p>}
  </section>;
}
