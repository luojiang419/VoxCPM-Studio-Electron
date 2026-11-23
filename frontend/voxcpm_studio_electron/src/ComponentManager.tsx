import { useRef, useState } from "react";

type Profile = { selected: string[]; removed: string[]; defaultModel: string };
type Option = { id: string; label: string; size: number; minMemoryMB: number; installed?: boolean; present?: boolean };
export default function ComponentManager({ onRun, backendRunning }: { onRun: () => void; backendRunning: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [profile, setProfile] = useState<Profile>({ selected: [], removed: [], defaultModel: "ace-xl-turbo" });
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runtimeSize, setRuntimeSize] = useState(0);
  const refresh = async () => {
    const result = await window.voxcpmDesktop.getComponents();
    setOptions(result.options); setProfile(result.profile || { selected: [], removed: [], defaultModel: "ace-xl-turbo" });
    setWorking(result.working); setRuntimeSize(result.runtimeSize);
  };
  const invoke = async (action: () => Promise<void>) => {
    setMessage(""); setBusy(true); try { await action(); } catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  };
  const selectedSize = options.filter(o => profile.selected.includes(o.id)).reduce((n, o) => n + o.size, 0)
    + (profile.selected.some(id => id !== "lipsync") ? runtimeSize : 0);
  return <>
    <button type="button" className="ghost-button" onClick={() => invoke(async () => { await refresh(); dialog.current?.showModal(); })}>功能与模型管理</button>
    <dialog ref={dialog} className="runtime-dialog" aria-label="功能与模型管理">
      <div className="runtime-dialog-kicker">VOXCPM STUDIO · 组件选择</div>
      <h2>选择功能与音乐模型</h2>
      <p className="runtime-intro">配音、语音识别和降噪自动准备。选中功能全部补齐后进入工作区；已移除的模型在更新时保持移除。</p>
      {options.map(option => <div className="component-option" key={option.id}>
        <label><input type="checkbox" role="switch" aria-label={option.label} disabled={busy || working} checked={profile.selected.includes(option.id)} onChange={e => {
          setProfile({ ...profile, selected: e.target.checked ? [...profile.selected, option.id] : profile.selected.filter(id => id !== option.id),
            removed: e.target.checked ? profile.removed.filter(id => id !== option.id) : profile.removed });
        }} /><span>{option.label}<small>{(option.size / 1024 ** 3).toFixed(2)} GiB · 建议显存 {option.minMemoryMB >= 15360 ? 16 : 8} GB{option.installed ? " · 文件已安装" : ""}</small></span></label>
        {option.present && <button disabled={busy || working || backendRunning} type="button" className="ghost-button" onClick={() => invoke(async () => {
          const result = await window.voxcpmDesktop.removeComponent(option.id); await refresh(); setMessage(`已移除，释放 ${(result.freed / 1024 ** 3).toFixed(2)} GiB${result.sharedBytes ? "，其他安装共享的源文件已保留" : ""}；再次勾选可恢复。`);
        })}>移除</button>}
      </div>)}
      <label className="component-default">默认音乐模型 <select value={profile.defaultModel} disabled={working || busy} onChange={e => setProfile({ ...profile, defaultModel: e.target.value })}>
        {options.filter(o => o.id !== "lipsync").map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select></label>
      <p className="runtime-intro">所选可选组件约 {(selectedSize / 1024 ** 3).toFixed(1)} GiB，另需基础组件及下载临时空间。已安装文件校验复用。取消勾选保留文件；移除才释放空间。</p>
      {backendRunning && <p className="runtime-intro">保存选择将停止本地引擎，请先结束当前任务。移除前请先停止引擎。</p>}
      {message && <p role="status">{message}</p>}
      <div className="runtime-dialog-actions">
        {working && <button type="button" className="ghost-button" onClick={() => invoke(async () => { await window.voxcpmDesktop.cancelPreparation(); setMessage("正在暂停，稍后点击刷新状态"); })}>暂停准备</button>}
        <button type="button" className="ghost-button" onClick={() => invoke(refresh)}>刷新状态</button>
        {backendRunning && !working && <button type="button" className="ghost-button" onClick={() => invoke(async () => { await window.voxcpmDesktop.stopBackend(); await refresh(); })}>停止引擎</button>}
        <button type="button" className="ghost-button" onClick={() => dialog.current?.close()}>关闭</button>
        <button type="button" className="primary-button" disabled={busy || working} onClick={() => invoke(async () => {
          await window.voxcpmDesktop.selectComponents(profile); dialog.current?.close(); onRun();
        })}>保存并准备</button>
      </div>
    </dialog>
  </>;
}
