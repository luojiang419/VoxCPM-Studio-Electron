import { useEffect, useRef, useState } from "react";
import { musicRequest, type AssistantConfig, type AssistantProvider } from "./music-api";
import "./music-studio.css";
import "./settings-layout.css";

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
  const [draft, setDraft] = useState<AssistantProvider | null>(null);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { let active = true; setLoaded(false); if (backendBaseUrl) musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings").then(data => { if (active) { setConfig(data); setLoaded(true); } }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [backendBaseUrl]);
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
    const timers = (draft ? [draft] : []).map(provider => {
      const signature = fingerprint(provider);
      if (queried.current[provider.id] === signature) return;
      versions.current[provider.id] = (versions.current[provider.id] || 0) + 1;
      setCatalogs(current => { const next = { ...current }; delete next[provider.id]; return next; });
      if (!provider.baseUrl.trim() || !(provider.apiKey?.trim() || (provider.hasApiKey && !provider.clearKey))) return;
      return window.setTimeout(() => void fetchModels(provider), 900);
    });
    return () => timers.forEach(timer => { if (timer !== undefined) window.clearTimeout(timer); });
  }, [draft, backendBaseUrl]);
  const update = (_id: string, value: Partial<AssistantProvider>) => setDraft(current => current ? { ...current, ...value } : null);
  async function perform(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  async function save(value = config) { const data = await musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/settings", { method: "PUT", body: JSON.stringify(value) }); setConfig(data); setVisibleKeys({}); setRevealedKeys({}); return data; }
  useEffect(() => {
    if (draft && !dialog.current?.open) dialog.current?.showModal();
    if (!draft) dialog.current?.close();
  }, [draft?.id]);
  function closeEditor() { setDraft(null); setVisibleKeys({}); setRevealedKeys({}); setMessage(""); }
  async function saveDraft(close = true) {
    if (!draft) return;
    const value = { ...config, providers: config.providers.some(p => p.id === draft.id) ? config.providers.map(p => p.id === draft.id ? draft : p) : [...config.providers, draft] };
    const data = await save(value);
    if (close) { closeEditor(); setMessage("助手配置已保存。"); }
    else setDraft(data.providers.find(p => p.id === draft.id) || null);
  }
  function addPreset(index: number) {
    const preset = presets[index];
    setDraft({ id: crypto.randomUUID(), name: preset[0], baseUrl: preset[1], model: preset[2], apiType: preset[3], enabled: true });
    setMessage("");
  }
  const providers = config.providers.filter(p => `${p.name} ${p.baseUrl} ${p.model} ${p.apiType}`.toLowerCase().includes(search.toLowerCase()));
  const provider = draft;
  return <section className="assistant-settings">
    <div className="assistant-catalog-toolbar">
      <input aria-label="搜索助手配置" placeholder="搜索名称、地址或模型…" value={search} onChange={e => setSearch(e.target.value)} />
      <button className="ghost-button" disabled={busy || !loaded} onClick={() => void perform(async () => {
        const file = await window.voxcpmDesktop.openDialog({ properties: ["openFile"], filters: [{ name: "已有AI助手配置", extensions: ["json"] }] });
        if (file.canceled || !file.filePaths?.[0]) return;
        setConfig(await musicRequest<AssistantConfig>(backendBaseUrl, "/api/assistant/import", { method: "POST", body: JSON.stringify({ path: file.filePaths[0] }) })); setMessage("已有助手配置已导入。");
      })}>导入已有配置</button>
    </div>
    <div className="assistant-card-grid" aria-label="助手配置">
      {providers.map(item => <article key={item.id} className={`assistant-config-card ${config.defaultProviderId === item.id ? "is-default" : ""}`}>
        <button type="button" className="assistant-card-select" aria-label={`将${item.name}设为默认助手`} aria-pressed={config.defaultProviderId === item.id} disabled={busy || !loaded} onClick={() => void perform(async () => {
          await save({ ...config, defaultProviderId: item.id, providers: config.providers.map(p => p.id === item.id ? { ...p, enabled: true } : p) });
          setMessage(`已将“${item.name}”设为默认助手。`);
        })}>
          <span className="assistant-card-heading"><strong>{item.name}</strong><span className="assistant-protocol">{item.apiType === "responses" ? "Responses" : "Chat"}</span></span>
          <span className="assistant-card-address" title={item.baseUrl}>{item.baseUrl}</span>
          <span className="assistant-card-model"><span>{item.model}</span></span>
          <span className="assistant-card-foot"><span>{item.enabled ? "已启用" : "已停用"} · {item.hasApiKey ? "密钥已保存" : "未配置密钥"}</span><strong>{config.defaultProviderId === item.id ? "✓ 当前默认" : "点击设为默认"}</strong></span>
        </button>
        <div className="assistant-card-actions"><button type="button" className="ghost-button" disabled={busy} aria-label={`编辑${item.name}`} onClick={() => { setDraft({ ...item }); setMessage(""); }}>编辑</button><button type="button" className="ghost-button" disabled={busy} aria-label={`删除${item.name}`} onClick={() => void perform(async () => { await save({ ...config, providers: config.providers.filter(p => p.id !== item.id) }); setMessage("助手已删除。"); })}>删除</button></div>
      </article>)}
      <button type="button" className="assistant-config-card assistant-add-card" disabled={busy || !loaded || config.providers.length >= 20} onClick={() => addPreset(0)}><span aria-hidden="true">＋</span>添加助手配置</button>
    </div>
    {!loaded && <p className="music-help" role="status">{backendBaseUrl ? "正在读取助手配置…" : "正在连接本地服务…"}</p>}
    {loaded && search && !providers.length && <p className="music-help">没有找到匹配的助手。</p>}
    <div className="assistant-preferences"><div><strong>音乐 AI 优化</strong><p>音乐创作自动使用默认助手，按当前音乐模型的规则优化歌词与风格。</p></div><input aria-label="默认开启音乐AI优化" type="checkbox" role="switch" className="music-switch" checked={config.autoOptimizeMusic} disabled={busy || !loaded} onChange={e => { const checked = e.target.checked; void perform(async () => { await save({ ...config, autoOptimizeMusic: checked }); }); }} /></div>
    {message && !draft && <p className="music-message" role="status">{message}</p>}
    <dialog ref={dialog} className="assistant-editor" aria-labelledby="assistant-editor-title" onCancel={e => { e.preventDefault(); if (!busy) closeEditor(); }}>
      {provider && <><header className="assistant-editor-heading"><div><p className="panel-kicker">AI 助手配置</p><h2 id="assistant-editor-title">{config.providers.some(p => p.id === provider.id) ? "编辑助手" : "添加助手"}</h2></div><button aria-label="关闭助手编辑" type="button" className="ghost-button" disabled={busy} onClick={closeEditor}>✕</button></header>
      <div className="assistant-editor-body">
        {!config.providers.some(p => p.id === provider.id) && <div className="assistant-preset-list" aria-label="服务商预设">{presets.map((p, index) => <button key={p[0]} className="ghost-button" type="button" disabled={busy} onClick={() => { setDraft({ ...provider, name: p[0], baseUrl: p[1], model: p[2], apiType: p[3] }); }}>{p[0]}</button>)}</div>}
      <div className="form-grid">
        <label className="field"><span>名称</span><input value={provider.name} disabled={busy} onChange={e => update(provider.id, { name: e.target.value })} /></label>
        <label className="field"><span>接口类型</span><select value={provider.apiType} disabled={busy} onChange={e => update(provider.id, { apiType: e.target.value })}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label>
        <label className="field"><span>服务地址</span><input value={provider.baseUrl} disabled={busy} placeholder="https://…/v1" onChange={e => update(provider.id, { baseUrl: e.target.value })} autoComplete="off" /></label>
        <label className="field"><span>模型 ID（可手动填写）</span><input value={provider.model} disabled={busy} onChange={e => update(provider.id, { model: e.target.value })} placeholder="服务商提供的模型名称" /></label>
        <div className="field"><span>可用模型</span><select aria-label={`${provider.name}可用模型`} value={catalogs[provider.id]?.selected || ""} disabled={busy || catalogs[provider.id]?.loading || !catalogs[provider.id]?.models.length} onChange={e => { const selected = e.target.value; setCatalogs(current => ({ ...current, [provider.id]: { ...current[provider.id], selected } })); }}><option value="">{catalogs[provider.id]?.loading ? "正在获取模型…" : "输入密钥后自动获取，也可点击刷新"}</option>{catalogs[provider.id]?.models.map(model => <option key={model} value={model}>{model}</option>)}</select>
          <div className="assistant-provider-actions"><button className="ghost-button" disabled={busy || !provider.baseUrl.trim() || catalogs[provider.id]?.loading} onClick={() => void fetchModels(provider)}>刷新模型列表</button><button className="ghost-button" disabled={busy || !catalogs[provider.id]?.selected} onClick={() => void perform(async () => {
            const model = catalogs[provider.id].selected;
            update(provider.id, { model });
            setMessage(`已选用 ${model}，保存后生效。`);
          })}>应用所选模型</button></div>
          {catalogs[provider.id]?.error && <span className="music-help" role="status">{catalogs[provider.id].error}</span>}
        </div>
        <div className="field"><label htmlFor={`assistant-key-${provider.id}`}>API Key</label><div className="assistant-key-input"><input id={`assistant-key-${provider.id}`} type={visibleKeys[provider.id] ? "text" : "password"} value={provider.apiKey ?? (visibleKeys[provider.id] ? revealedKeys[provider.id] || "" : "")} disabled={busy} placeholder={provider.hasApiKey ? "已保存，留空保持原密钥" : "本地无密钥服务可留空"} autoComplete="new-password" spellCheck={false} onChange={e => update(provider.id, { apiKey: e.target.value, clearKey: false })} /><button type="button" className="music-text-button" aria-label={visibleKeys[provider.id] ? "隐藏 API Key" : "显示 API Key"} title={visibleKeys[provider.id] ? "隐藏密钥" : "查看密钥"} aria-pressed={!!visibleKeys[provider.id]} disabled={busy} onClick={() => void perform(() => toggleKey(provider))}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visibleKeys[provider.id] && <path d="m3 3 18 18" />}</svg></button></div></div>
        <div className="assistant-provider-actions"><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => { await saveDraft(false); await musicRequest(backendBaseUrl, "/api/assistant/test", { method: "POST", body: JSON.stringify({ providerId: provider.id }) }); setMessage("助手连接成功。"); })}>保存并测试连接</button>{provider.hasApiKey && <button className="music-text-button" disabled={busy} onClick={() => { update(provider.id, { clearKey: true, apiKey: "", hasApiKey: false }); setVisibleKeys(current => ({ ...current, [provider.id]: false })); setRevealedKeys(current => ({ ...current, [provider.id]: "" })); }}>清除已存密钥</button>}</div>
      </div>
        <label className="music-switch-label"><input type="checkbox" role="switch" className="music-switch" checked={provider.enabled} disabled={busy} onChange={e => update(provider.id, { enabled: e.target.checked })} />启用此助手</label>
        {message && <p className="music-message" role="status">{message}</p>}
      </div><footer className="assistant-editor-footer"><span>保存后生效，首个启用的助手自动设为默认。</span><button type="button" className="ghost-button" disabled={busy} onClick={closeEditor}>取消</button><button type="button" className="primary-button" disabled={busy || !provider.name.trim() || !provider.baseUrl.trim() || !provider.model.trim()} onClick={() => void perform(async () => { await saveDraft(); })}>{busy ? "处理中…" : "保存配置"}</button></footer></>}
    </dialog>
  </section>;
}
