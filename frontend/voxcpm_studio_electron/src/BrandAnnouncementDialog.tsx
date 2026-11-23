import { useLayoutEffect, useRef } from "react";
import "./brand-announcement.css";

type Props = { onUpdate: () => void; onDismiss: () => void; onToggleTheme?: () => void; welcome?: boolean };

function FeatureIcon({ kind }: { kind: "spark" | "wave" | "shield" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {kind === "spark" ? <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" /> :
      kind === "wave" ? <path strokeLinecap="round" d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4" /> :
        <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12 2.3 2.3 4.7-4.6" /></>}
  </svg>;
}

export default function BrandAnnouncementDialog({ onUpdate, onDismiss, onToggleTheme, welcome = false }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    primary.current?.focus({ preventScroll: true });
    return () => { element.close(); previous?.focus({ preventScroll: true }); };
  }, []);

  return <dialog ref={dialog} className="jvox-announcement" aria-labelledby="jvox-announcement-title" aria-describedby="jvox-announcement-description" onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <div className="jvox-announcement-content">
      <header className="jvox-announcement-header">
        <span className="jvox-edition"><span aria-hidden="true">✦</span> 品牌焕新 · 正式更名</span>
        <div className="jvox-window-actions">{onToggleTheme && <button className="jvox-close" type="button" aria-label="切换弹窗深浅主题" title="切换深浅主题" onClick={onToggleTheme}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg></button>}<button className="jvox-close" type="button" aria-label="稍后提醒，关闭更名公告" onClick={onDismiss}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
      </header>

      <section className="jvox-announcement-hero">
        <div className="jvox-announcement-copy">
          <p className="jvox-eyebrow">A NEW NAME. A NEW CHAPTER.</p>
          <h1 id="jvox-announcement-title">新名字，<br />新<span>声</span>开始。</h1>
          <p className="jvox-former-name">VoxCPM Studio 现正式更名为</p>
          <h2>JVOX Studio<span>配音系统</span></h2>
          <p id="jvox-announcement-description" className="jvox-intro">感谢你一路相伴。让每一次灵感，<br />都在这里成为动人的声音。</p>
        </div>

        <div className="jvox-sound-art" aria-hidden="true">
          <div className="jvox-orbit jvox-orbit-one" /><div className="jvox-orbit jvox-orbit-two" />
          <span className="jvox-art-star jvox-art-star-one">✦</span><span className="jvox-art-star jvox-art-star-two">✧</span>
          <span className="jvox-art-dot" />
          <div className="jvox-art-disc"><div className="jvox-disc-grain" /><span className="jvox-art-letter">J</span>
            <div className="jvox-art-wave">{[15, 26, 40, 58, 75, 94, 72, 52, 34, 52, 70, 91, 66, 45, 29, 18].map((height, i) => <i key={i} style={{ height, animationDelay: `${i * -0.13}s` }} />)}</div>
            <span className="jvox-disc-wordmark">JVOX</span>
          </div>
          <span className="jvox-art-caption">让声音，拥有更多可能</span>
        </div>
      </section>

      <section className="jvox-announcement-features" aria-label="本次更名说明">
        <div><span className="jvox-feature-icon"><FeatureIcon kind="spark" /></span><span><strong>全新品牌名称</strong><small>今后，请认准 JVOX</small></span></div>
        <div><span className="jvox-feature-icon"><FeatureIcon kind="wave" /></span><span><strong>熟悉的创作体验</strong><small>配音、克隆与音乐创作</small></span></div>
        <div><span className="jvox-feature-icon"><FeatureIcon kind="shield" /></span><span><strong>作品安心保留</strong><small>保留模型、配置与作品</small></span></div>
      </section>

      <footer className="jvox-announcement-footer">
        <div className="jvox-footer-note"><span className="jvox-ready-dot" /> {welcome ? "欢迎来到全新 JVOX，一起开启新声" : "一次更新，迎接全新 JVOX"}</div>
        <div className="jvox-announcement-actions"><button className="jvox-later" type="button" onClick={onDismiss}>稍后提醒</button><button ref={primary} className="jvox-update" type="button" onClick={onUpdate}>{welcome ? "开启新声，开始创作" : "立即更新，开启新声"} <span aria-hidden="true">↗</span></button></div>
      </footer>
    </div>
  </dialog>;
}
