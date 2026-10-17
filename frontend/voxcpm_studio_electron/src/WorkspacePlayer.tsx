import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  src: string;
  fileName: string;
  canGenerate: boolean;
  hasOutput: boolean;
  generating: boolean;
  status?: ReactNode;
  onGenerate: () => void;
  onSave: () => void;
  onOpenDirectory: () => void;
  canSaveVoice?: boolean;
  saveVoiceHint?: string;
  onSaveVoice?: () => void;
};

function timeLabel(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function PlayerIcon({ name }: { name: "play" | "pause" | "folder" | "download" | "spark" | "volume" | "muted" }) {
  const paths = {
    play: <path d="m9 5 10 7-10 7Z" />,
    pause: <path d="M8 5v14M16 5v14" />,
    folder: <path d="M3 6h7l2 3h9v11H3ZM3 6V4h7l2 2h8v3" />,
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
    spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
    volume: <><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16" /></>,
    muted: <><path d="m11 4-6 5H2v6h3l6 5ZM16 9l6 6M16 15l6-6" /></>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function WorkspacePlayer({ src, fileName, canGenerate, hasOutput, generating, status, onGenerate, onSave, onOpenDirectory, canSaveVoice, saveVoiceHint, onSaveVoice }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playRequest = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [audioError, setAudioError] = useState("");

  useEffect(() => {
    playRequest.current += 1;
    audioRef.current?.pause();
    setPlaying(false);
    setDuration(0);
    setCurrentTime(0);
    setAudioError("");
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => { playRequest.current += 1; audio?.pause(); };
  }, []);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !src) return;
    if (!audio.paused) { audio.pause(); return; }
    const request = ++playRequest.current;
    setAudioError("");
    if (audio.error) audio.load();
    if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration) audio.currentTime = 0;
    try { await audio.play(); }
    catch (error) {
      if (request === playRequest.current && !(error instanceof DOMException && error.name === "AbortError")) {
        setAudioError("音频暂时无法播放，请重试或重新生成。");
      }
    }
  }

  return <footer className="workspace-generation-footer" aria-label="合成音频播放器">
    <audio ref={audioRef} src={src || undefined} preload="metadata" muted={muted}
      onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => { if (src) { setPlaying(false); setAudioError("音频加载失败，请重试或重新生成。"); } }} />
    {status}
    {audioError && <p className="workspace-playback-error" role="alert">{audioError}</p>}
    <div className="workspace-transport">
      <div className="workspace-player">
        <button type="button" className={`workspace-play-button ${playing ? "is-playing" : ""}`} aria-label={playing ? "暂停合成音频" : "播放合成音频"} title={playing ? "暂停" : "播放"} disabled={!src} onClick={() => void togglePlayback()}>
          <PlayerIcon name={playing ? "pause" : "play"} />
        </button>
        <div className="workspace-now-playing"><strong title={fileName || "准备好，听听你的声音"}>{fileName || "准备好，听听你的声音"}</strong><span>{src ? `${timeLabel(currentTime)} / ${timeLabel(duration)}` : "生成后在这里试听"}</span></div>
      </div>
      <div className="workspace-seek-controls">
        <input type="range" className="workspace-audio-seek" aria-label="合成音频播放进度" aria-valuetext={`${timeLabel(currentTime)} / ${timeLabel(duration)}`} min={0} max={duration || 1} step={0.01} value={Math.min(currentTime, duration || 0)} disabled={!src || !duration}
          onChange={event => { const time = Number(event.target.value); if (audioRef.current) { audioRef.current.currentTime = time; setCurrentTime(time); } }} />
        <button type="button" className="workspace-mute-button" aria-label={muted ? "取消静音" : "静音"} aria-pressed={muted} disabled={!src} onClick={() => setMuted(value => !value)}><PlayerIcon name={muted ? "muted" : "volume"} /></button>
      </div>
      <div className="workspace-action-bar">
        <button type="button" className="ghost-button" onClick={onOpenDirectory} disabled={!hasOutput}><PlayerIcon name="folder" /><span>输出目录</span></button>
        <button type="button" className="ghost-button" onClick={onSave} disabled={!hasOutput}><PlayerIcon name="download" /><span>另存音频</span></button>
        <button type="button" className="ghost-button workspace-save-voice" onClick={onSaveVoice} disabled={!canSaveVoice} title={saveVoiceHint}><span>保存音色</span></button>
        <button type="button" className="primary-button" onClick={onGenerate} disabled={!canGenerate}><PlayerIcon name="spark" /><span>{generating ? "正在生成…" : "开始生成"}</span></button>
      </div>
    </div>
  </footer>;
}
