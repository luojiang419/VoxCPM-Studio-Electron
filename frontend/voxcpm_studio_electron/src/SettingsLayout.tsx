import { useEffect, useState, type ReactNode } from "react";
import "./settings-layout.css";

const categories = [
  { id: "api", label: "开发者 API", icon: "⌘", description: "开放声音设计与克隆，管理调用密钥和服务地址。", keywords: "API Key 密钥 端口 服务 局域网 语音 接口" },
  { id: "assistant", label: "AI 助手", icon: "✦", description: "管理多个 API 配置，点击卡片即可切换默认助手。", keywords: "API 密钥 模型 服务商 音乐 优化 Responses Chat DeepSeek" },
  { id: "system", label: "模型与存储", icon: "▤", description: "设置模型来源、缓存目录、输出位置和运行策略。", keywords: "本地 Hugging Face ZipEnhancer 代理 降噪 预热 输出 路径" },
  { id: "appearance", label: "界面与工具", icon: "◐", description: "选择界面主题与退出行为，快速打开日志和数据目录。", keywords: "深色 浅色 跟随系统 日志 主题 数据 关闭 退出 后台运行 托盘 每次询问" },
  { id: "updates", label: "软件更新", icon: "↻", description: "检查新版本，管理自动更新与安装。", keywords: "版本 升级 下载 自动检查" },
] as const;

export default function SettingsLayout({ api, assistant, system, appearance, updates, focusRequest }: { api: ReactNode; assistant: ReactNode; system: ReactNode; appearance: ReactNode; updates: ReactNode; focusRequest: number }) {
  const [active, setActive] = useState("assistant"), [search, setSearch] = useState("");
  useEffect(() => { if (focusRequest) { setActive("updates"); setSearch(""); } }, [focusRequest]);
  const views: Record<string, ReactNode> = { api, assistant, system, appearance, updates };
  const query = search.trim().toLowerCase();
  const visible = categories.filter(c => query ? `${c.label} ${c.description} ${c.keywords}`.toLowerCase().includes(query) : c.id === active);
  const current = categories.find(c => c.id === active)!;
  return <div className="studio-settings">
    <label className="settings-search"><span aria-hidden="true">⌕</span><input aria-label="搜索设置" placeholder="搜索设置、功能或关键词…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button type="button" className="music-text-button" onClick={() => setSearch("")}>清除</button>}</label>
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置分类"><span>偏好设置</span>{categories.map(c => <button type="button" key={c.id} aria-current={!query && active === c.id ? "page" : undefined} onClick={() => { setActive(c.id); setSearch(""); }}><i aria-hidden="true">{c.icon}</i>{c.label}</button>)}<p>模型按需校验与加载，<br />启动后直接进入工作区。</p></nav>
      <div className="settings-content"><header className="settings-view-heading"><h2>{query ? "搜索结果" : current.label}</h2><p>{query ? `找到 ${visible.length} 个相关分类` : current.description}</p></header><div className="settings-scroll">{visible.map(c => <section key={c.id} className="settings-category" aria-label={c.label}>{query && <h3>{c.label}</h3>}{views[c.id]}</section>)}{!visible.length && <div className="settings-empty"><p>没有找到相关设置</p><button className="ghost-button" type="button" onClick={() => setSearch("")}>清除搜索</button></div>}</div></div>
    </div>
  </div>;
}
