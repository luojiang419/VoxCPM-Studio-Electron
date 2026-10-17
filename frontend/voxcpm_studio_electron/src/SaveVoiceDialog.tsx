import { useEffect, useRef, useState } from "react";

type Props = {
  initialName: string;
  initialTags: string[];
  mode: string;
  onCancel: () => void;
  onSave: (name: string, tags: string[]) => Promise<void>;
};

export default function SaveVoiceDialog({ initialName, initialTags, mode, onCancel, onSave }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState(initialName);
  const [tags, setTags] = useState(initialTags.join("，"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function submit() {
    if (!name.trim() || submitting.current) return;
    submitting.current = true; setSaving(true); setError("");
    try { await onSave(name.trim(), tags.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; setSaving(false); }
  }

  return <dialog ref={dialogRef} className="save-voice-dialog" aria-labelledby="save-voice-title"
    onCancel={event => { event.preventDefault(); if (!submitting.current) onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2 id="save-voice-title">保存到音色库</h2>
      <p>{mode === "声音设计" ? "保存当前试听的声音，配音时以它作为参考，让音色保持一致。" : "保存当前试听、参考音频和克隆配置，随时应用到配音角色。"}</p>
      <label htmlFor="save-voice-name">音色名称</label>
      <input id="save-voice-name" value={name} onChange={event => setName(event.target.value)} placeholder="如：温暖叙述、清晰播报" maxLength={60} required disabled={saving} autoFocus />
      <label htmlFor="save-voice-tags">标签（可选）</label>
      <input id="save-voice-tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="用逗号分隔，如：旁白，温柔，自然" maxLength={120} disabled={saving} />
      {error && <p className="save-voice-error" role="alert">{error}</p>}
      <div className="save-voice-actions">
        <button type="button" className="ghost-button" disabled={saving} onClick={onCancel}>取消</button>
        <button type="submit" className="primary-button" disabled={saving || !name.trim()}>{saving ? "正在保存…" : "保存并查看音色库"}</button>
      </div>
    </form>
  </dialog>;
}
