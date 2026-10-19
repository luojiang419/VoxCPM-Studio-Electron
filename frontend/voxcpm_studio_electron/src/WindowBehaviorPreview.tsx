import { useEffect, useLayoutEffect, useState } from "react";
import WindowCloseManager from "./WindowCloseManager";
import WindowBehaviorSettings from "./WindowBehaviorSettings";
import { CloseIcon } from "./WindowCloseDialog";
import brandIcon from "../app-icon.png";
import "./window-behavior-preview.css";

export default function WindowBehaviorPreview() {
  const [theme, setTheme] = useState(() => localStorage.getItem("exit-preview-theme") === "dark" ? "dark" : "light");
  const [notice, setNotice] = useState("");
  useLayoutEffect(() => { document.body.dataset.theme = theme; localStorage.setItem("exit-preview-theme", theme); }, [theme]);
  useEffect(() => { document.title = "JVOX Studio配音系统 · 退出行为演示"; }, []);
  return <><div className="app-shell studio-shell wc-preview">
    <aside className="sidebar"><div className="sidebar-top"><div className="studio-brand"><img src={brandIcon} alt="" width="36" height="36" /><div className="brand-copy"><strong>JVOX</strong><span>Studio配音系统</span></div></div><div className="studio-nav-caption">偏好设置</div><nav className="nav-list"><div className="nav-item nav-item-active"><span className="nav-icon"><CloseIcon kind="background" /></span><span className="nav-text">界面与工具</span></div></nav></div><div className="studio-sidebar-foot"><div><span className="studio-service-dot is-ready" /><strong>本地交互演示</strong></div><p>独立数据 · 真实窗口与托盘</p></div></aside>
    <main className="workspace"><header className="studio-page-heading"><h1>界面与工具</h1><div className="studio-page-tools"><span>退出行为 · 交互演示</span><button className="studio-theme-button" type="button" aria-label="切换界面主题" title="切换深浅主题" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? "☾" : "☀"}</button></div></header>
      <div className="wc-preview-content"><p className="wc-preview-kicker">MAKE ROOM FOR YOUR NEXT IDEA</p><h2>收起窗口，创作由你安排。</h2><p className="wc-preview-intro">直接点击窗口右上角 ×，体验新的退出方式。</p>
        <section className="panel-card wc-preview-card"><h3>主题与退出偏好</h3><div className="settings-tool-section"><span className="field-label">界面主题</span><div className="wc-preview-theme"><button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>浅色模式</button><button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>深色模式</button></div></div><WindowBehaviorSettings /></section>
        <div className="wc-preview-action"><button type="button" className="wc-primary" onClick={() => void window.voxcpmDesktop.requestWindowClose()}>体验关闭窗口 <CloseIcon kind="arrow" /></button><button type="button" className="wc-secondary" onClick={() => void window.voxcpmDesktop.setWindowBehavior("ask").then(() => setNotice("已恢复每次询问，现在点击关闭即可重新体验。")).catch(e => setNotice((e as Error).message))}>恢复每次询问</button></div>
        <p className="wc-preview-status" role="status">{notice || "后台运行后，双击系统托盘 JVOX 图标恢复；右键可彻底退出。"}</p>
      </div><footer className="wc-preview-footer">JVOX STUDIO <span>WINDOW PREFERENCE</span></footer>
    </main>
  </div><WindowCloseManager /></>;
}
