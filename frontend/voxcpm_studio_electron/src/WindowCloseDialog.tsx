import { useLayoutEffect, useRef, useState } from "react";
import { closeChoices, type CloseBehavior, type CloseAction } from "./window-behavior-types";
import "./window-behavior.css";

export function CloseIcon({ kind }: { kind: CloseBehavior | "close" | "arrow" | "check" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "quit" ? <><path d="M12 3v9M7 5.7a8 8 0 1 0 10 0" /></> :
      kind === "background" ? <><rect x="3" y="4" width="18" height="13" rx="3" /><path d="M8 21h8m-4-4v4M8 10h8m-3-3 3 3-3 3" /></> :
      kind === "ask" ? <><path d="M4 12a8 8 0 1 1 2.3 5.7L3 15m0 5v-5h5" /><path d="M12 7v5l3 2" /></> :
      kind === "close" ? <path d="m6 6 12 12M18 6 6 18" /> :
      kind === "check" ? <path d="m5 12 4 4L19 6" /> : <path d="M5 12h14m-5-5 5 5-5 5" />}
  </svg>;
}

export default function WindowCloseDialog({ initialBehavior, onCancel, onConfirm, initialError = "" }: {
  initialBehavior: CloseBehavior; onCancel: () => Promise<unknown>;
  onConfirm: (behavior: CloseBehavior, action: CloseAction) => Promise<unknown>; initialError?: string;
}) {
  // 首次询问不预先选中“彻底退出”，确认前不会保存或关闭。
  const [choice, setChoice] = useState<CloseBehavior>(initialBehavior === "ask" ? "background" : initialBehavior);
  const [busy, setBusy] = useState(false), [error, setError] = useState(initialError);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal(); cancelButton.current?.focus({ preventScroll: true });
    return () => { element.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  async function cancel() {
    if (busy) return;
    setBusy(true);
    try { await onCancel(); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  async function confirm(action: CloseAction) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onConfirm(choice, action); }
    catch (e) { setError(`操作未完成：${(e as Error).message}`); setBusy(false); }
  }
  return <dialog ref={dialog} className="window-close-dialog" aria-labelledby="window-close-title" aria-describedby="window-close-description"
    onCancel={event => { event.preventDefault(); void cancel(); }}>
    <div className="wc-topline"><span className="wc-brand"><i aria-hidden="true">J</i> JVOX <span>STUDIO</span></span><button type="button" className="wc-icon-button" aria-label="取消退出，返回软件" onClick={() => void cancel()} disabled={busy}><CloseIcon kind="close" /></button></div>
    <header className="wc-heading"><span className="wc-eyebrow">WINDOW PREFERENCE <i /></span><h2 id="window-close-title">关闭窗口后，如何继续？</h2><p id="window-close-description">为你的创作习惯，选择一个合适的收尾方式。</p></header>
    <fieldset className="wc-choices" disabled={busy}><legend className="wc-sr-only">选择退出行为</legend>
      {closeChoices.map(item => <label key={item.value} className={`wc-choice ${choice === item.value ? "is-selected" : ""}`}>
        <input type="radio" name="window-close-choice" value={item.value} checked={choice === item.value} onChange={() => setChoice(item.value)} />
        <span className="wc-choice-icon"><CloseIcon kind={item.value} /></span><span className="wc-choice-copy"><span className="wc-choice-title">{item.title}<small>{item.badge}</small></span><span className="wc-choice-description">{item.description}</span></span><span className="wc-radio" aria-hidden="true">{choice === item.value && <i />}</span>
      </label>)}
    </fieldset>
    <div className="wc-memory-note" aria-live="polite"><span className="wc-note-icon"><CloseIcon kind={choice === "ask" ? "ask" : "check"} /></span><p>{choice === "ask" ? <>本次自由选择，<strong>下次关闭仍会询问。</strong></> : <>确认后记住此选择，<strong>后续不再询问。</strong></>}<small>随时可在「设置 → 界面与工具」中修改。</small></p></div>
    {error && <p className="wc-error" role="alert">{error}</p>}
    <footer className="wc-footer"><button ref={cancelButton} className="wc-cancel" type="button" disabled={busy} onClick={() => void cancel()}>取消</button><div className="wc-actions">{choice === "ask" && <button className="wc-secondary" type="button" disabled={busy} onClick={() => void confirm("background")}>本次后台运行</button>}<button className="wc-primary" type="button" disabled={busy} onClick={() => void confirm(choice === "background" ? "background" : "quit")}>{busy ? "正在处理…" : choice === "ask" ? "本次关闭软件" : choice === "background" ? "确认并后台运行" : "确认并关闭软件"}<CloseIcon kind="arrow" /></button></div></footer>
  </dialog>;
}
