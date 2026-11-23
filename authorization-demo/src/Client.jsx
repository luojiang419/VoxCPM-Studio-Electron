import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  Desktop,
  Key,
  ShieldCheck,
  SignIn,
  User,
  UserPlus,
} from "@phosphor-icons/react";
import { Avatar, Status } from "./App.jsx";
import {
  DEMO_NOW,
  DAY,
  addCalendarMonth,
  claimTrial,
  dateLabel,
  daysLeft,
  getLicense,
  licenseStatus,
  registerUser,
} from "./model.mjs";

export function Client({
  state,
  setState,
  view,
  go,
  appId,
  product,
  changeProduct,
  clientUser,
  setClientUser,
  scenario,
  setScenario,
  notify,
  setModal,
  setSelected,
}) {
  const user = state.users.find((u) => u.id === clientUser) || state.users[0];
  const actual = getLicense(state, user.id, appId);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setElapsed((e) => e + 1000), 1000);
    return () => clearInterval(interval);
  }, []);
  const now = new Date(new Date(DEMO_NOW).getTime() + elapsed).toISOString();
  const fake = {
    userId: user.id,
    appId,
    number: "DEMO-••••-PREVIEW",
    devices: 1,
    kind: "trial",
    startsAt: DEMO_NOW,
    expiresAt: addCalendarMonth(DEMO_NOW),
  };
  const current =
    scenario === "normal"
      ? fake
      : scenario === "week"
        ? {
            ...fake,
            startsAt: "2026-10-01T00:00:00+08:00",
            expiresAt: new Date(
              new Date(DEMO_NOW).getTime() + 7 * DAY,
            ).toISOString(),
          }
        : scenario === "expired"
          ? {
              ...fake,
              startsAt: "2026-09-25T00:00:00+08:00",
              expiresAt: DEMO_NOW,
            }
          : scenario === "permanent"
            ? { ...fake, kind: "permanent", expiresAt: null }
            : actual;
  const status = licenseStatus(current, now);
  const remaining = current?.expiresAt
    ? Math.max(
        0,
        new Date(current.expiresAt).getTime() - new Date(now).getTime(),
      )
    : 0;
  const hours = Math.floor(remaining / 3600000) % 24,
    minutes = Math.floor(remaining / 60000) % 60,
    seconds = Math.floor(remaining / 1000) % 60;
  const scenarios = [
    ["actual", "账户实际状态"],
    ["normal", "正常试用"],
    ["week", "最后一周"],
    ["expired", "试用到期"],
    ["permanent", "永久授权"],
  ];
  return (
    <main className="client-main">
      <div className="client-toolbar">
        <button className="text-button" onClick={() => go("用户授权")}>
          <ArrowLeft size={17} />
          返回管理后台
        </button>
        <span className="demo-badge">客户端交互演示</span>
      </div>
      {view !== "客户端演示" ? (
        <AuthForm
          key={view}
          {...{
            state,
            setState,
            view,
            go,
            appId,
            product,
            changeProduct,
            setClientUser,
            setSelected,
            setScenario,
            notify,
          }}
        />
      ) : (
        <>
          <div className="client-demo-controls">
            <label>
              当前软件
              <select
                aria-label="客户端当前软件"
                value={appId}
                onChange={(e) => changeProduct(e.target.value)}
              >
                {state.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              演示用户
              <select
                aria-label="客户端演示用户"
                value={user.id}
                onChange={(e) => {
                  setClientUser(e.target.value);
                  setScenario("actual");
                }}
              >
                {state.users.map((u) => (
                  <option value={u.id} key={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="text-button" onClick={() => go("注册")}>
              <UserPlus size={17} />
              体验注册
            </button>
            <button className="text-button" onClick={() => go("登录")}>
              <SignIn size={17} />
              体验登录
            </button>
          </div>
          <div className="client-shell">
            <aside className="client-sidebar">
              <div className="client-brand">
                {product.name}
                <span>{product.subtitle}</span>
              </div>
              <div className="client-nav">
                <span>
                  <Desktop size={19} />
                  创作工作台
                </span>
                <span className="active">
                  <User size={19} />
                  账户与授权
                </span>
              </div>
              <div className="sidebar-account">
                <Avatar user={user} />
                <span>
                  {user.name}
                  <small>
                    {status === "permanent"
                      ? "永久使用权限"
                      : status === "trial"
                        ? "试用剩余 " + daysLeft(current, now) + " 天"
                        : status === "none"
                          ? "尚未领取试用"
                          : "试用已结束"}
                  </small>
                </span>
              </div>
            </aside>
            <section className="client-content">
              <div className="client-page-heading">
                <span className="section-label">YOUR ACCOUNT</span>
                <Status license={current} now={now} />
              </div>
              <h1>把时间，留给创作。</h1>
              <p className="client-subtitle">
                {status === "permanent"
                  ? "感谢你的支持，继续创造更多好作品。"
                  : "你的账号、设备与使用权限，都在这里。"}
              </p>
              <div className="account-summary">
                <Avatar user={user} large />
                <div>
                  <h2>{user.name}</h2>
                  <p>
                    {user.id} <span className="bullet">·</span>
                    {user.email || user.username}
                  </p>
                </div>
                <span className="account-verified">
                  <ShieldCheck size={17} />
                  {scenario === "actual" ? "账户状态演示" : "预览状态"}
                </span>
              </div>
              {status === "none" ? (
                <div className="client-license-block">
                  <Key size={32} weight="light" />
                  <h2>为 {product.name} 领取试用</h2>
                  <p>
                    此账号尚未试用这款软件。领取后立即开始一个自然月的试用。
                  </p>
                  <button
                    className="primary"
                    onClick={() => {
                      setState((s) => claimTrial(s, user.id, appId));
                      notify("已领取该软件一个月试用，其他软件授权不变");
                    }}
                  >
                    领取一个月试用
                    <ArrowRight size={18} />
                  </button>
                </div>
              ) : (
                <div className={"client-license-block " + status}>
                  <span className="section-label">
                    {status === "permanent"
                      ? "LIFETIME ACCESS"
                      : status === "expired"
                        ? "TRIAL ENDED"
                        : "YOUR CREATIVE TIME"}
                  </span>
                  <h2>
                    {status === "permanent"
                      ? "永久使用权限，已为你开启。"
                      : status === "expired"
                        ? "试用已结束，作品始终属于你。"
                        : "一个月，尽情探索。"}
                  </h2>
                  {status === "trial" && (
                    <>
                      <div className="countdown" aria-label="试用剩余时间">
                        {[
                          [Math.floor(remaining / DAY), "天"],
                          [hours, "时"],
                          [minutes, "分"],
                          [seconds, "秒"],
                        ].map(([number, unit], index) => (
                          <React.Fragment key={unit}>
                            {index > 0 && <b>:</b>}
                            <span>
                              <strong>{String(number).padStart(2, "0")}</strong>
                              <small>{unit}</small>
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                      <p className="expires-label">
                        试用至 {dateLabel(current.expiresAt)} ·
                        到期前一周，每天首次使用时提醒
                      </p>
                    </>
                  )}
                  {status === "permanent" && (
                    <div className="permanent-message">
                      <CheckCircle size={36} weight="light" />
                      <span>
                        无试用期限限制<small>仅对 {product.name} 生效</small>
                      </span>
                    </div>
                  )}
                  {status === "expired" && (
                    <p className="expired-message">
                      新增生成任务已暂停。已有作品仍可查看、播放和导出。
                    </p>
                  )}
                  <div className="client-license-meta">
                    <div>
                      <small>当前软件</small>
                      <strong>{product.name}</strong>
                    </div>
                    <div>
                      <small>授权编号</small>
                      <strong className="monospace">{current.number}</strong>
                    </div>
                    <div>
                      <small>绑定设备</small>
                      <strong>
                        {current.devices} / {product.deviceLimit} 台
                      </strong>
                    </div>
                  </div>
                  <div className="client-license-actions">
                    {status !== "permanent" && (
                      <button
                        className="primary"
                        onClick={() => setModal("contact")}
                      >
                        联系作者，开通永久权限
                        <ArrowUpRight size={18} />
                      </button>
                    )}
                    <button
                      className={
                        status === "permanent" ? "primary" : "secondary"
                      }
                      disabled={status === "expired"}
                      onClick={() =>
                        notify("授权有效，正式接入后可进入创作工作台")
                      }
                    >
                      继续创作
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              )}
              <div className="client-footnote">
                <ShieldCheck size={18} />
                <p>
                  本页展示授权交互流程。正式版将在本地完成推理，作品保存在你的设备上。
                </p>
              </div>
            </section>
          </div>
          <div className="scenario-toolbar">
            <span>
              <Clock size={17} />
              状态预览
            </span>
            <div>
              {scenarios.map(([id, label]) => (
                <button
                  key={id}
                  className={scenario === id ? "active" : ""}
                  aria-pressed={scenario === id}
                  onClick={() => {
                    setScenario(id);
                    setElapsed(0);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {scenario === "week" && (
              <button
                className="text-button"
                onClick={() => setModal("reminder")}
              >
                预览到期提醒
                <ArrowUpRight size={15} />
              </button>
            )}
          </div>
          <p className="demo-explanation">
            状态预览不会修改账户授权。演示数据仅保存在此浏览器，不构成真实认证。
          </p>
        </>
      )}
    </main>
  );
}

function AuthForm({
  state,
  setState,
  view,
  go,
  appId,
  product,
  changeProduct,
  setClientUser,
  setSelected,
  setScenario,
  notify,
}) {
  const register = view === "注册",
    admin = view === "管理员登录";
  const [username, setUsername] = useState(""),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState("");
  function submit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("请使用至少8位的演示密码");
    if (register && password !== confirm) return setError("两次密码输入不一致");
    if (admin) {
      setPassword("");
      go("用户授权");
      return notify("已进入管理员界面演示，未执行真实身份认证");
    }
    try {
      let next = state,
        user;
      if (register) {
        next = registerUser(state, { username, name, email }, appId);
        user = next.users.at(-1);
      } else {
        user = state.users.find(
          (u) =>
            u.username.toLowerCase() === username.trim().toLowerCase() ||
            u.email?.toLowerCase() === username.trim().toLowerCase(),
        );
        if (!user)
          return setError("未找到这个演示账户，请先注册，或使用示例用户名 lin");
        next = claimTrial(state, user.id, appId);
      }
      setState(next);
      setClientUser(user.id);
      setSelected(user.id);
      setScenario("actual");
      setPassword("");
      setConfirm("");
      go("客户端演示");
      notify(
        register
          ? "注册成功，已创建一个自然月试用"
          : "已进入演示账户，试用期限不会重置",
      );
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <span className="section-label">
          {admin
            ? "EE2X / AUTH CENTER"
            : product.name.toUpperCase() + " / ACCOUNT"}
        </span>
        <h1>
          {admin ? (
            <>
              每一份授权，
              <br />
              都有迹可循。
            </>
          ) : (
            <>
              你的创作，
              <br />
              值得更多时间。
            </>
          )}
        </h1>
        <p>
          {admin
            ? "从用户注册到永久开通，在一个工作台中掌握每一款软件的授权。"
            : "一个账号，连接你的创作工具。注册即可获得一个自然月试用，开启属于你的创作节奏。"}
        </p>
        <div className="auth-benefits">
          <div>
            <CheckCircle size={20} />
            {admin ? "多款软件，独立授权" : "注册自动领取试用"}
          </div>
          <div>
            <ShieldCheck size={20} />
            {admin ? "每一次开通均可追溯" : "推理与作品保留在本地"}
          </div>
          <div>
            <Clock size={20} />
            {admin ? "试用到期提醒自动完成" : "最后一周再提醒，专注不打断"}
          </div>
        </div>
        <footer>
          EE2X <span>/</span> 创作，自有时间。
        </footer>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-tabs">
          {admin ? (
            <span>管理员登录</span>
          ) : (
            <>
              <button
                className={!register ? "active" : ""}
                onClick={() => go("登录")}
              >
                登录
              </button>
              <button
                className={register ? "active" : ""}
                onClick={() => go("注册")}
              >
                注册
              </button>
            </>
          )}
        </div>
        <h2>
          {admin
            ? "欢迎回来，作者。"
            : register
              ? "开始你的一个月试用。"
              : "欢迎回来。"}
        </h2>
        <p>
          {admin
            ? "查看管理页登录流程。"
            : register
              ? "创建账号后，试用授权会自动准备好。"
              : "使用已有账户进入，试用期限不会重新计算。"}
        </p>
        <form className="auth-form" onSubmit={submit}>
          {!admin && (
            <label className="field">
              <span>使用软件</span>
              <select
                aria-label="注册或登录的软件"
                value={appId}
                onChange={(e) => changeProduct(e.target.value)}
              >
                {state.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{admin || register ? "用户名" : "用户名或邮箱"}</span>
            <input
              autoComplete="off"
              required
              maxLength={80}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={
                admin
                  ? "管理员用户名"
                  : register
                    ? "3–24位字母、数字或下划线"
                    : "例如：lin"
              }
            />
          </label>
          {register && (
            <>
              <label className="field">
                <span>
                  显示名称 <small>选填</small>
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={30}
                  placeholder="希望如何称呼你"
                />
              </label>
              <label className="field">
                <span>
                  邮箱 <small>选填</small>
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={100}
                  placeholder="name@example.com"
                />
              </label>
            </>
          )}
          <label className="field">
            <span>演示密码</span>
            <input
              type="password"
              autoComplete="off"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少8位，请勿输入真实密码"
            />
          </label>
          {register && (
            <label className="field">
              <span>确认演示密码</span>
              <input
                type="password"
                autoComplete="off"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入演示密码"
              />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" type="submit">
            {admin
              ? "进入管理页演示"
              : register
                ? "注册并开始试用"
                : "进入账户演示"}
            <ArrowRight size={19} />
          </button>
          <p className="auth-demo-note">
            本地演示仅校验表单，不验证密码；密码不会保存。正式认证将在生产服务接入后启用。
          </p>
        </form>
      </section>
    </div>
  );
}
