import { useEffect, useState } from "react";
import "./public-api.css";

type Config = {enabled: boolean; host: string; port: number; listening: boolean; base_url: string; error: string};
type Key = {id: string; name: string; prefix: string; disabled: number; calls: number; calls_today: number; last_used_at: string};

export default function PublicApiSettings({backendBaseUrl, managementToken}: {backendBaseUrl: string; managementToken?: string}) {
  const [config, setConfig] = useState<Config | null>(null), [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState(""), [secret, setSecret] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(backendBaseUrl + "/api/access" + path, {...options, headers: {"Content-Type": "application/json", ...(managementToken ? {"X-JVOX-Management": managementToken} : {})}});
    const data = await response.json();
    if (!response.ok) throw Error(Array.isArray(data.detail) ? data.detail.map((e: {loc?: string[]; msg: string}) => `${e.loc?.slice(1).join(".") || "参数"}：${e.msg}`).join("；") : data.detail || "操作失败");
    return data;
  }
  async function load() { const [cfg, list] = await Promise.all([request(""), request("/keys")]); setConfig(cfg); setKeys(list.keys); }
  useEffect(() => { void load().catch(e => setMessage(e.message)); }, [backendBaseUrl, managementToken]);
  async function run(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); await load(); } catch(e) { setMessage((e as Error).message); } finally { setBusy(false); } }
  async function change(key: Key, action: string) {
    if (action === "rotate" && !confirm(`轮换“${key.name}”？旧 Key 将立即失效。`)) return;
    if (action === "delete" && !confirm(`删除“${key.name}”？调用方将无法使用此 Key。`)) return;
    await run(async () => {
      setSecret("");
      const data = await request(`/keys/${key.id}${action === "delete" ? "" : "/" + action}`, {method: action === "secret" ? "GET" : action === "delete" ? "DELETE" : "POST"});
      if (data.api_key) setSecret(data.api_key);
      setMessage(action === "secret" ? "密钥仅显示在当前页面，关闭后隐藏。" : "操作已完成");
    });
  }
  return <div className="public-api-settings">
    <div className="api-intro"><span className={config?.listening ? "api-online" : ""}>{config?.listening ? "● 服务运行中" : "○ 服务未启动"}</span><p>将本机声音设计与声音克隆开放给 H3 或其他开发者。所有调用均需要 API Key，推理复用当前声音模型。</p></div>
    {config && <section className="api-box"><h3>API 服务</h3><div className="api-service-fields">
      <label>监听范围<select value={config.host} disabled={busy} onChange={e => setConfig({...config, host: e.target.value})}><option value="127.0.0.1">仅本机 · 127.0.0.1</option><option value="0.0.0.0">局域网 · 0.0.0.0</option></select></label>
      <label>端口<input type="number" min="1024" max="65535" value={config.port} disabled={busy} onChange={e => setConfig({...config, port: Number(e.target.value)})}/></label>
      <label className="api-enable"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={e => setConfig({...config, enabled: e.target.checked})}/>启用 API</label>
      <button type="button" className="primary-button" disabled={busy} onClick={() => run(async () => { await request("", {method: "PUT", body: JSON.stringify({enabled: config.enabled, host: config.host, port: config.port})}); setMessage("服务配置已应用，重启软件后自动恢复。"); })}>保存并应用</button>
    </div><p>API Base URL：<code>{config.base_url}</code> <button type="button" className="ghost-button" onClick={() => navigator.clipboard.writeText(config.base_url).catch(() => setMessage("请手动选择地址复制"))}>复制地址</button></p><small>局域网调用时将 127.0.0.1 替换为本机 IP。管理页面始终仅供本机使用。</small>{config.error && <p role="alert">{config.error}</p>}</section>}
    <section className="api-box"><h3>API Key 管理</h3><p>为每个应用创建独立密钥，便于轮换、停用和查看用量。</p>
      <form className="api-create-key" onSubmit={e => {e.preventDefault(); void run(async () => {const data = await request("/keys", {method: "POST", body: JSON.stringify({name})}); setSecret(data.api_key); setName(""); setMessage("密钥已创建，可复制到调用方的声音 API 配置。");});}}><input aria-label="密钥名称" placeholder="例如：H3 视频工作室" value={name} maxLength={32} required onChange={e => setName(e.target.value)}/><button className="primary-button" disabled={busy || !name.trim()}>创建密钥</button><button type="button" className="ghost-button" disabled={busy} onClick={() => run(load)}>刷新用量</button></form>
      {secret && <div className="api-secret"><code>{secret}</code><button className="ghost-button" type="button" onClick={() => navigator.clipboard.writeText(secret).then(() => setMessage("已复制密钥")).catch(() => setMessage("请手动选择密钥复制"))}>复制密钥</button><button className="ghost-button" type="button" onClick={() => setSecret("")}>隐藏</button></div>}
      <div className="api-key-list">{keys.map(key => <article key={key.id} className="api-key-card"><div><strong>{key.name}</strong><span>{key.disabled ? "已停用" : "可用"}</span></div><code>{key.prefix}…</code><p>今日提交 {key.calls_today} · 累计提交 {key.calls}<br/><small>最近调用：{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "暂无"}</small></p><div className="api-key-actions"><button className="ghost-button" type="button" disabled={busy} onClick={() => change(key, "secret")}>查看 / 复制</button><button className="ghost-button" type="button" disabled={busy || !!key.disabled} onClick={() => change(key, "rotate")}>轮换</button><button className="ghost-button" type="button" disabled={busy || !!key.disabled} onClick={() => change(key, "disable")}>停用</button><button className="ghost-button" type="button" disabled={busy} onClick={() => change(key, "delete")}>删除</button></div></article>)}</div>{!keys.length && <p className="api-empty">创建第一个密钥后即可开启 API。</p>}
    </section><p role="status" aria-live="polite">{message}</p><section className="api-box"><h3>开发者调用</h3><p><code>GET /v1/models</code> 查询模型；<code>POST /v1/audio/speech</code> 直接返回 WAV。</p><p><code>POST /v1/audio/generations</code> 提交异步任务，支持查询状态与下载结果。上传参考 WAV 后可进行克隆。</p><p>鉴权：<code>Authorization: Bearer &lt;API_KEY&gt;</code>。API 端口的 <code>/docs</code> 提供交互文档；完整示例见随演示交付的 API 文档。</p></section>
  </div>;
}
