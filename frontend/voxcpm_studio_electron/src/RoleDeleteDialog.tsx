import { useEffect, useRef, useState } from "react";
import type { StudioRole } from "./production-types";

type Props = {
  role: StudioRole;
  replacements: StudioRole[];
  segmentCount: number;
  locked: boolean;
  onCancel: () => void;
  onConfirm: (replacementId: string) => void;
};

export default function RoleDeleteDialog({ role, replacements, segmentCount, locked, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [replacementId, setReplacementId] = useState(replacements[0]?.id || "");

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={dialogRef} className="ps-role-delete-dialog" aria-labelledby="ps-delete-role-title" aria-describedby="ps-delete-role-description"
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onCancel();
    }}>
    <h2 id="ps-delete-role-title">删除角色「{role.name}」</h2>
    <p id="ps-delete-role-description">这个角色有 {segmentCount} 段台词。请选择接替角色，文案、顺序和停顿会完整保留。音色配置不同的已生成段落需要重新生成。</p>
    <label htmlFor="ps-delete-role-target">将台词转移给</label>
    <select id="ps-delete-role-target" value={replacementId} onChange={event => setReplacementId(event.target.value)} disabled={locked}>
      {replacements.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select>
    <div className="ps-role-delete-actions">
      <button type="button" className="ps-button" onClick={onCancel} autoFocus>取消</button>
      <button type="button" className="ps-button ps-delete-role-confirm" disabled={locked || !replacements.some(item => item.id === replacementId)} onClick={() => onConfirm(replacementId)}>转移台词并删除</button>
    </div>
  </dialog>;
}
