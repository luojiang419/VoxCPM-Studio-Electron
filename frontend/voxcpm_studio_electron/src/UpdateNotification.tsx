import { useEffect, useRef, useState } from "react";

type Update = { status: string; checkSource?: string; latestVersion?: string; latestReleaseId?: string; publishedAt?: string; notes?: string; size?: number };
const notified = new Set<string>();

export default function UpdateNotification({ onOpen }: { onOpen: () => void }) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true, received = false;
    const receive = (value: Update) => {
      const key = `${value.latestVersion}/${value.latestReleaseId || value.publishedAt || ""}`;
      if (value.status !== "available" || value.checkSource !== "startup" || notified.has(key)) return;
      notified.add(key); setUpdate(value); setOpen(true);
    };
    const unsubscribe = window.voxcpmDesktop.onRuntimeEvent(event => {
      if (event.type === "update-state") { received = true; receive(event.update); }
    });
    window.voxcpmDesktop.getUpdateState().then(value => { if (active && !received) receive(value); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (open) { returnFocus.current = document.activeElement as HTMLElement; if (!dialog.current?.open) dialog.current?.showModal(); }
    else { dialog.current?.close(); returnFocus.current?.focus(); }
  }, [open]);
  return <dialog className="runtime-dialog update-available-dialog" ref={dialog} aria-labelledby="update-available-title" onCancel={() => setOpen(false)}>
    <div className="runtime-dialog-kicker">VOXCPM STUDIO · 软件更新</div>
    <h2 id="update-available-title">发现新版本</h2>
    <p className="runtime-intro">VoxCPM Studio {update?.latestVersion}{update?.size ? ` · ${(update.size / 1024 ** 2).toFixed(1)} MB` : ""}</p>
    {update?.notes && <div className="update-notification-notes">{update.notes}</div>}
    <p className="runtime-intro">可在准备好后下载并安装，个人设置与作品会保留。</p>
    <div className="runtime-dialog-actions">
      <button type="button" className="ghost-button" onClick={() => setOpen(false)}>稍后再说</button>
      <button type="button" className="primary-button" onClick={() => { setOpen(false); onOpen(); }}>查看更新</button>
    </div>
  </dialog>;
}
