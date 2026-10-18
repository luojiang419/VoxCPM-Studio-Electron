import { useEffect, useRef, useState } from "react";
import "./runtime-preparation.css";

type State = { status: string; phase: string; message: string; profile?: string; label?: string;
  name?: string; downloaded?: number; size?: number; verifying?: boolean; reused?: boolean; log?: string };
const stages = [["detect", "识别设备"], ["python", "运行环境"], ["dependencies", "安装依赖"], ["models", "补齐模型"], ["ready", "启动服务"]];
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function RuntimePreparation({ onRun, backendStatus, backendDetail }: { onRun: () => void; backendStatus: string; backendDetail: string }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const receive = (value: State) => { setState(value); if (["working", "error", "cancelled"].includes(value.status)) setOpen(true); };
    window.voxcpmDesktop.getPreparationState().then(receive).catch(() => {});
    return window.voxcpmDesktop.onRuntimeEvent((event) => { if (event.type === "runtime-preparation") receive(event.preparation); });
  }, []);
  useEffect(() => { if (backendStatus === "ready") setOpen(false); }, [backendStatus]);
  useEffect(() => {
    if (open) { returnFocus.current = document.activeElement as HTMLElement; dialog.current?.showModal(); }
    else { dialog.current?.close(); returnFocus.current?.focus(); }
  }, [open]);
  const working = state?.status === "working" || (state?.status === "ready" && !["error", "stopped"].includes(backendStatus));
  const backendFailed = state?.status === "ready" && backendStatus === "error";
  const phase = state?.phase === "check" ? "detect" : state?.phase === "verify" ? "dependencies" : state?.phase;
  const index = stages.findIndex(([key]) => key === phase);
  const percent = state?.size ? Math.min(100, Math.round((state.downloaded || 0) / state.size * 100)) : undefined;
  return <>
    {!open && ["stopped", "error"].includes(backendStatus) && <button type="button" className="runtime-run-button primary-button" onClick={onRun}>运行 · 自动补齐环境</button>}
    <dialog ref={dialog} className="runtime-dialog" aria-labelledby="runtime-title" onCancel={(event) => { if (working) event.preventDefault(); else setOpen(false); }}>
      <div className="runtime-dialog-kicker">VOXCPM STUDIO · 首次运行准备</div>
      <h2 id="runtime-title">{backendFailed ? "本地服务启动未完成" : state?.status === "error" ? "补齐暂未完成" : state?.status === "cancelled" ? "已暂停补齐" : "正在补齐模型和依赖"}</h2>
      <p className="runtime-intro">首次运行需要下载运行环境和模型，请保持网络连接。已完成的文件会保留，后续运行自动复用。</p>
      <ol className="runtime-stages">{stages.map(([key, label], i) => <li key={key} className={i === index ? "current" : i < index ? "done" : ""}><span>{i < index ? "✓" : i + 1}</span>{label}</li>)}</ol>
      {state?.label && <div className="runtime-device">{state.label}{state.profile === "cpu" && " · 速度取决于 CPU 性能"}</div>}
      <p className="runtime-message" role="status" aria-live="polite">{backendFailed ? backendDetail : state?.message}</p>
      {working && <progress aria-label="当前文件补齐进度" max={100} value={state?.verifying ? undefined : percent} />}
      {state?.name && <div className="runtime-file"><span>{state.verifying ? "正在校验 " : state.reused ? "已复用 " : ""}{state.name}</span><span>{state.size ? `${mb(state.downloaded || 0)} / ${mb(state.size)}` : ""}</span></div>}
      <button type="button" className="runtime-log-toggle" onClick={() => setShowLog(!showLog)}>{showLog ? "收起详细日志" : "查看详细日志"}</button>
      {showLog && <pre className="runtime-log">{state?.log || "等待输出；下载阶段可查看上方文件进度。"}</pre>}
      <div className="runtime-dialog-actions">{working
        ? <button type="button" className="ghost-button" disabled={state?.status === "ready"} onClick={() => window.voxcpmDesktop.cancelPreparation()}>暂停补齐</button>
        : <><button type="button" className="ghost-button" onClick={() => setOpen(false)}>稍后再试</button><button type="button" className="primary-button" onClick={onRun}>继续补齐并运行</button></>}
      </div>
    </dialog>
  </>;
}
