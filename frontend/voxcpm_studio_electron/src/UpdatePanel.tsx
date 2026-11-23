import { useEffect, useRef, useState } from "react";

type UpdateState = { status: string; currentVersion: string; latestVersion?: string; notes?: string; canDownload?: boolean;
  message: string; progress: number; autoCheck: boolean; size?: number };

export default function UpdatePanel({ focusRequest = 0 }: { focusRequest?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (focusRequest) {
      panel.current?.scrollIntoView({ block: "nearest" });
      panel.current?.focus({ preventScroll: true });
    }
  }, [focusRequest]);
  useEffect(() => {
    window.voxcpmDesktop.getUpdateState().then(setState).catch((e) => setError(String(e)));
    return window.voxcpmDesktop.onRuntimeEvent((event) => {
      if (event.type === "update-state") setState(event.update);
    });
  }, []);
  async function run(action: () => Promise<unknown>) {
    setError("");
    try { await action(); } catch (e) { setError(String(e)); }
  }
  const busy = state?.status === "checking" || state?.status === "downloading";
  return <div className="settings-tool-section" id="software-update-panel" ref={panel} tabIndex={-1} aria-label="软件更新">
    <span className="field-label">软件更新</span>
    <p className="paragraph">当前版本 {state?.currentVersion || "…"}{state?.latestVersion ? ` · 最新版本 ${state.latestVersion}` : ""}</p>
    <p className="paragraph" role="status">{error || state?.message || "正在读取更新状态…"}</p>
    {state?.notes && <p className="paragraph" style={{ whiteSpace: "pre-wrap" }}>{state.notes}</p>}
    {state?.status === "downloading" && <progress max={100} value={state.progress} style={{ width: "100%" }} aria-label="更新下载进度" />}
    <label className="paragraph update-auto-check"><input type="checkbox" checked={state?.autoCheck ?? true} disabled={!state}
      onChange={(event) => run(() => window.voxcpmDesktop.setAutoCheckUpdate(event.target.checked))} /> 启动时自动检查更新</label>
    <div className="settings-tool-grid" style={{ marginTop: 12 }}>
      <button type="button" className="ghost-button" disabled={busy} onClick={() => run(() => window.voxcpmDesktop.checkUpdate())}>检查更新</button>
      {(state?.status === "available" || (state?.status === "error" && state.canDownload)) &&
        <button type="button" className="primary-button" disabled={busy} onClick={() => run(() => window.voxcpmDesktop.downloadUpdate())}>
          下载更新{state.size ? `（${(state.size / 1024 / 1024).toFixed(1)} MB）` : ""}</button>}
      {state?.status === "downloaded" && <button type="button" className="primary-button" onClick={() => run(() => window.voxcpmDesktop.installUpdate())}>重启并安装</button>}
    </div>
  </div>;
}
