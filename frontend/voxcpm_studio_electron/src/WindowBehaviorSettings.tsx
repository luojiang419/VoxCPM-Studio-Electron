import { useEffect, useState } from "react";
import { closeChoices, type CloseBehavior } from "./window-behavior-types";
import { CloseIcon } from "./WindowCloseDialog";
import "./window-behavior.css";

export default function WindowBehaviorSettings() {
  const [behavior, setBehavior] = useState<CloseBehavior | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    window.voxcpmDesktop.getWindowBehavior().then(value => { if (active) setBehavior(value.behavior); }).catch(() => { if (active) setMessage("读取退出偏好失败，请重试。"); });
    const unsubscribe = window.voxcpmDesktop.onRuntimeEvent(payload => { if (payload.windowBehavior) setBehavior(payload.windowBehavior.behavior); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function save(value: CloseBehavior) {
    setBusy(true); setMessage("");
    try { const saved = await window.voxcpmDesktop.setWindowBehavior(value); setBehavior(saved.behavior); setMessage("退出偏好已保存，下次关闭窗口时生效。"); }
    catch (e) { setMessage(`保存失败：${(e as Error).message}`); }
    finally { setBusy(false); }
  }
  return <div className="settings-tool-section wc-settings"><span className="field-label" id="wc-setting-label">关闭窗口时</span><div className="wc-setting-grid" role="group" aria-labelledby="wc-setting-label">{closeChoices.map(item => <button key={item.value} className={`wc-setting-option ${behavior === item.value ? "is-selected" : ""}`} type="button" aria-pressed={behavior === item.value} disabled={busy || !behavior} onClick={() => void save(item.value)}><CloseIcon kind={item.value} /><span>{item.title}</span>{behavior === item.value && <span className="wc-setting-check"><CloseIcon kind="check" /></span>}</button>)}</div><p className="wc-setting-hint" role="status">{message || (behavior === "background" ? "关闭窗口后，双击系统托盘图标即可回到工作台；右键可退出软件。" : behavior === "quit" ? "关闭窗口时直接退出软件并停止本地服务，不再询问。" : "首次关闭默认询问；确认固定行为后会记住选择。")}</p></div>;
}
