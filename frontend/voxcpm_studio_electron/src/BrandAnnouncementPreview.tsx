import { useEffect, useState } from "react";
import BrandAnnouncementDialog from "./BrandAnnouncementDialog";
import "./brand-announcement-preview.css";

export default function BrandAnnouncementPreview() {
  const [open, setOpen] = useState(true);
  const [dark, setDark] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { document.title = "JVOX Studio配音系统 · 更名更新预览"; }, []);
  function theme() {
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    setDark(!dark);
  }
  return <main className="jvox-preview-stage">
    <header className="jvox-preview-toolbar"><span><b>JVOX</b> <span>Studio配音系统</span></span><div><span className="jvox-preview-label">更名更新 · 交互预览</span><button type="button" onClick={theme}>{dark ? "切换浅色" : "切换深色"}</button></div></header>
    <section className="jvox-preview-welcome"><p>THE NEXT CHAPTER OF YOUR VOICE</p><h1>好声音，即将以新名字相见。</h1><button type="button" onClick={() => { setOpen(true); setNotice(""); }}>重新查看更名公告 <span aria-hidden="true">↗</span></button><p className="jvox-preview-notice" role="status">{notice || "此窗口用于查阅弹窗设计，不执行下载或安装。"}</p></section>
    <footer className="jvox-preview-caption">JVOX Studio配音系统 <span>·</span> BRAND RENEWAL</footer>
    {open && <BrandAnnouncementDialog onToggleTheme={theme} onDismiss={() => { setOpen(false); setNotice("已选择稍后提醒。可重新打开公告，或切换主题继续查阅。"); }} onUpdate={() => { setOpen(false); setNotice("已体验「立即更新」交互。本次仅为设计预览，尚未接入正式下载安装。"); }} />}
  </main>;
}
