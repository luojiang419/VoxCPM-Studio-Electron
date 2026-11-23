import React, { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckSquare,
  Clock,
  GearSix,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SquaresFour,
} from "@phosphor-icons/react";
import { Modal } from "./App.jsx";
import { dateLabel, shanghaiDateTimeInput } from "./model.mjs";

export function Products({ state, setState, notify, changeProduct, go }) {
  const [adding, setAdding] = useState(false);
  return (
    <section>
      <div className="section-toolbar">
        <h2>
          已接入软件 <span className="count">{state.products.length}</span>
        </h2>
        <button className="primary compact" onClick={() => setAdding(true)}>
          <Plus size={18} />
          添加软件
        </button>
      </div>
      <div className="product-list">
        {state.products.map((p) => (
          <article className="product-row" key={p.id}>
            <div className="product-identity">
              <SquaresFour size={27} weight="light" />
              <div>
                <h3>{p.name}</h3>
                <span>
                  {p.subtitle} <span className="bullet">·</span>
                  <code>{p.id}</code>
                </span>
              </div>
            </div>
            <div className="product-policies">
              <span>
                试用 <strong>一个自然月</strong>
              </span>
              <label>
                设备上限
                <select
                  aria-label={p.name + " 设备上限"}
                  value={p.deviceLimit}
                  onChange={(e) => {
                    setState((s) => ({
                      ...s,
                      products: s.products.map((x) =>
                        x.id === p.id
                          ? { ...x, deviceLimit: Number(e.target.value) }
                          : x,
                      ),
                    }));
                    notify("设备策略已更新（演示）");
                  }}
                >
                  {[1, 2, 3, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} 台
                    </option>
                  ))}
                </select>
              </label>
              <span>
                授权用户{" "}
                <strong>
                  {state.licenses.filter((l) => l.appId === p.id).length} 位
                </strong>
              </span>
            </div>
            <button
              className="secondary"
              onClick={() => {
                changeProduct(p.id);
                go("用户授权");
              }}
            >
              管理授权
              <ArrowRight size={17} />
            </button>
          </article>
        ))}
      </div>
      <div className="integration-note">
        <ShieldCheck size={25} weight="light" />
        <div>
          <h3>账号统一，权限独立。</h3>
          <p>
            用户首次进入每款软件时领取该软件的试用。永久权限按软件单独开通。
          </p>
          <p className="muted">
            当前为接入流程演示，尚未签发真实密钥或连接桌面 SDK。
          </p>
        </div>
      </div>
      {adding && (
        <ProductDialog
          {...{ state, setState, notify }}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}
function ProductDialog({ state, setState, notify, onClose }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [error, setError] = useState("");
  function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setError("请输入软件名称");
    if (!/^[a-z][a-z0-9-]{2,39}$/.test(id))
      return setError("软件标识须为3–40位小写字母、数字或短横线，以字母开头");
    if (state.products.some((p) => p.id === id))
      return setError("此软件标识已存在");
    setState((s) => ({
      ...s,
      products: [
        ...s.products,
        {
          id,
          name: name.trim(),
          subtitle: subtitle.trim() || "创作工具",
          deviceLimit: 2,
          offlineHours: 72,
          enabled: true,
        },
      ],
    }));
    onClose();
    notify("软件已添加，可演示独立领取试用");
  }
  return (
    <Modal title="添加软件" onClose={onClose}>
      <form onSubmit={submit} className="dialog-form">
        <label className="field">
          <span>软件名称</span>
          <input
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：新的创作工具"
          />
        </label>
        <label className="field">
          <span>软件标识 app_id</span>
          <input
            required
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例如：creative-tool"
            maxLength={40}
          />
        </label>
        <label className="field">
          <span>
            软件简介 <small>选填</small>
          </span>
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            maxLength={40}
            placeholder="例如：影像创作"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">默认一个自然月试用，允许绑定 2 台设备。</p>
        <button className="primary" type="submit">
          添加软件
          <Plus size={18} />
        </button>
      </form>
    </Modal>
  );
}
export function Logs({ state }) {
  const [query, setQuery] = useState("");
  const rows = state.logs.filter((l) =>
    [
      l.user,
      l.actor,
      l.action,
      l.note,
      state.products.find((p) => p.id === l.appId)?.name,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section>
      <div className="section-toolbar">
        <h2>
          授权操作记录 <span className="count">{rows.length}</span>
        </h2>
        <label className="search">
          <MagnifyingGlass size={20} />
          <input
            placeholder="搜索用户、软件或收款备注"
            aria-label="搜索操作记录"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="table-scroll">
        <table className="log-table">
          <thead>
            <tr>
              {["时间", "操作", "用户 / 软件", "操作人", "备注"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>
                  {dateLabel(l.time)}
                  <small>
                    {new Intl.DateTimeFormat("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(new Date(l.time))}
                  </small>
                </td>
                <td>
                  <CheckSquare size={18} />
                  {l.action}
                </td>
                <td>
                  {l.user}
                  <small>
                    {state.products.find((p) => p.id === l.appId)?.name}
                  </small>
                </td>
                <td>{l.actor}</td>
                <td>
                  {l.note}
                  {l.before && l.after && (
                    <small>
                      {shanghaiDateTimeInput(l.before).replace("T", " ")} →{" "}
                      {shanghaiDateTimeInput(l.after).replace("T", " ")}
                    </small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <div className="empty-state">
          <Clock size={28} />
          <h3>暂无匹配记录</h3>
          <p>注册或开通永久权限后，操作会出现在这里。</p>
        </div>
      )}
    </section>
  );
}
export function Settings({ state, setState, notify }) {
  const [name, setName] = useState(state.settings.adminName);
  const [contact, setContact] = useState(state.settings.contact);
  const [purchaseNote, setPurchaseNote] = useState(state.settings.purchaseNote);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="settings-layout">
      <div className="settings-intro">
        <GearSix size={30} weight="light" />
        <h2>账户与购买引导</h2>
        <p>设置作者联系方式和购买说明，用户端会同步展示。</p>
        <span className="demo-badge">本地方案演示</span>
      </div>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !purchaseNote.trim()) return;
          setState((s) => ({
            ...s,
            settings: {
              ...s.settings,
              adminName: name.trim(),
              contact: contact.trim(),
              purchaseNote: purchaseNote.trim(),
            },
          }));
          notify("设置已保存，客户端已同步");
        }}
      >
        <h3>基础设置</h3>
        <label className="field">
          <span>管理员显示名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={30}
          />
        </label>
        <label className="field">
          <span>作者联系方式</span>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={100}
            placeholder="填写微信、QQ或其他联系渠道"
          />
        </label>
        <label className="field">
          <span>购买说明</span>
          <textarea
            value={purchaseNote}
            onChange={(e) => setPurchaseNote(e.target.value)}
            required
            rows={3}
            maxLength={300}
          />
        </label>
        <button className="primary" type="submit">
          保存设置
          <Check size={18} />
        </button>
      </form>
      <form
        className="settings-form password-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length < 8) return setError("演示密码至少8位");
          if (password !== confirm) return setError("两次输入不一致");
          setPassword("");
          setConfirm("");
          setError("");
          notify("密码修改流程演示完成，未保存或修改真实凭据");
        }}
      >
        <h3>修改登录密码</h3>
        <p className="muted">
          用于查看修改流程，请勿输入真实密码。生产管理员账号将在部署时初始化。
        </p>
        <label className="field">
          <span>新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入演示密码，至少8位"
          />
        </label>
        <label className="field">
          <span>确认新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再次输入演示密码"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="secondary" type="submit">
          演示修改密码
          <ArrowRight size={18} />
        </button>
      </form>
    </div>
  );
}
