import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  MagnifyingGlass,
  ShieldCheck,
  User,
} from "@phosphor-icons/react";
import { Avatar, Status } from "./App.jsx";
import {
  DEMO_NOW,
  dateLabel,
  daysLeft,
  getLicense,
  licenseStatus,
} from "./model.mjs";
import { Products, Logs, Settings } from "./Management.jsx";

export function Admin(props) {
  const {
    state,
    view,
    go,
    appId,
    product,
    changeProduct,
    selected,
    setSelected,
    received,
    setReceived,
    note,
    setNote,
    setModal,
    setClientUser,
    setScenario,
  } = props;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    setSearch("");
    setFilter("all");
  }, [appId]);
  const user = state.users.find((u) => u.id === selected);
  const license = getLicense(state, selected, appId);
  const rows = state.users.filter((u) => {
    const l = getLicense(state, u.id, appId);
    return (
      l &&
      (filter === "all" || licenseStatus(l) === filter) &&
      [u.name, u.id, u.username, u.email, l.number]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  function showClient() {
    setClientUser(selected);
    setScenario("actual");
    go("客户端演示");
  }
  const duration = license?.expiresAt
    ? Math.max(
        1,
        (new Date(license.expiresAt) - new Date(license.startsAt)) / 86400000,
      )
    : 1;
  const progress =
    license?.kind === "permanent"
      ? 100
      : Math.max(
          0,
          Math.min(100, Math.round((1 - daysLeft(license) / duration) * 100)),
        );
  return (
    <main className="admin-main">
      <div className="eyebrow-row">
        <span>
          统一授权中心 <span className="demo-badge">演示数据</span>
        </span>
        <span className="demo-clock">
          2026-10-25&nbsp; 星期日 <span className="zone">/ Asia/Shanghai</span>
        </span>
      </div>
      <div className="page-intro">
        <h1>{view}</h1>
        <p>
          {
            {
              用户授权: "让每一次开通，都有迹可循。",
              软件接入: "一个账号，连接你的每一款软件。",
              操作记录: "每一次授权变更，都有据可查。",
              设置: "把规则设好，让授权自然发生。",
            }[view]
          }
        </p>
      </div>
      {view === "用户授权" && (
        <div className="authorization-layout">
          <section className="user-list" aria-label="用户授权列表">
            <div className="list-toolbar">
              <label className="software-picker">
                <span>选择软件</span>
                <select
                  aria-label="选择软件"
                  value={appId}
                  onChange={(e) => changeProduct(e.target.value)}
                >
                  {state.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.subtitle}
                    </option>
                  ))}
                </select>
              </label>
              <label className="search">
                <MagnifyingGlass size={21} />
                <input
                  aria-label="搜索用户"
                  placeholder="搜索用户名、授权编号"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            <div className="table-scroll">
              <table className="user-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">选中</span>
                    </th>
                    <th scope="col">用户</th>
                    <th scope="col">
                      <select
                        className="filter-select"
                        aria-label="筛选授权状态"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">授权</option>
                        <option value="trial">试用中</option>
                        <option value="permanent">永久授权</option>
                        <option value="expired">已过期</option>
                      </select>
                    </th>
                    <th scope="col">到期时间</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const l = getLicense(state, u.id, appId);
                    const s = licenseStatus(l);
                    return (
                      <tr
                        key={u.id}
                        className={selected === u.id ? "selected-row" : ""}
                        onClick={() => setSelected(u.id)}
                      >
                        <td>
                          <input
                            type="radio"
                            name="user"
                            aria-label={"选择用户 " + u.name}
                            checked={selected === u.id}
                            onChange={() => setSelected(u.id)}
                          />
                        </td>
                        <td>
                          <button
                            className="user-cell"
                            onClick={() => setSelected(u.id)}
                          >
                            <Avatar user={u} />
                            <span>
                              <strong>{u.name}</strong>
                              <small>
                                {u.id}
                                <span className="bullet">·</span>
                                {u.email}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td>
                          <Status license={l} />
                        </td>
                        <td className="expiry">
                          <span>
                            {s === "permanent"
                              ? "永久有效"
                              : dateLabel(l.expiresAt)}
                          </span>
                          <small>
                            {s === "permanent"
                              ? "—"
                              : s === "expired"
                                ? "已过期 " +
                                  Math.floor(
                                    (new Date(DEMO_NOW) -
                                      new Date(l.expiresAt)) /
                                      86400000,
                                  ) +
                                  " 天"
                                : daysLeft(l) + " 天后到期"}
                          </small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <div className="empty-state">
                <MagnifyingGlass size={28} />
                <h3>没有找到匹配用户</h3>
                <p>试试其他名称，或调整授权状态。</p>
                <button
                  className="text-button"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  清除筛选
                </button>
              </div>
            )}
            <footer className="list-footer">
              <span>
                共 {rows.length} 位用户 <span className="bullet">|</span> 已选择{" "}
                {user && license ? "1" : "0"} 位
              </span>
              <button className="text-button" onClick={showClient}>
                查看用户端
                <ArrowUpRight size={14} />
              </button>
            </footer>
          </section>
          <aside className="inspector" aria-label="选中用户授权详情">
            {user && license ? (
              <>
                <div className="inspector-title">
                  <h2>{user.name}</h2>
                  <span className="demo-badge">演示数据</span>
                </div>
                <p className="product-caption">
                  {product.name} · {product.subtitle}
                </p>
                <dl className="status-description">
                  <dt>授权状态</dt>
                  <dd>
                    <Status license={license} />
                  </dd>
                  {license.kind !== "permanent" && (
                    <dd className="trial-adjust-action">
                      <button
                        className="text-button"
                        onClick={() => setModal("adjust-trial")}
                      >
                        调整试用期限
                        <ArrowUpRight size={14} />
                      </button>
                    </dd>
                  )}
                </dl>
                <div className="remaining-block">
                  <div className="remaining">
                    <span>
                      {license.kind === "permanent"
                        ? "使用期限"
                        : licenseStatus(license) === "expired"
                          ? "试用已结束"
                          : "试用剩余"}
                    </span>
                    <strong>
                      {license.kind === "permanent" ? (
                        "永久有效"
                      ) : (
                        <>
                          {String(daysLeft(license)).padStart(2, "0")}
                          <small>天</small>
                        </>
                      )}
                    </strong>
                  </div>
                  <div className="device-summary">
                    <small>设备使用</small>
                    <strong>
                      {license.devices} / {product.deviceLimit}{" "}
                      <small>台</small>
                    </strong>
                  </div>
                </div>
                <div
                  className="trial-progress"
                  role="progressbar"
                  aria-label="授权期限进度"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: progress + "%" }} />
                </div>
                <div className="timeline-labels">
                  <span>{dateLabel(license.startsAt, ".")}</span>
                  <span>
                    {license.kind === "permanent"
                      ? "永久有效"
                      : dateLabel(license.expiresAt, ".")}
                  </span>
                </div>
                <div className="license-facts">
                  <div>
                    <small>授权编号</small>
                    <span className="monospace">{license.number}</span>
                  </div>
                  <div>
                    <small>授权类型</small>
                    <span>
                      {license.kind === "permanent" ? "永久授权" : "试用授权"}
                    </span>
                  </div>
                  <div>
                    <small>开通时间</small>
                    <span>
                      {dateLabel(license.grantedAt || license.startsAt)}
                    </span>
                  </div>
                </div>
                <div className="activation-section">
                  {license.kind === "permanent" ? (
                    <div className="activated">
                      <CheckCircle size={32} weight="light" />
                      <h3>永久权限已开通</h3>
                      <p>此用户已获得 {product.name} 永久使用权限。</p>
                      <button className="primary" onClick={showClient}>
                        查看用户端效果
                        <ArrowRight size={18} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <h3>开通永久使用权限</h3>
                      <p>
                        请确认该用户已完成付款，核实后为其开通永久使用权限。
                      </p>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={received}
                          onChange={(e) => setReceived(e.target.checked)}
                        />
                        已核实该用户付款
                      </label>
                      <label className="field">
                        <span>
                          收款备注 <small>选填</small>
                        </span>
                        <textarea
                          value={note}
                          maxLength={200}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="例如：订单号、付款方式、交易备注等…"
                          rows={2}
                        />
                      </label>
                      <button
                        className="primary"
                        disabled={!received}
                        onClick={() => setModal("activate")}
                      >
                        确认开通永久授权
                        <ArrowUpRight size={18} />
                      </button>
                    </>
                  )}
                  <button
                    className="record-link"
                    onClick={() => go("操作记录")}
                  >
                    <Clock size={18} />
                    查看操作记录
                    <ArrowRight size={16} />
                  </button>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <User size={30} />
                <h3>请选择一个用户</h3>
                <p>用户领取该软件的试用后，会出现在列表中。</p>
                <button className="secondary" onClick={() => go("注册")}>
                  演示注册
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
      {view === "软件接入" && <Products {...props} />}
      {view === "操作记录" && <Logs state={state} />}
      {view === "设置" && <Settings {...props} />}
      <footer className="app-footer">
        <span>
          <ShieldCheck size={15} />
          本地方案演示 · 未连接生产认证服务
        </span>
        <button className="text-button" onClick={() => setModal("reset")}>
          重置演示
        </button>
      </footer>
    </main>
  );
}
