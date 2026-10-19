import { useEffect, useState } from "react";
import WindowCloseDialog from "./WindowCloseDialog";
import type { WindowBehaviorState } from "./window-behavior-types";

export default function WindowCloseManager() {
  const [state, setState] = useState<WindowBehaviorState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, received = false;
    const unsubscribe = window.voxcpmDesktop.onRuntimeEvent(payload => {
      if (!payload.windowBehavior) return;
      received = true;
      setState(payload.windowBehavior); setError(payload.error || "");
    });
    window.voxcpmDesktop.getWindowBehavior().then(value => { if (active && !received) setState(value); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  return state?.promptOpen ? <WindowCloseDialog initialBehavior={state.behavior} initialError={error}
    onCancel={async () => { const value = await window.voxcpmDesktop.cancelWindowClose(); setState(value); }}
    onConfirm={async (behavior, action) => { const value = await window.voxcpmDesktop.resolveWindowClose({ behavior, action }); setState(value); }} /> : null;
}
