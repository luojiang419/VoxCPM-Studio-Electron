import { useEffect, useRef, useState } from "react";
import "./runtime-preparation.css";
import ComponentManager from "./ComponentManager";

type State = { status: string; phase: string; message: string; profile?: string; label?: string;
  name?: string; downloaded?: number; size?: number; verifying?: boolean; reused?: boolean; log?: string };
const stages = [["detect", "设备"], ["python", "环境"], ["dependencies", "依赖"], ["models", "语音模型"], ["components", "所选功能"], ["ready", "进入工作区"]];
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
  useEffect(() => {
    if (backendStatus === "ready") setOpen(false);
    else if (backendStatus === "error" && state?.status === "ready") setOpen(true);
  }, [backendStatus, state?.status]);
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
    {!open && ["preparing", "booting"].includes(backendStatus) && <div className="runtime-startup-status" role="status"><span />{state?.status === "ready" ? "正在启动本地引擎…" : "正在检查本地环境…"}</div>}
    {!open && ["stopped", "error"].includes(backendStatus) && <button type="button" className="runtime-run-button primary-button" onClick={onRun}>运行</button>}
    <dialog ref={dialog} className="runtime-dialog" aria-labelledby="runtime-title" onCancel={(event) => { if (working) event.preventDefault(); else setOpen(false); }}>
      <div className="runtime-dialog-kicker">VOXCPM STUDIO · 运行环境</div>
      <h2 id="runtime-title">{backendFailed ? "本地服务启动未完成" : state?.status === "error" ? "运行环境准备未完成" : state?.status === "cancelled" ? "已暂停补齐" : state?.status === "ready" ? "正在启动本地服务" : "正在补齐缺失组件"}</h2>
      <p className="runtime-intro">{backendFailed ? "运行环境已就绪，请查看本地服务启动日志以定位问题。" : "正在准备缺失或更新的组件，已就绪的运行环境和模型会保留并复用。需要下载时请保持网络连接。"}</p>
      <ol className="runtime-stages">{stages.map(([key, label], i) => <li key={key} className={i === index ? "current" : i < index ? "done" : ""}><span>{i < index ? "✓" : i + 1}</span>{label}</li>)}</ol>
      {state?.label && <div className="runtime-device">{state.label}{state.profile === "cpu" && " · 速度取决于 CPU 性能"}</div>}
      <p className="runtime-message" role="status" aria-live="polite">{backendFailed ? backendDetail : state?.message}</p>
      {working && <progress aria-label="当前文件补齐进度" max={100} value={state?.verifying ? undefined : percent} />}
      {state?.name && <div className="runtime-file"><span>{state.verifying ? "正在校验 " : state.reused ? "已复用 " : ""}{state.name}</span><span>{state.size ? `${mb(state.downloaded || 0)} / ${mb(state.size)}` : ""}</span></div>}
      <button type="button" className="runtime-log-toggle" onClick={() => setShowLog(!showLog)}>{showLog ? "收起详细日志" : "查看详细日志"}</button>
      {showLog && <pre className="runtime-log">{state?.log || "等待输出；下载阶段可查看上方文件进度。"}</pre>}
      <div className="runtime-dialog-actions">{working
        ? <button type="button" className="ghost-button" disabled={state?.status === "ready"} onClick={() => window.voxcpmDesktop.cancelPreparation()}>暂停补齐</button>
        : <><button type="button" className="ghost-button" onClick={() => setOpen(false)}>稍后再试</button><button type="button" className="primary-button" onClick={onRun}>{backendFailed ? "重新启动服务" : "继续准备并运行"}</button></>}
      </div>
      <ComponentManager onRun={onRun} backendRunning={false} />
    </dialog>
  </>;
}
