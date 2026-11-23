import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GenerationConfig } from "./production-types";
import "./production-studio.css";
import "./works-library.css";

export type WorkCategory = "voice" | "dubbing" | "video" | "music" | "batch";
export type Work = {
  id: string; category: WorkCategory; title: string; subtitle: string; label: string;
  outputPath: string; previewUrl: string; createdAt: string; duration: number | null;
  available: boolean; projectId?: string; config?: GenerationConfig; archivePath?: string; archiveAvailable?: boolean;
};
export const WORK_SECTIONS: { key: WorkCategory; title: string; description: string; action: string }[] = [
  { key: "voice", title: "声音设计与克隆", description: "声音设计、参考音频克隆与单条语音", action: "创作声音" },
  { key: "dubbing", title: "配音工作台", description: "多角色项目的分段音频与完整作品", action: "前往配音" },
  { key: "video", title: "视频对口型", description: "视频对口型与照片说话作品", action: "创作视频" },
  { key: "music", title: "音乐创作", description: "各个音乐模型生成的歌曲与纯音乐", action: "创作音乐" },
  { key: "batch", title: "批量生成", description: "按批次归档的全部语音，可逐条试听", action: "批量创作" },
];
function Symbol({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    voice: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    dubbing: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h5m-4 5 2 2 4-4" /></>,
    video: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>,
    music: <><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>,
    batch: <><rect x="4" y="3" width="16" height="4" rx="1" /><rect x="4" y="10" width="16" height="4" rx="1" /><rect x="4" y="17" width="16" height="4" rx="1" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    folder: <path d="M3 6h7l2 3h9v11H3ZM3 6V4h7l2 2h8v3" />,
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
    refresh: <path d="M20 8A8 8 0 1 0 20 16M20 3v5h-5" />,
    play: <path d="m9 5 10 7-10 7Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const duration = (value: number | null) => value == null || !Number.isFinite(value) ? "—" : `${Math.floor(Math.max(0, value) / 60).toString().padStart(2, "0")}:${Math.floor(Math.max(0, value) % 60).toString().padStart(2, "0")}`;
const date = (value: string) => Number.isNaN(Date.parse(value)) ? "时间未知" : new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
type Props = { backendBaseUrl: string; headerTools?: ReactNode; onCreate: (category: WorkCategory) => void; onOpen: (work: Work) => void };

export default function WorksLibrary({ backendBaseUrl, headerTools, onCreate, onOpen }: Props) {
  const [items, setItems] = useState<Work[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState<WorkCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [limits, setLimits] = useState<Partial<Record<WorkCategory, number>>>({});
  const [selected, setSelected] = useState<Work | null>(null);
  const [actionBusy, setActionBusy] = useState("");
  const requestId = useRef(0);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const closeVideo = useRef<HTMLButtonElement>(null);
  const mediaUrl = (value: string) => value.startsWith("/") ? backendBaseUrl + value : value;

  async function refresh() {
    const id = ++requestId.current;
    setLoading(true); setError("");
    try {
      if (!backendBaseUrl) throw new Error("本地服务尚未连接，请在运行控制中启动服务后刷新作品。");
      const response = await fetch(backendBaseUrl + "/api/workspace/works");
      if (!response.ok) throw new Error(`作品读取失败（${response.status}），请刷新重试。`);
      const data = await response.json() as { items: Work[]; warnings: string[] };
      if (id === requestId.current) { setItems(data.items); setWarnings(data.warnings || []); }
    } catch (cause) { if (id === requestId.current) setError(cause instanceof Error ? cause.message : "无法连接本地服务，请恢复服务后刷新。"); }
    finally { if (id === requestId.current) setLoading(false); }
  }
  useEffect(() => { setItems([]); setWarnings([]); setSelected(null); void refresh(); return () => { requestId.current++; }; }, [backendBaseUrl]);
  useEffect(() => { setLimits({}); }, [category, query, sort]);
  useEffect(() => {
    if (selected?.category !== "video") return;
    const previous = previewTrigger.current;
    closeVideo.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "Tab") {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('.works-video-dialog button, .works-video-dialog video'));
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [selected]);

  async function perform(id: string, action: () => Promise<void>) {
    setActionBusy(id); setNotice("");
    try { await action(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { setActionBusy(""); }
  }
  async function save(work: Work, archive = false) {
    const sourcePath = archive ? work.archivePath! : work.outputPath;
    const extension = sourcePath.split(".").pop() || "wav";
    const target = await window.voxcpmDesktop.saveDialog({ defaultPath: sourcePath, filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }] });
    if (target.canceled || !target.filePath) return;
    const response = await fetch(backendBaseUrl + "/api/files/save-as", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourcePath, targetPath: target.filePath }) });
    if (!response.ok) throw new Error("导出失败，请确认原作品文件仍然存在，并检查保存位置。");
    setNotice(`已保存到 ${target.filePath}`);
  }
  const filtered = items.filter(item => `${item.title} ${item.subtitle} ${item.label}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title, "zh-CN") : ((Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)) * (sort === "oldest" ? 1 : -1));
  const sections = WORK_SECTIONS.filter(section => category === "all" || section.key === category);
  const count = (key: WorkCategory) => items.filter(item => item.category === key).length;
  const visibleCount = filtered.filter(item => category === "all" || item.category === category).length;

  return <div className="production-studio works-library">
    <header className="ps-header"><div className="ps-title-group"><h1>作品记录</h1><p>所有创作，各有归处</p></div><div className="ps-header-actions"><button className="ps-button ps-small" disabled={loading} onClick={() => void refresh()}><Symbol name="refresh" />{loading ? "读取中…" : "刷新记录"}</button>{headerTools}</div></header>
    {error && <div className="ps-alert ps-alert-error" role="alert"><span>{error}</span><button className="ps-text-button" disabled={loading} onClick={() => void refresh()}>重新连接</button></div>}
    {(notice || warnings.length > 0) && <div className="ps-alert" role="status"><span>{notice || warnings.join(" ")}</span>{notice && <button className="works-icon-button" aria-label="关闭操作提示" onClick={() => setNotice("")}><Symbol name="close" /></button>}</div>}
    <div className="works-content" aria-busy={loading}>
      <div className="works-intro"><div><span className="works-eyebrow">我的创作档案</span><h2>每一次创作，都值得珍藏</h2><p>从一句配音到一首音乐，在这里找到你的全部作品。</p></div><div className="works-total"><strong>{loading && !items.length ? "—" : items.length}</strong><span>件作品</span></div></div>
      <nav className="works-categories" aria-label="按创作功能筛选作品">{WORK_SECTIONS.map(section => <button key={section.key} className={`works-category works-tone-${section.key} ${category === section.key ? "is-active" : ""}`} aria-pressed={category === section.key} onClick={() => setCategory(current => current === section.key ? "all" : section.key)}><span className="works-category-icon"><Symbol name={section.key} /></span><span>{section.title}<small>{section.key === "dubbing" ? "分段 / 完整作品" : section.key === "video" ? "对口型 / 照片说话" : section.key === "batch" ? "批次语音归档" : section.key === "music" ? "歌曲 / 纯音乐" : "设计 / 克隆"}</small></span><strong>{loading && !items.length ? "—" : count(section.key)}</strong></button>)}</nav>
      <div className="works-toolbar"><div className="works-filter-status"><button className={category === "all" ? "is-active" : ""} onClick={() => setCategory("all")}>全部作品</button><span>{query.trim() || category !== "all" ? `找到 ${visibleCount} 件作品` : "按创作来源分区展示"}</span></div><div className="works-filter-tools"><label className="works-search"><Symbol name="search" /><input aria-label="搜索作品" placeholder="搜索作品名称、台词…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="清空搜索" onClick={() => setQuery("")}><Symbol name="close" /></button>}</label><select aria-label="作品排序" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">最新创作优先</option><option value="oldest">最早创作优先</option><option value="title">按作品名称</option></select></div></div>
      {loading && !items.length ? <div className="works-state" role="status"><div className="ps-loading-ring" /><h3>正在整理你的作品</h3><p>读取各个创作空间的记录…</p></div> : error && !items.length ? <div className="works-state"><Symbol name="folder" /><h3>暂时无法读取作品</h3><p>恢复本地服务后，点击右上角刷新记录。</p></div> : query.trim() && !visibleCount ? <div className="works-state"><Symbol name="search" /><h3>没有找到匹配的作品</h3><p>试试其他关键词，或查看全部创作类型。</p><button className="ps-button" onClick={() => { setQuery(""); setCategory("all"); }}>重置筛选</button></div> : <div className="works-sections">{sections.map(section => {
        const records = filtered.filter(item => item.category === section.key);
        const limit = limits[section.key] || 6;
        if (query.trim() && !records.length) return null;
        return <section key={section.key} className={`works-section works-tone-${section.key}`} aria-label={`${section.title}作品`}>
          <div className="works-section-heading"><div><span className="works-section-symbol"><Symbol name={section.key} /></span><div><h2>{section.title}<span>{records.length}</span></h2><p>{section.description}</p></div></div><button className="ps-text-button" onClick={() => onCreate(section.key)}>{section.action}<Symbol name="arrow" /></button></div>
          {records.length ? <div className="works-records">{records.slice(0, limit).map(work => <article key={work.id} className={`works-row ${selected?.id === work.id ? "is-selected" : ""}`}>
            <button className="works-preview-button" disabled={!work.available} aria-label={`${work.category === "video" ? "预览" : "试听"} ${work.title}`} onClick={event => { previewTrigger.current = event.currentTarget; setSelected(work); }}><Symbol name={selected?.id === work.id ? "play" : work.category} /><span><Symbol name="play" /></span></button>
            <div className="works-record-info"><h3 title={work.title}>{work.title}</h3><p title={work.subtitle}>{work.subtitle || "未添加描述"}</p><div className="works-record-tags"><span>{work.label}</span>{!work.available && <span className="works-missing">原文件已移动或删除</span>}</div></div>
            <div className="works-record-meta"><span>{duration(work.duration)}</span><time dateTime={work.createdAt}>{work.createdAt ? date(work.createdAt) : "时间未知"}</time></div>
            <div className="works-record-actions"><button className="works-icon-button" aria-label={`定位文件 ${work.title}`} title="显示文件位置" disabled={!work.available || !!actionBusy} onClick={() => void perform(work.id, () => window.voxcpmDesktop.showItemInFolder(work.outputPath).then(() => {}))}><Symbol name="folder" /></button><button className="works-icon-button" aria-label={`导出作品 ${work.title}`} title="另存作品" disabled={!work.available || !!actionBusy} onClick={() => void perform(work.id, () => save(work))}><Symbol name="download" /></button>{work.archiveAvailable && <button className="ps-text-button" disabled={!!actionBusy} onClick={() => void perform(work.id, () => save(work, true))}>导出 ZIP</button>}{(work.projectId || work.config) && <button className="ps-text-button" disabled={!!actionBusy} onClick={() => onOpen(work)}>{work.projectId ? "打开项目" : "载入配置"}<Symbol name="arrow" /></button>}</div>
          </article>)}</div> : <div className="works-section-empty"><Symbol name={section.key} /><span>还没有{section.title}作品</span><span>完成创作后，会自动收录在这里</span></div>}
          {records.length > limit && <button className="works-more" onClick={() => setLimits(current => ({ ...current, [section.key]: limit + 12 }))}>显示更多作品 · 还有 {records.length - limit} 件</button>}
        </section>;
      })}</div>}
    </div>
    {selected && selected.category !== "video" && <footer className="works-audio-player"><span className={`works-category-icon works-tone-${selected.category}`}><Symbol name={selected.category} /></span><div><strong>{selected.title}</strong><span>{selected.label}</span></div><audio key={selected.id} controls autoPlay src={mediaUrl(selected.previewUrl)} onError={() => setNotice("音频无法播放，原文件可能已移动或格式不可用。请刷新记录后重试。")} /><button className="works-icon-button" aria-label="关闭作品播放器" onClick={() => setSelected(null)}><Symbol name="close" /></button></footer>}
    {selected?.category === "video" && <div className="works-video-overlay" onClick={event => { if (event.target === event.currentTarget) setSelected(null); }}><div className="works-video-dialog" role="dialog" aria-modal="true" aria-labelledby="works-video-title"><header><h2 id="works-video-title">{selected.title}</h2><button ref={closeVideo} className="works-icon-button" aria-label="关闭视频预览" onClick={() => setSelected(null)}><Symbol name="close" /></button></header><video key={selected.id} tabIndex={0} controls autoPlay src={mediaUrl(selected.previewUrl)} onError={() => setNotice("视频无法播放，请检查原作品文件是否完整。")} /><p>{selected.label} · {duration(selected.duration)}</p></div></div>}
  </div>;
}
