import { useEffect, useRef, useState } from "react";
import "./runtime-preparation.css";
import ComponentManager from "./ComponentManager";

type State = { status: string; phase: string; message: string; activity?: "startup" | "prepare"; profile?: string; label?: string;
  name?: string; downloaded?: number; size?: number; verifying?: boolean; reused?: boolean; log?: string; modelName?: string; modelState?: string };
const stages = ["设备检查", "模型检查", "音频环境", "音频服务", "功能自检", "启动完成"];
const phases: Record<string, number> = { detect: 0, check: 0, python: 2, dependencies: 2, verify: 2, models: 1, "environment-ready": 2, service: 3, components: 4, ready: 5 };
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function RuntimePreparation({ onRun, backendStatus, backendDetail }: { onRun: () => void; backendStatus: string; backendDetail: string }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true, received = false;
    const receive = (value: State) => { setState(value); if (["error", "cancelled"].includes(value.status) || value.activity === "prepare") setOpen(true); };
    const unsubscribe = window.voxcpmDesktop.onRuntimeEvent(event => { if (event.type === "runtime-preparation") { received = true; receive(event.preparation); } });
    window.voxcpmDesktop.getPreparationState().then(value => { if (active && !received) receive(value); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (backendStatus === "ready") setOpen(false);
    else if (backendStatus === "error") setOpen(true);
  }, [backendStatus]);
  useEffect(() => {
    if (open) { returnFocus.current = document.activeElement as HTMLElement; if (!dialog.current?.open) dialog.current?.showModal(); }
    else { dialog.current?.close(); returnFocus.current?.focus(); }
  }, [open]);
  const backendFailed = state?.status === "ready" && backendStatus === "error";
  const failed = backendFailed || state?.status === "error" || backendStatus === "error";
  const paused = state?.status === "cancelled";
  const working = !failed && !paused && (["preparing", "booting"].includes(backendStatus) || ["checking", "working"].includes(state?.status || ""));
  const preparing = state?.activity === "prepare" || (!state?.activity && state?.status === "working" && ["python", "dependencies"].includes(state.phase));
  const index = phases[state?.phase || "detect"] ?? 0;
  const percent = state?.size ? Math.min(100, Math.round((state.downloaded || 0) / state.size * 100)) : undefined;
  const title = failed ? "音频系统启动未完成" : paused ? "资源准备已暂停" : preparing ? "正在准备缺失的音频资源" : "音频系统启动中";
  return <>
    {!open && ["preparing", "booting"].includes(backendStatus) && <div className="runtime-startup-status" role="status"><span />正在连接本地服务，您可以先浏览工作区</div>}
    {!open && ["stopped", "error"].includes(backendStatus) && <button type="button" className="runtime-run-button primary-button" onClick={onRun}>运行</button>}
    <dialog ref={dialog} className="runtime-dialog runtime-startup-dialog" aria-labelledby="runtime-title" onCancel={event => { if (working) event.preventDefault(); else setOpen(false); }}>
      <div className="runtime-dialog-kicker">VOXCPM STUDIO · {preparing ? "资源准备" : "音频启动"}</div>
      <h2 id="runtime-title">{title}</h2>
      <p className="runtime-intro">{failed ? "启动未完成，请查看下方说明。可重新启动，或通过功能与模型管理完整准备资源。" : preparing ? "正在准备所选资源；已完成的文件会直接复用。" : "正在连接本地服务。模型将在使用时单独校验和加载。"}</p>
      <ol className="runtime-stages">{stages.map((label, i) => <li key={label} className={i === index ? "current" : i < index ? "done" : ""}><span>{i < index ? "✓" : i + 1}</span>{label}</li>)}</ol>
      {state?.label && <div className="runtime-device">{state.label}{state.profile === "cpu" && " · 速度取决于 CPU 性能"}</div>}
      <p className="runtime-message" role="status" aria-live="polite">{failed ? state?.status === "error" ? state.message : backendDetail || state?.message : state?.message || "音频组件加载中，请稍候…"}</p>
      {state?.modelName && <div className="runtime-model-state"><span>{state.modelName}</span><strong>{state.modelState === "ready" ? "检查完成" : state.modelState === "loading" ? "加载中" : "检查中"}</strong></div>}
      {working && <>
        <progress aria-label={preparing ? "资源准备进度" : "音频系统启动进度"} aria-valuetext={`阶段 ${index + 1} / ${stages.length}：${stages[index]}`} max={100} value={preparing ? state?.verifying ? undefined : percent : state?.phase === "service" ? undefined : index * 20} />
        <p className="runtime-stage-caption">{preparing ? "资源准备" : "启动阶段"} {index + 1} / {stages.length} · {stages[index]}{!preparing && "，请稍候"}</p>
      </>}
      {state?.name && <div className="runtime-file"><span>{state.verifying ? "正在校验 " : state.reused ? "校验完成 " : ""}{state.name}</span><span>{preparing && state.size ? `${mb(state.downloaded || 0)} / ${mb(state.size)}` : ""}</span></div>}
      <button type="button" className="runtime-log-toggle" onClick={() => setShowLog(!showLog)}>{showLog ? "收起详细日志" : "查看详细日志"}</button>
      {showLog && <pre className="runtime-log">{state?.log || (preparing ? "下载和安装详情将在此显示。" : "音频组件正在加载，请稍候。")}</pre>}
      <div className="runtime-dialog-actions">{working
        ? preparing ? <button type="button" className="ghost-button" onClick={() => window.voxcpmDesktop.cancelPreparation()}>暂停准备</button> : <span className="runtime-intro">加载完成后会自动进入，无需操作</span>
        : <><button type="button" className="ghost-button" onClick={() => setOpen(false)}>稍后再试</button><button type="button" className="primary-button" onClick={() => { if (paused || preparing || state?.phase === "components") void window.voxcpmDesktop.startBackend({ prepare: true }).catch(() => {}); else onRun(); }}>{failed ? "重新启动" : "继续准备并运行"}</button></>}
      </div>
      {!working && <ComponentManager onRun={onRun} backendRunning={false} />}
    </dialog>
  </>;
}
