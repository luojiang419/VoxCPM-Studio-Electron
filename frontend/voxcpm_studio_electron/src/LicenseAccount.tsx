import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./license-account.css";
type LicenseState = {
  enabled: boolean;
  status?: string;
  displayName?: string;
  loggedIn?: boolean;
  allowed?: boolean;
  user?: { id: string; username: string; name: string };
  serverTime?: number;
  expiresAt?: number;
  contact?: string;
  purchaseNote?: string;
  error?: string;
};
const labels: Record<string, string> = {
  "logged-out": "未登录",
  trial: "试用中",
  permanent: "正式版 · 永久授权",
  expired: "试用已到期",
  suspended: "授权已停用",
  "verification-required": "需要联网验证",
};
export function LicenseAccount({ onEnabled }: { onEnabled: () => void }) {
  const [state, setState] = useState<LicenseState>({ enabled: false });
  const [open, setOpen] = useState(false),
    [register, setRegister] = useState(false),
    [reminder, setReminder] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [elapsed, setElapsed] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    anchor = useRef(performance.now());
  function accept(s: LicenseState) {
    anchor.current = performance.now();
    setElapsed(0);
    setState(s);
    document.title = s.displayName || "JVOX Studio试用版";
    if (s.status === "permanent") setReminder(false);
  }
  useEffect(() => {
    let active = true;
    window.voxcpmDesktop
      .getLicenseState()
      .then((s) => {
        if (!active) return;
        accept(s);
        if (s.enabled) {
          onEnabled();
          if (!s.loggedIn) setOpen(true);
        }
      })
      .catch(() => {});
    const unsubscribe = window.voxcpmDesktop.onRuntimeEvent((p) => {
      if (p.type === "license-state" && active) accept(p.license);
    });
    const timer = window.setInterval(
      () => setElapsed((performance.now() - anchor.current) / 1000),
      1000,
    );
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (state.status !== "trial") return;
    const check = () =>
      void window.voxcpmDesktop
        .shouldRemindTrial()
        .then((show) => {
          if (show) setReminder(true);
        })
        .catch(() => {});
    check();
    const timer = window.setInterval(check, 60000);
    return () => clearInterval(timer);
  }, [state.status, state.expiresAt]);
  useEffect(() => {
    if (!state.loggedIn) setReminder(false);
  }, [state.loggedIn]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open || reminder) {
      if (!d.open) d.showModal();
    } else if (d.open) d.close();
  }, [open, reminder, state.enabled]);
  if (!state.enabled) return null;
  const remaining = Math.max(
    0,
    (state.expiresAt || 0) - (state.serverTime || Date.now() / 1000) - elapsed,
  );
  const days = Math.ceil(remaining / 86400);
  const status =
    state.status === "trial" && remaining === 0
      ? "expired"
      : state.status || "logged-out";
  const time = state.expiresAt
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(state.expiresAt * 1000))
    : "";
  async function logout() {
    setBusy(true);
    try {
      accept(await window.voxcpmDesktop.logout());
      setRegister(false);
      setReminder(false);
      setMessage("已退出登录，账户授权和作品均保留。");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (register && values.password !== values.confirm) {
      setMessage("两次密码输入不一致");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await window.voxcpmDesktop.authenticate(
        register ? "register" : "login",
        values,
      );
      if (result.error) {
        setMessage(result.error);
        return;
      }
      accept(result.state);
      setOpen(false);
      setRegister(false);
    } catch (e) {
      setMessage(String(e));
    } finally {
      form
        .querySelectorAll<HTMLInputElement>("input[type=password]")
        .forEach((i) => (i.value = ""));
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="jvox-account-entry"
        onClick={() => {
          setOpen(true);
          setMessage("");
        }}
        aria-label="账户与授权"
      >
        <span className="jvox-account-label">
          {state.user?.name || "登录 / 注册"}
        </span>
        <small>
          {status === "trial" ? `试用剩余 ${days} 天` : labels[status]}
        </small>
      </button>
      {createPortal(
        <dialog
          className="jvox-account-dialog"
          ref={dialog}
          onCancel={(e) => {
            e.preventDefault();
            setOpen(false);
            setReminder(false);
          }}
        >
          <div className="jvox-account-top">
            <span>JVOX STUDIO / ACCOUNT</span>
            <button
              aria-label="关闭账户窗口"
              onClick={() => {
                setOpen(false);
                setReminder(false);
              }}
            >
              关闭
            </button>
          </div>
          {reminder ? (
            <section>
              <span className="jvox-account-kicker">继续创作</span>
              <h2>你的试用将在 {days} 天后结束</h2>
              <p>
                试用至 {time}。
                {state.purchaseNote ||
                  "联系作者核实付款后，即可开通永久使用权限。"}
              </p>
              <div className="jvox-contact">
                <small>作者联系方式</small>
                <strong>
                  {state.contact ||
                    "作者尚未配置联系方式，请从软件分发渠道联系作者。"}
                </strong>
              </div>
              <p className="jvox-account-note">
                联系作者时提供：{state.user?.id} · JVOX Studio
              </p>
              <button
                className="jvox-account-primary"
                onClick={() => setReminder(false)}
              >
                知道了，继续创作
              </button>
            </section>
          ) : state.loggedIn ? (
            <section>
              <span className="jvox-account-kicker">YOUR ACCOUNT</span>
              <h2>{state.user?.name}</h2>
              <p>
                {state.user?.username} · {state.user?.id}
              </p>
              <div className="jvox-account-status">
                <span>{labels[status]}</span>
                <strong>
                  {status === "trial"
                    ? `${Math.floor(remaining / 86400)} 天 ${String(Math.floor(remaining / 3600) % 24).padStart(2, "0")}:${String(Math.floor(remaining / 60) % 60).padStart(2, "0")}:${String(Math.floor(remaining) % 60).padStart(2, "0")}`
                    : status === "permanent"
                      ? "永久有效"
                      : labels[status]}
                </strong>
                {time && <small>到期时间：{time}（北京时间）</small>}
              </div>
              {status !== "permanent" && (
                <>
                  <p>
                    {state.purchaseNote ||
                      "核实付款后，作者会为你的账户开通永久使用权限。"}
                  </p>
                  <div className="jvox-contact">
                    <small>作者联系方式</small>
                    <strong>
                      {state.contact ||
                        "作者尚未配置，请从软件分发渠道联系作者。"}
                    </strong>
                  </div>
                </>
              )}
              <p className="jvox-account-note">
                {status === "permanent"
                  ? "已自动转为正式版，永久有效。模型、配置和作品继续使用，无需重装。"
                  : "云端开通后，联网约一分钟内自动转为正式版，也可点击刷新授权。已有作品保存在本机。"}
              </p>
              <div className="jvox-account-actions">
                <button
                  disabled={busy}
                  className="jvox-account-primary"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const s = await window.voxcpmDesktop.refreshLicense();
                      accept(s);
                      setMessage(s.error || "授权已刷新");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "正在处理…" : "刷新授权"}
                </button>
                <button
                  disabled={busy}
                  className="jvox-account-secondary"
                  onClick={() => void logout()}
                >
                  退出登录
                </button>
              </div>
            </section>
          ) : (
            <div className="jvox-auth-layout">
              <section className="jvox-auth-story">
                <span className="jvox-account-kicker">JVOX STUDIO</span>
                <h2>
                  你的创作，
                  <br />
                  值得更多时间。
                </h2>
                <p>
                  注册即可获得一个自然月试用。推理和作品保留在本机，最后一周再提醒。
                </p>
              </section>
              <section>
                <div className="jvox-auth-tabs">
                  <button
                    className={!register ? "active" : ""}
                    onClick={() => {
                      setRegister(false);
                      setMessage("");
                    }}
                  >
                    登录
                  </button>
                  <button
                    className={register ? "active" : ""}
                    onClick={() => {
                      setRegister(true);
                      setMessage("");
                    }}
                  >
                    注册
                  </button>
                </div>
                <h2>{register ? "开始你的一个月试用。" : "欢迎回来。"}</h2>
                <form onSubmit={(e) => void submit(e)}>
                  <label>
                    <span>{register ? "用户名" : "用户名或邮箱"}</span>
                    <input
                      name="username"
                      required
                      minLength={register ? 3 : 1}
                      maxLength={80}
                      autoComplete="username"
                      placeholder={
                        register ? "3–24位字母、数字或下划线" : "输入你的账号"
                      }
                    />
                  </label>
                  {register && (
                    <>
                      <label>
                        <span>显示名称（选填）</span>
                        <input name="name" maxLength={40} />
                      </label>
                      <label>
                        <span>邮箱（选填）</span>
                        <input
                          name="email"
                          type="email"
                          maxLength={150}
                          autoComplete="email"
                        />
                      </label>
                    </>
                  )}
                  <label>
                    <span>密码</span>
                    <input
                      name="password"
                      type="password"
                      required
                      minLength={register ? 8 : 1}
                      maxLength={128}
                      autoComplete={
                        register ? "new-password" : "current-password"
                      }
                      placeholder={register ? "至少8位密码" : "输入密码"}
                    />
                  </label>
                  {register && (
                    <label>
                      <span>确认密码</span>
                      <input
                        name="confirm"
                        type="password"
                        required
                        minLength={8}
                        maxLength={128}
                        autoComplete="new-password"
                      />
                    </label>
                  )}
                  <button
                    type="submit"
                    className="jvox-account-primary"
                    disabled={busy}
                  >
                    {busy ? "正在验证…" : register ? "注册并开始试用" : "登录"}
                  </button>
                </form>
              </section>
            </div>
          )}
          {(message || state.error) && (
            <p className="jvox-account-message" role="status">
              {message || state.error}
            </p>
          )}
        </dialog>,
        document.body,
      )}
    </>
  );
}
